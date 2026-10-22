import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { pino } from 'pino';
import { z } from 'zod';
import { ActionError, decideAction } from './actions.js';
import { createPool, migrate } from './db.js';
import { enqueue, JobError } from './jobs.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const pool = createPool();
await migrate(pool);

type Env = { Variables: { accountId: string } };
const app = new Hono<Env>();

// Demo auth: the account comes from a header. In production this is resolved from the
// session or API key; tools receive it from here and never from model output.
app.use('/v1/*', async (c, next) => {
  const id = c.req.header('x-account-id');
  const { rows } = id ? await pool.query('SELECT 1 FROM accounts WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) return c.json({ error: 'unknown account' }, 401);
  c.set('accountId', id as string);
  await next();
});

const ask = z.object({ message: z.string().min(1).max(4000) });

// The SDK resolves credentials from these (or an `ant auth login` profile, absent in containers).
const modelConfigured =
  process.env.AGENT_MODEL === 'demo' ||
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'].some((k) => process.env[k]);
if (!modelConfigured) logger.warn('no Anthropic credentials set; /v1/runs will return 503');
// (workers need the credentials; the API refuses to queue work nobody can run)
app.use('/v1/runs/*', async (c, next) => {
  if (!modelConfigured) return c.json({ error: 'model not configured: set ANTHROPIC_API_KEY' }, 503);
  await next();
});
app.use('/v1/runs', async (c, next) => {
  if (!modelConfigured) return c.json({ error: 'model not configured: set ANTHROPIC_API_KEY' }, 503);
  await next();
});

// Runs are queued and executed by workers (src/worker.ts); a run makes several model
// calls and can take a minute. Clients poll the job, optionally long-polling with ?wait=.
app.post('/v1/runs', zValidator('json', ask), async (c) => {
  const job = await enqueue(pool, {
    accountId: c.get('accountId'),
    message: c.req.valid('json').message,
    idempotencyKey: c.req.header('Idempotency-Key'),
  });
  return c.json({ run_id: job.runId, job_id: job.jobId, status: 'queued' }, job.created ? 202 : 200);
});

app.post('/v1/runs/:id/messages', zValidator('json', ask), async (c) => {
  try {
    const job = await enqueue(pool, {
      accountId: c.get('accountId'),
      runId: c.req.param('id'),
      message: c.req.valid('json').message,
      idempotencyKey: c.req.header('Idempotency-Key'),
    });
    return c.json({ run_id: job.runId, job_id: job.jobId, status: 'queued' }, job.created ? 202 : 200);
  } catch (err) {
    if (err instanceof JobError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

app.get('/v1/jobs/:id', async (c) => {
  const waitMs = Math.min(Number(c.req.query('wait') ?? 0), 30) * 1000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, run_id, status, attempts, result, last_error, created_at, updated_at
         FROM agent_jobs WHERE id = $1 AND account_id = $2`,
      [c.req.param('id'), c.get('accountId')],
    );
    const job = rows[0];
    if (!job) return c.json({ error: 'job not found' }, 404);
    if (job.status === 'done' || job.status === 'failed' || Date.now() >= deadline) return c.json(job);
    await new Promise((r) => setTimeout(r, 300));
  }
});

app.get('/v1/actions', async (c) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.kind, a.campaign_id, c.name AS campaign_name, a.params, a.reason, a.status, a.created_at
     FROM proposed_actions a JOIN campaigns c ON c.id = a.campaign_id
     WHERE a.account_id = $1 AND ($2::text IS NULL OR a.status = $2) ORDER BY a.created_at DESC LIMIT 100`,
    [c.get('accountId'), c.req.query('status') ?? null],
  );
  return c.json(rows);
});

app.post('/v1/actions/:id/:decision{approve|reject}', async (c) => {
  try {
    const decision = c.req.param('decision') as 'approve' | 'reject';
    return c.json(await decideAction(pool, c.get('accountId'), c.req.param('id'), decision));
  } catch (err) {
    if (err instanceof ActionError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

app.get('/healthz', (c) => c.text('ok'));

app.onError((err, c) => {
  logger.error({ err }, 'unhandled');
  return c.json({ error: 'internal error' }, 500);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (i) => logger.info({ port: i.port }, 'listening'));
