-- Agent runs are executed by workers, not inside the HTTP request: a run makes several
-- model calls and can take a minute. Postgres is the queue here on purpose: the volume is
-- small, and the job row is written in the same transaction as the conversation it
-- belongs to, so no outbox is needed.
CREATE TABLE IF NOT EXISTS agent_jobs (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid        NOT NULL REFERENCES agent_runs(id),
    account_id      text        NOT NULL REFERENCES accounts(id),
    message         text        NOT NULL,
    idempotency_key text,
    status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts        int         NOT NULL DEFAULT 0,
    max_attempts    int         NOT NULL DEFAULT 4,
    available_at    timestamptz NOT NULL DEFAULT now(),
    -- Lease: a running job whose lease ran out (worker crashed or hung) can be claimed again.
    locked_until    timestamptz,
    locked_by       text,
    result          jsonb,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agent_jobs_open_idx ON agent_jobs (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS agent_jobs_run_idx ON agent_jobs (run_id, created_at);
