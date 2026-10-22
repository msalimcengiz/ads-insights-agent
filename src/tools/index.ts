import { z } from 'zod';
import { checkRange, METRIC_SQL } from './metrics.js';
import { type AgentTool, defineTool, ToolInputError } from './types.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const campaignIds = z.array(z.string().max(32)).max(50).nullable();

function assertRange(from: string, to: string, asOf: string) {
  const err = checkRange(from, to, asOf);
  if (err) throw new ToolInputError(err);
}

// Strict tool schemas: every property listed in `required`, optional ones are nullable.
const nullableIds = {
  type: ['array', 'null'],
  items: { type: 'string' },
  description: 'Campaign ids to include, or null for every campaign in the account.',
} as const;

export const listCampaigns = defineTool({
  proposesWrite: false,
  schema: z.object({ status: z.enum(['active', 'paused', 'all']) }),
  definition: {
    name: 'list_campaigns',
    description:
      'List the campaigns in the current ad account with platform, objective, status, daily budget, ' +
      'and last-7-day spend, revenue and ROAS. Use it first to learn campaign ids and names.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'paused', 'all'] } },
      required: ['status'],
      additionalProperties: false,
    },
  },
  async run({ status }, ctx) {
    const { rows } = await ctx.pool.query(
      `SELECT c.id, c.name, c.platform, c.objective, c.status, c.daily_budget,
              round(coalesce(sum(m.spend), 0), 2) AS spend_7d,
              round(coalesce(sum(m.revenue), 0), 2) AS revenue_7d,
              round(sum(m.revenue) / nullif(sum(m.spend), 0), 3) AS roas_7d
       FROM campaigns c
       LEFT JOIN daily_metrics m ON m.campaign_id = c.id AND m.day > $2::date - 7 AND m.day <= $2::date
       WHERE c.account_id = $1 AND ($3 = 'all' OR c.status = $3)
       GROUP BY c.id ORDER BY c.id`,
      [ctx.accountId, ctx.asOf, status],
    );
    return { as_of: ctx.asOf, campaigns: rows };
  },
});

export const getPerformance = defineTool({
  proposesWrite: false,
  schema: z.object({
    campaign_ids: campaignIds,
    date_from: date,
    date_to: date,
    group_by: z.enum(['campaign', 'day', 'platform']),
  }),
  definition: {
    name: 'get_performance',
    description:
      'Aggregate impressions, clicks, spend, conversions, revenue and derived CTR, CPC, CVR, CPA and ROAS ' +
      'for a date range (inclusive, at most 92 days), grouped by campaign, day or platform. ' +
      'Amounts are in the account currency (TRY).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        campaign_ids: nullableIds,
        date_from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        date_to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        group_by: { type: 'string', enum: ['campaign', 'day', 'platform'] },
      },
      required: ['campaign_ids', 'date_from', 'date_to', 'group_by'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    assertRange(input.date_from, input.date_to, ctx.asOf);
    const key = { campaign: 'c.id, c.name', day: 'm.day', platform: 'c.platform' }[input.group_by];
    const { rows } = await ctx.pool.query(
      `SELECT ${key}, ${METRIC_SQL}
       FROM daily_metrics m JOIN campaigns c ON c.id = m.campaign_id
       WHERE c.account_id = $1 AND m.day BETWEEN $2 AND $3
         AND ($4::text[] IS NULL OR c.id = ANY($4))
       GROUP BY ${key} ORDER BY ${input.group_by === 'day' ? 'm.day' : 'spend DESC'}
       LIMIT 200`,
      [ctx.accountId, input.date_from, input.date_to, input.campaign_ids],
    );
    return { date_from: input.date_from, date_to: input.date_to, group_by: input.group_by, rows };
  },
});

