import { hostname } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import type { ModelClient } from './agent.js';
import { createPool, migrate } from './db.js';
import { DEMO_MODEL, demoModel } from './demo-model.js';
import { workLoop } from './runs.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const pool = createPool();
await migrate(pool);

// The SDK retries 429/5xx/connection errors twice within a request; longer outages are
// handled by re-queueing the job with a delay (see retryDelay).
// AGENT_MODEL=demo swaps in a scripted stand-in so the pipeline runs without an API key.
const demo = process.env.AGENT_MODEL === DEMO_MODEL;
const anthropic = demo ? null : new Anthropic({ maxRetries: 2, timeout: 5 * 60_000 });
const client: ModelClient = demo ? demoModel : (params) => (anthropic as Anthropic).beta.messages.create(params);
if (demo) logger.warn('AGENT_MODEL=demo: using the scripted demo model, not Claude');

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
const controller = new AbortController();
const deps = {
  pool,
  client,
  logger,
  asOf: () => process.env.AS_OF_DATE ?? new Date().toISOString().slice(0, 10),
};
const loops = Array.from({ length: concurrency }, (_, i) =>
  workLoop({ ...deps, workerId: `${hostname()}-${process.pid}-${i}` }, controller.signal),
);
logger.info({ concurrency }, 'agent worker started');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    // Finish the runs in progress; anything cut off is reclaimed when its lease expires.
    logger.info({ sig }, 'draining');
    controller.abort();
    await Promise.allSettled(loops);
    await pool.end();
    process.exit(0);
  });
}
