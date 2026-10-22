CREATE TABLE IF NOT EXISTS accounts (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    currency      text NOT NULL DEFAULT 'TRY',
    -- Upper bound for the sum of daily budgets; budget proposals cannot exceed it.
    daily_budget_cap numeric(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
    id            text PRIMARY KEY,
    account_id    text NOT NULL REFERENCES accounts(id),
    name          text NOT NULL,
    platform      text NOT NULL CHECK (platform IN ('meta', 'google', 'tiktok')),
    objective     text NOT NULL CHECK (objective IN ('sales', 'leads', 'traffic', 'awareness')),
    status        text NOT NULL CHECK (status IN ('active', 'paused')),
    daily_budget  numeric(12, 2) NOT NULL,
    created_at    date NOT NULL
);
CREATE INDEX IF NOT EXISTS campaigns_account_idx ON campaigns (account_id);

CREATE TABLE IF NOT EXISTS daily_metrics (
    campaign_id   text NOT NULL REFERENCES campaigns(id),
    day           date NOT NULL,
    impressions   integer NOT NULL,
    clicks        integer NOT NULL,
    spend         numeric(12, 2) NOT NULL,
    conversions   integer NOT NULL,
    revenue       numeric(12, 2) NOT NULL,
    PRIMARY KEY (campaign_id, day)
);

-- Every write the agent wants to make lands here first and waits for a human.
CREATE TABLE IF NOT EXISTS proposed_actions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    text NOT NULL REFERENCES accounts(id),
    run_id        uuid,
    kind          text NOT NULL CHECK (kind IN ('pause_campaign', 'resume_campaign', 'change_budget')),
    campaign_id   text NOT NULL REFERENCES campaigns(id),
    params        jsonb NOT NULL DEFAULT '{}',
    reason        text NOT NULL,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS proposed_actions_account_idx ON proposed_actions (account_id, status);

-- Conversation transcripts, appended to only (keeps prompt caching and thinking blocks valid).
CREATE TABLE IF NOT EXISTS agent_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    text NOT NULL REFERENCES accounts(id),
    messages      jsonb NOT NULL,
    usage         jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