export const comparePeriods = defineTool({
  proposesWrite: false,
  schema: z.object({
    campaign_ids: campaignIds,
    current_from: date,
    current_to: date,
    previous_from: date,
    previous_to: date,
  }),
  definition: {
    name: 'compare_periods',
    description:
      'Compare two date ranges per campaign (e.g. this week vs last week). Returns both periods and the ' +
      'percentage change of spend, revenue, CTR, CPA and ROAS.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        campaign_ids: nullableIds,
        current_from: { type: 'string' },
        current_to: { type: 'string' },
        previous_from: { type: 'string' },
        previous_to: { type: 'string' },
      },
      required: ['campaign_ids', 'current_from', 'current_to', 'previous_from', 'previous_to'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    assertRange(input.current_from, input.current_to, ctx.asOf);
    assertRange(input.previous_from, input.previous_to, ctx.asOf);
    const { rows } = await ctx.pool.query(
      `WITH p AS (
         SELECT c.id, c.name, (m.day BETWEEN $2 AND $3) AS cur, ${METRIC_SQL}
         FROM daily_metrics m JOIN campaigns c ON c.id = m.campaign_id
         WHERE c.account_id = $1 AND ($6::text[] IS NULL OR c.id = ANY($6))
           AND (m.day BETWEEN $2 AND $3 OR m.day BETWEEN $4 AND $5)
         GROUP BY c.id, c.name, cur)
       SELECT a.id, a.name,
              to_jsonb(a) - 'id' - 'name' - 'cur' AS current,
              to_jsonb(b) - 'id' - 'name' - 'cur' AS previous,
              round(100 * (a.spend - b.spend) / nullif(b.spend, 0), 1) AS spend_change_pct,
              round(100 * (a.revenue - b.revenue) / nullif(b.revenue, 0), 1) AS revenue_change_pct,
              round(100 * (a.ctr_pct - b.ctr_pct) / nullif(b.ctr_pct, 0), 1) AS ctr_change_pct,
              round(100 * (a.cpa - b.cpa) / nullif(b.cpa, 0), 1) AS cpa_change_pct,
              round(100 * (a.roas - b.roas) / nullif(b.roas, 0), 1) AS roas_change_pct
       FROM p a LEFT JOIN p b ON b.id = a.id AND NOT b.cur
       WHERE a.cur ORDER BY a.id`,
      [ctx.accountId, input.current_from, input.current_to, input.previous_from, input.previous_to, input.campaign_ids],
    );
    return { rows };
  },
});

export const detectAnomalies = defineTool({
  proposesWrite: false,
  schema: z.object({
    metric: z.enum(['ctr', 'cpa', 'roas', 'spend', 'conversions']),
    recent_days: z.number().int().min(1).max(14),
    baseline_days: z.number().int().min(7).max(60),
    threshold_pct: z.number().min(5).max(500),
  }),
  definition: {
    name: 'detect_anomalies',
    description:
      'Find active campaigns whose metric over the most recent N days differs from the preceding baseline ' +
      'window by more than threshold_pct. Good first step for "what changed?" or "what is going wrong?".',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['ctr', 'cpa', 'roas', 'spend', 'conversions'] },
        recent_days: { type: 'integer', description: '1-14' },
        baseline_days: { type: 'integer', description: '7-60, the window before the recent days' },
        threshold_pct: { type: 'number', description: 'e.g. 30 for ±30%' },
      },
      required: ['metric', 'recent_days', 'baseline_days', 'threshold_pct'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const expr = {
      ctr: '100.0 * sum(clicks) / nullif(sum(impressions), 0)',
      cpa: 'sum(spend) / nullif(sum(conversions), 0)',
      roas: 'sum(revenue) / nullif(sum(spend), 0)',
      spend: 'sum(spend) / count(DISTINCT day)',
      conversions: 'sum(conversions)::numeric / count(DISTINCT day)',
    }[input.metric];
    const { rows } = await ctx.pool.query(
      `WITH w AS (
         SELECT c.id, c.name,
                (SELECT ${expr} FROM daily_metrics WHERE campaign_id = c.id
                   AND day > $2::date - $3::int AND day <= $2::date) AS recent,
                (SELECT ${expr} FROM daily_metrics WHERE campaign_id = c.id
                   AND day > $2::date - $3::int - $4::int AND day <= $2::date - $3::int) AS baseline
         FROM campaigns c WHERE c.account_id = $1 AND c.status = 'active')
       SELECT id, name, round(recent, 3) AS recent, round(baseline, 3) AS baseline,
              round(100 * (recent - baseline) / nullif(baseline, 0), 1) AS change_pct
       FROM w
       WHERE baseline IS NOT NULL AND (
         (baseline <> 0 AND abs(100 * (coalesce(recent, 0) - baseline) / baseline) > $5) OR
         (baseline = 0 AND coalesce(recent, 0) <> 0))
       ORDER BY abs(coalesce(recent, 0) - baseline) / nullif(abs(baseline), 0) DESC NULLS LAST`,
      [ctx.accountId, ctx.asOf, input.recent_days, input.baseline_days, input.threshold_pct],
    );
    return { metric: input.metric, as_of: ctx.asOf, anomalies: rows };
  },
});

