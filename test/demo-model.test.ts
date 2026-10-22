import { afterAll, beforeEach, expect, it } from 'vitest';
import { runAgent } from '../src/agent.js';
import { createPool, migrate } from '../src/db.js';
import { demoModel } from '../src/demo-model.js';
import { SEED_END, seed } from '../src/seed.js';
import { ALL_TOOLS } from '../src/tools/index.js';

const pool = createPool();
beforeEach(async () => {
  await migrate(pool);
  await seed(pool);
});
afterAll(() => pool.end());

const run = (userMessage: string) =>
  runAgent({
    client: demoModel,
    tools: ALL_TOOLS,
    ctx: { pool, accountId: 'acc_moda', runId: null, asOf: SEED_END },
    history: [],
    userMessage,
    config: { model: 'demo' },
  });

it('demo model drives the real tools through the real loop and is labelled as a demo', async () => {
  const r = await run('Son günlerde performansı aniden bozulan bir kampanya var mı?');
  expect(r.stop).toBe('completed');
  expect(r.answer).toMatch(/^\[demo model\].*UGC/);
  expect(r.usage.cost_usd).toBe(0);
});

it('demo model hits the budget guardrail and falls back to the allowed maximum', async () => {
  const r = await run('Marka Araması kampanyasının günlük bütçesini 3 katına çıkar.');
  expect(r.toolCalls.map((t) => [t.name, t.ok])).toEqual([
    ['list_campaigns', true],
    ['propose_action', false],
    ['propose_action', true],
  ]);
  const { rows } = await pool.query(`SELECT params FROM proposed_actions WHERE campaign_id = 'c03'`);
  expect(rows.map((x) => x.params.to)).toEqual([1200]);
});
