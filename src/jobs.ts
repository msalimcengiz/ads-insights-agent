import type pg from 'pg';
import { emptyUsage } from './pricing.js';

export interface Job {
  id: string;
  run_id: string;
  account_id: string;
  message: string;
  attempts: number;
  max_attempts: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * Creates the job (and, for a new conversation, the run) in one transaction. With an
 * idempotency key, a repeated request returns the job it created the first time.
 */
export async function enqueue(
  pool: pg.Pool,
  opts: { accountId: string; message: string; runId?: string; idempotencyKey?: string },
): Promise<{ jobId: string; runId: string; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.idempotencyKey) {
      const existing = await client.query<{ id: string; run_id: string }>(
        'SELECT id, run_id FROM agent_jobs WHERE account_id = $1 AND idempotency_key = $2',
        [opts.accountId, opts.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('ROLLBACK');
        return { jobId: existing.rows[0].id, runId: existing.rows[0].run_id, created: false };
      }
    }
    let runId = opts.runId;
    if (runId) {
      const owned = await client.query('SELECT 1 FROM agent_runs WHERE id = $1 AND account_id = $2', [
        runId,
        opts.accountId,
      ]);
      if (!owned.rows[0]) throw new JobError('run not found');
    } else {
      const run = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (account_id, messages, usage) VALUES ($1, '[]', $2) RETURNING id`,
        [opts.accountId, emptyUsage()],
      );
      runId = run.rows[0]?.id as string;
    }
    const job = await client.query<{ id: string }>(
      `INSERT INTO agent_jobs (run_id, account_id, message, idempotency_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING id`,
      [runId, opts.accountId, opts.message, opts.idempotencyKey ?? null],
    );
    if (!job.rows[0]) {
      // Lost a race with the same key: hand back the winner's job.
      await client.query('ROLLBACK');
      return enqueue(pool, opts);
    }
    await client.query('COMMIT');
    return { jobId: job.rows[0].id, runId, created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Claims the next runnable job, or returns null.
 *
 * - FOR UPDATE SKIP LOCKED lets many workers claim concurrently without blocking or
 *   double-claiming.
 * - A running job whose lease expired is claimable again (its worker died).
 * - Jobs of one conversation run strictly one at a time and in order: the transcript is
 *   append-only, and two concurrent turns would each extend a stale copy of it.
 */
export async function claim(pool: pg.Pool, workerId: string, leaseMs: number): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `UPDATE agent_jobs j
        SET status = 'running', attempts = attempts + 1, locked_by = $1,
            locked_until = now() + make_interval(secs => $2 / 1000.0), updated_at = now()
      WHERE j.id = (
        SELECT c.id FROM agent_jobs c
         WHERE ((c.status = 'queued' AND c.available_at <= now())
             OR (c.status = 'running' AND c.locked_until < now()))
           AND NOT EXISTS (
             SELECT 1 FROM agent_jobs o
              WHERE o.run_id = c.run_id AND o.id <> c.id
                AND ((o.status IN ('queued', 'running') AND o.created_at < c.created_at)
                  OR (o.status = 'running' AND o.locked_until >= now())))
         ORDER BY c.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING j.id, j.run_id, j.account_id, j.message, j.attempts, j.max_attempts`,
    [workerId, leaseMs],
  );
  return rows[0] ?? null;
}

/** Extends the lease. False means another worker took the job over: stop working on it. */
export async function heartbeat(pool: pg.Pool, jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE agent_jobs SET locked_until = now() + make_interval(secs => $3 / 1000.0)
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, leaseMs],
  );
  return rowCount === 1;
}

/**
 * Runs `commit` and marks the job done in one transaction, but only while this worker
 * still holds the lease (fencing). A worker that lost its lease cannot overwrite the
 * transcript written by the worker that took over.
 */
export async function finish(
  pool: pg.Pool,
  jobId: string,
  workerId: string,
  result: unknown,
  commit: (client: pg.PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT 1 FROM agent_jobs WHERE id = $1 AND locked_by = $2 AND status = 'running' FOR UPDATE`,
      [jobId, workerId],
    );
    if (!owned.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    await commit(client);
    await client.query(
      `UPDATE agent_jobs SET status = 'done', result = $2, last_error = NULL, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, JSON.stringify(result)],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Puts the job back for a later attempt, or fails it when it is out of attempts. */
export async function retryOrFail(
  pool: pg.Pool,
  job: Job,
  workerId: string,
  error: string,
  delayMs: number | null,
): Promise<JobStatus> {
  const permanent = delayMs === null || job.attempts >= job.max_attempts;
  const { rows } = await pool.query<{ status: JobStatus }>(
    `UPDATE agent_jobs
        SET status = $3, last_error = $4, locked_until = NULL, locked_by = NULL, updated_at = now(),
            available_at = now() + make_interval(secs => $5 / 1000.0)
      WHERE id = $1 AND locked_by = $2
      RETURNING status`,
    [job.id, workerId, permanent ? 'failed' : 'queued', error.slice(0, 1000), delayMs ?? 0],
  );
  return rows[0]?.status ?? 'running';
}

export class JobError extends Error {}