/** Hard limits for proposals. Enforced here, not in the prompt. */
export const GUARDRAILS = { maxBudgetChangePct: 50, minDailyBudget: 50 } as const;

export const proposeAction = defineTool({
  proposesWrite: true,
  schema: z.object({
    kind: z.enum(['pause_campaign', 'resume_campaign', 'change_budget']),
    campaign_id: z.string().max(32),
    new_daily_budget: z.number().positive().nullable(),
    reason: z.string().min(10).max(500),
  }),
  definition: {
    name: 'propose_action',
    description:
      'Propose a change to a campaign: pause, resume or a new daily budget. Nothing changes until a person ' +
      `approves the proposal. Budget changes are limited to ±${GUARDRAILS.maxBudgetChangePct}% of the current budget, ` +
      `at least ${GUARDRAILS.minDailyBudget} TRY, and the account's total daily cap. Give a reason based on the numbers you saw.`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['pause_campaign', 'resume_campaign', 'change_budget'] },
        campaign_id: { type: 'string' },
        new_daily_budget: { type: ['number', 'null'], description: 'Required for change_budget, otherwise null' },
        reason: { type: 'string' },
      },
      required: ['kind', 'campaign_id', 'new_daily_budget', 'reason'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { rows } = await ctx.pool.query<{ status: string; daily_budget: number; cap: number; active_total: number }>(
      `SELECT c.status, c.daily_budget, a.daily_budget_cap AS cap,
              (SELECT coalesce(sum(daily_budget), 0) FROM campaigns
                WHERE account_id = a.id AND status = 'active' AND id <> c.id) AS active_total
       FROM campaigns c JOIN accounts a ON a.id = c.account_id
       WHERE c.id = $1 AND c.account_id = $2`,
      [input.campaign_id, ctx.accountId],
    );
    const c = rows[0];
    // Same message for "missing" and "other tenant": no information leaks across accounts.
    if (!c) throw new ToolInputError(`campaign ${input.campaign_id} not found in this account`);

    let params: Record<string, number> = {};
    if (input.kind === 'pause_campaign' && c.status !== 'active') throw new ToolInputError('campaign is not active');
    if (input.kind === 'resume_campaign' && c.status !== 'paused') throw new ToolInputError('campaign is not paused');
    if (input.kind === 'change_budget') {
      const nb = input.new_daily_budget;
      if (nb == null) throw new ToolInputError('new_daily_budget is required for change_budget');
      const changePct = (100 * Math.abs(nb - c.daily_budget)) / c.daily_budget;
      if (changePct > GUARDRAILS.maxBudgetChangePct) {
        throw new ToolInputError(
          `change of ${changePct.toFixed(0)}% exceeds the ±${GUARDRAILS.maxBudgetChangePct}% limit ` +
            `(current ${c.daily_budget}, allowed ${c.daily_budget * 0.5}-${c.daily_budget * 1.5})`,
        );
      }
      if (nb < GUARDRAILS.minDailyBudget)
        throw new ToolInputError(`minimum daily budget is ${GUARDRAILS.minDailyBudget}`);
      if (c.status === 'active' && c.active_total + nb > c.cap) {
        throw new ToolInputError(`account daily cap ${c.cap} would be exceeded (${c.active_total + nb})`);
      }
      params = { from: c.daily_budget, to: Math.round(nb * 100) / 100 };
    }

    const dup = await ctx.pool.query(
      `SELECT id FROM proposed_actions WHERE account_id = $1 AND campaign_id = $2 AND kind = $3 AND status = 'pending'`,
      [ctx.accountId, input.campaign_id, input.kind],
    );
    if (dup.rows[0])
      return {
        action_id: dup.rows[0].id,
        status: 'pending_approval',
        note: 'an identical proposal is already pending',
      };

    const ins = await ctx.pool.query<{ id: string }>(
      `INSERT INTO proposed_actions (account_id, run_id, kind, campaign_id, params, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ctx.accountId, ctx.runId, input.kind, input.campaign_id, params, input.reason],
    );
    return { action_id: ins.rows[0]?.id, status: 'pending_approval' };
  },
});

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list; each tool validates its own input.
export const ALL_TOOLS: AgentTool<any, unknown>[] = [
  listCampaigns,
  getPerformance,
  comparePeriods,
  detectAnomalies,
  proposeAction,
];
