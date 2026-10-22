import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decideAction } from '../src/actions.js';
import { createPool, migrate } from '../src/db.js';
import { SEED_END, seed } from '../src/seed.js';
import { comparePeriods, detectAnomalies, getPerformance, listCampaigns, proposeAction } from '../src/tools/index.js';
import { type ToolContext, ToolInputError } from '../src/tools/types.js';

const pool = createPool();
const moda: ToolContext = { pool, accountId: 'acc_moda', runId: null, asOf: SEED_END };
const ev: ToolContext = { ...moda, accountId: 'acc_ev' };

beforeEach(async () => {
  await migrate(pool);
  await seed(pool);
});
afterAll(() => pool.end());

describe('read tools', () => {
  it('lists only the current account’s campaigns', async () => {
    const { campaigns } = await listCampaigns.run({ status: 'all' }, ev);
    expect(campaigns.map((c: { id: string }) => c.id)).toEqual(['c13', 'c14', 'c15', 'c16', 'c17', 'c18']);
  });

  it('aggregates performance with derived metrics that match raw SQL', async () => {
    const { rows } = await getPerformance.run(
      { campaign_ids: ['c03'], date_from: '2026-10-14', date_to: '2026-10-20', group_by: 'campaign' },
      moda,
    );
    const raw = await pool.query(
      `SELECT sum(spend) s, sum(revenue) r FROM daily_metrics WHERE campaign_id = 'c03' AND day BETWEEN '2026-10-14' AND '2026-10-20'`,
    );
    expect(rows[0].roas).toBeCloseTo(raw.rows[0].r / raw.rows[0].s, 2);
  });

  it('cannot read another tenant’s campaign even by id', async () => {
    const { rows } = await getPerformance.run(
      { campaign_ids: ['c01'], date_from: '2026-10-01', date_to: '2026-10-20', group_by: 'campaign' },
      ev,
    );
    expect(rows).toEqual([]);
  });

  it('rejects ranges in the future or longer than 92 days', async () => {
    await expect(
      getPerformance.run({ campaign_ids: null, date_from: '2026-10-01', date_to: '2026-10-30', group_by: 'day' }, moda),
    ).rejects.toThrow(ToolInputError);
    await expect(
      getPerformance.run({ campaign_ids: null, date_from: '2026-01-01', date_to: '2026-10-20', group_by: 'day' }, moda),
    ).rejects.toThrow(/92 days/);
  });

  it('finds the planted CTR collapse', async () => {
    const { anomalies } = await detectAnomalies.run(
      { metric: 'ctr', recent_days: 7, baseline_days: 28, threshold_pct: 40 },
      moda,
    );
    expect(anomalies.map((a: { id: string }) => a.id)).toEqual(['c06']);
    expect(anomalies[0].change_pct).toBeLessThan(-50);
  });

  it('compares periods per campaign', async () => {
    const { rows } = await comparePeriods.run(
      {
        campaign_ids: ['c06'],
        current_from: '2026-10-11',
        current_to: '2026-10-20',
        previous_from: '2026-10-01',
        previous_to: '2026-10-10',
      },
      moda,
    );
    expect(rows[0].ctr_change_pct).toBeLessThan(-50);
  });
});

describe('propose_action guardrails', () => {
  const pause = {
    kind: 'pause_campaign' as const,
    campaign_id: 'c09',
    new_daily_budget: null,
    reason: 'No conversions in 90 days.',
  };

  it('records a pending proposal and changes nothing', async () => {
    const res = await proposeAction.run(pause, moda);
    expect(res.status).toBe('pending_approval');
    const c = await pool.query(`SELECT status FROM campaigns WHERE id = 'c09'`);
    expect(c.rows[0].status).toBe('active');
  });

  it('deduplicates identical pending proposals', async () => {
    const a = await proposeAction.run(pause, moda);
    const b = await proposeAction.run(pause, moda);
    expect(b.action_id).toBe(a.action_id);
  });

  it('rejects budget changes over ±50%, under the minimum or over the account cap', async () => {
    const budget = (n: number, id = 'c03') => ({
      kind: 'change_budget' as const,
      campaign_id: id,
      new_daily_budget: n,
      reason: 'ROAS is the best in the account.',
    });
    await expect(proposeAction.run(budget(1300), moda)).rejects.toThrow(/exceeds the ±50% limit/); // 800 -> 1300 = +62%
    await pool.query(`UPDATE campaigns SET daily_budget = 90 WHERE id = 'c12'`);
    await expect(proposeAction.run(budget(45, 'c12'), moda)).rejects.toThrow(/minimum daily budget/); // -50%, but under 50 TRY
    // acc_ev: cap 8000; the other active budgets sum to 4000, so c13 1200 -> 1800 fits. With a 5500 cap,
    // c14 900 -> 1350 (+50%, allowed) would push the active total to 5650.
    await expect(proposeAction.run(budget(1800, 'c13'), ev)).resolves.toMatchObject({ status: 'pending_approval' });
    await pool.query(`UPDATE accounts SET daily_budget_cap = 5500 WHERE id = 'acc_ev'`);
    await expect(proposeAction.run(budget(1350, 'c14'), ev)).rejects.toThrow(/cap/);
  });

  it('refuses to touch another tenant’s campaign with the same message as a missing one', async () => {
    await expect(proposeAction.run({ ...pause, campaign_id: 'c13' }, moda)).rejects.toThrow(
      'campaign c13 not found in this account',
    );
    await expect(proposeAction.run({ ...pause, campaign_id: 'zzz' }, moda)).rejects.toThrow(
      'campaign zzz not found in this account',
    );
  });

  it('applies a proposal only once, on approval', async () => {
    const { action_id } = await proposeAction.run(pause, moda);
    await decideAction(pool, 'acc_moda', action_id, 'approve');
    expect((await pool.query(`SELECT status FROM campaigns WHERE id = 'c09'`)).rows[0].status).toBe('paused');
    await expect(decideAction(pool, 'acc_moda', action_id, 'approve')).rejects.toThrow('already approved');
    await expect(decideAction(pool, 'acc_ev', action_id, 'reject')).rejects.toThrow('not found');
  });
});
