import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelClient } from '../src/agent.js';
import { createPool, migrate } from '../src/db.js';
import { claim, enqueue, finish } from '../src/jobs.js';
import { processNext, retryDelay, type WorkerDeps } from '../src/runs.js';
import { SEED_END, seed } from '../src/seed.js';

const pool = createPool();
const logger = pino({ level: 'silent' });

beforeEach(async () => {
  await migrate(pool);
  await seed(pool);
});
afterAll(() => pool.end());

const answer = (text: string): BetaMessage =>
  ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as BetaMessage;

const deps = (client: ModelClient, workerId = 'w1', leaseMs = 60_000): WorkerDeps => ({
  pool,
  client,
  workerId,
  logger,
  leaseMs,
  asOf: () => SEED_END,
});

async function job(id: string) {
  return (await pool.query('SELECT * FROM agent_jobs WHERE id = $1', [id])).rows[0];
}

describe('agent job queue', () => {
  it('runs a queued job and stores the answer and transcript', async () => {
    const { jobId, runId } = await enqueue(pool, { accountId: 'acc_moda', message: 'Merhaba' });
    expect(await processNext(deps(async () => answer('Selam!')))).toBe('done');

    const j = await job(jobId);
    expect(j.status).toBe('done');
    expect(j.result.answer).toBe('Selam!');
    const run = (await pool.query('SELECT messages FROM agent_runs WHERE id = $1', [runId])).rows[0];
    expect(run.messages).toHaveLength(2);
  });

  it('returns the same job for a repeated Idempotency-Key', async () => {
    const a = await enqueue(pool, { accountId: 'acc_moda', message: 'x', idempotencyKey: 'req-1' });
    const b = await enqueue(pool, { accountId: 'acc_moda', message: 'x', idempotencyKey: 'req-1' });
    expect(b).toEqual({ ...a, created: false });
  });

  it('never gives one job to two workers', async () => {
    for (let i = 0; i < 20; i++) await enqueue(pool, { accountId: 'acc_moda', message: `q${i}` });
    const claimed = await Promise.all(Array.from({ length: 30 }, (_, i) => claim(pool, `w${i}`, 60_000)));
    const ids = claimed.filter((j) => j !== null).map((j) => j?.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('runs the turns of one conversation one at a time, in order', async () => {
    const first = await enqueue(pool, { accountId: 'acc_moda', message: 'first' });
    const second = await enqueue(pool, { accountId: 'acc_moda', message: 'second', runId: first.runId });

    const a = await claim(pool, 'w1', 60_000);
    expect(a?.id).toBe(first.jobId);
    expect(await claim(pool, 'w2', 60_000)).toBeNull(); // second waits for first

    expect(await finish(pool, first.jobId, 'w1', { answer: 'ok' }, async () => {})).toBe(true);
    expect((await claim(pool, 'w2', 60_000))?.id).toBe(second.jobId);
  });

  it('hands an expired lease to another worker and fences off the old one', async () => {
    const { jobId } = await enqueue(pool, { accountId: 'acc_moda', message: 'slow' });
    const stale = await claim(pool, 'crashed', 1); // lease of 1 ms: as if the worker died
    await new Promise((r) => setTimeout(r, 20));

    expect(await processNext(deps(async () => answer('done by survivor'), 'survivor'))).toBe('done');
    // The original worker wakes up and tries to commit its result: rejected.
    expect(await finish(pool, stale?.id as string, 'crashed', { answer: 'stale' }, async () => {})).toBe(false);
    const j = await job(jobId);
    expect(j.result.answer).toBe('done by survivor');
    expect(j.attempts).toBe(2);
  });

  it('re-queues on 429 honouring Retry-After, then succeeds', async () => {
    const { jobId } = await enqueue(pool, { accountId: 'acc_moda', message: 'x' });
    const limited = new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers({ 'retry-after': '1' }));
    expect(await processNext(deps(async () => Promise.reject(limited)))).toBe('queued');

    const waiting = await job(jobId);
    expect(waiting.status).toBe('queued');
    expect(new Date(waiting.available_at).getTime()).toBeGreaterThan(Date.now() + 500);
    expect(await processNext(deps(async () => answer('later')))).toBeNull(); // not due yet

    await pool.query('UPDATE agent_jobs SET available_at = now() WHERE id = $1', [jobId]);
    expect(await processNext(deps(async () => answer('later')))).toBe('done');
  });

  it('fails at once on a 400 and after max attempts on repeated 529s', async () => {
    const bad = await enqueue(pool, { accountId: 'acc_moda', message: 'x' });
    const badRequest = new Anthropic.BadRequestError(400, undefined, 'invalid request', new Headers());
    expect(await processNext(deps(async () => Promise.reject(badRequest)))).toBe('failed');
    expect((await job(bad.jobId)).attempts).toBe(1);

    const busy = await enqueue(pool, { accountId: 'acc_moda', message: 'y' });
    const overloaded = new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers());
    for (let i = 0; i < 4; i++) {
      await pool.query('UPDATE agent_jobs SET available_at = now() WHERE id = $1', [busy.jobId]);
      await processNext(deps(async () => Promise.reject(overloaded)));
    }
    expect((await job(busy.jobId)).status).toBe('failed');
  });

  it('classifies errors for retry', () => {
    const h = new Headers();
    expect(retryDelay(new Anthropic.BadRequestError(400, undefined, 'x', h), 1)).toBeNull();
    expect(retryDelay(new Anthropic.AuthenticationError(401, undefined, 'x', h), 1)).toBeNull();
    expect(retryDelay(new Anthropic.RateLimitError(429, undefined, 'x', new Headers({ 'retry-after': '7' })), 1)).toBe(
      7000,
    );
    expect(retryDelay(new Anthropic.InternalServerError(529, undefined, 'x', h), 3)).toBeLessThanOrEqual(16_000);
    expect(retryDelay(new Error('ECONNRESET'), 1)).not.toBeNull();
  });
});
