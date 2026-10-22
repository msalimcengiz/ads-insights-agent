import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import type pg from 'pg';
import type { Logger } from 'pino';
import { type AgentConfig, type ModelClient, runAgent } from './agent.js';
import { claim, finish, heartbeat, type JobStatus, retryOrFail } from './jobs.js';
import type { UsageTotals } from './pricing.js';
import { ALL_TOOLS } from './tools/index.js';

export interface WorkerDeps {
  pool: pg.Pool;
  client: ModelClient;
  workerId: string;
  asOf: () => string;
  logger: Logger;
  leaseMs?: number;
  config?: Partial<AgentConfig>;
}

/**
 * How to react to a failed model call:
 * - 429 rate limit, 5xx (529 overloaded included), connection errors: transient. Retry
 *   later, honouring Retry-After when the API sends it.
 * - Other 4xx (bad request, auth, permission): retrying the same request cannot help.
 * - Anything else (database blip in a tool, bug): retry; max_attempts bounds it.
 */
export function retryDelay(err: unknown, attempt: number): number | null {
  if (err instanceof Anthropic.APIError && err.status !== undefined && err.status >= 400 && err.status < 500) {
    if (err.status !== 408 && err.status !== 409 && err.status !== 429) return null;
  }
  const retryAfter = err instanceof Anthropic.APIError ? Number(err.headers?.get('retry-after')) : Number.NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return Math.random() * Math.min(60_000, 2_000 * 2 ** attempt); // full jitter
}

/** Claims and runs one job. Returns its final status, or null if there was nothing to do. */
export async function processNext(d: WorkerDeps): Promise<JobStatus | null> {
  const leaseMs = d.leaseMs ?? 120_000;
  const job = await claim(d.pool, d.workerId, leaseMs);
  if (!job) return null;
  const log = d.logger.child({ jobId: job.id, runId: job.run_id, attempt: job.attempts });

  // Keep the lease alive while the model works; a long run must not look like a dead worker.
  const beat = setInterval(() => {
    heartbeat(d.pool, job.id, d.workerId, leaseMs).catch((err) => log.warn({ err }, 'heartbeat failed'));
  }, leaseMs / 3);
  try {
    const { rows } = await d.pool.query<{ messages: BetaMessageParam[]; usage: UsageTotals }>(
      'SELECT messages, usage FROM agent_runs WHERE id = $1',
      [job.run_id],
    );
    const prior = rows[0];
    if (!prior) throw new Error('run disappeared');

    const result = await runAgent({
      client: d.client,
      tools: ALL_TOOLS,
      ctx: { pool: d.pool, accountId: job.account_id, runId: job.run_id, asOf: d.asOf() },
      history: prior.messages,
      userMessage: job.message,
      config: d.config,
    });
    const totals = addTotals(prior.usage, result.usage);
    const summary = {
      answer: result.answer,
      stop: result.stop,
      tool_calls: result.toolCalls,
      usage: { this_turn: result.usage, conversation: totals },
      iterations: result.iterations,
      ms: result.ms,
    };
    const committed = await finish(d.pool, job.id, d.workerId, summary, async (tx) => {
      await tx.query('UPDATE agent_runs SET messages = $2, usage = $3, updated_at = now() WHERE id = $1', [
        job.run_id,
        JSON.stringify(result.messages),
        totals,
      ]);
    });
    if (!committed) {
      log.warn('lease lost before finishing; the worker that took over owns the result');
      return 'running';
    }
    log.info({ stop: result.stop, costUsd: result.usage.cost_usd, ms: result.ms }, 'run finished');
    return 'done';
  } catch (err) {
    const delay = retryDelay(err, job.attempts);
    const status = await retryOrFail(d.pool, job, d.workerId, String(err), delay);
    log.warn({ err: String(err), status, retryInMs: delay }, 'run failed');
    return status;
  } finally {
    clearInterval(beat);
  }
}

/** Polls for work until `signal` aborts. Several workers can run side by side. */
export async function workLoop(d: WorkerDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let status: JobStatus | null = null;
    try {
      status = await processNext(d);
    } catch (err) {
      d.logger.error({ err }, 'worker loop error');
    }
    if (status === null) await new Promise((r) => setTimeout(r, 500));
  }
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    requests: a.requests + b.requests,
    cost_usd: a.cost_usd + b.cost_usd,
    models: [...new Set([...a.models, ...b.models])],
  };
}
