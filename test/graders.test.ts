import { afterAll, beforeAll, expect, it } from 'vitest';
import { CASES } from '../evals/cases.js';
import type { AgentResult } from '../src/agent.js';
import { createPool, migrate } from '../src/db.js';
import { emptyUsage } from '../src/pricing.js';
import { seed } from '../src/seed.js';

const pool = createPool();
beforeAll(async () => {
  await migrate(pool);
  await seed(pool);
});
afterAll(() => pool.end());

const result = (answer: string): AgentResult => ({
  answer,
  stop: 'completed',
  messages: [],
  toolCalls: [],
  usage: emptyUsage(),
  iterations: 1,
  ms: 0,
});

it.each(CASES.map((c) => [c.id, c] as const))('grader %s runs its ground-truth query', async (_, c) => {
  const g = await c.grade({ result: result(''), proposals: [], pool });
  expect(typeof g.pass).toBe('boolean');
  expect(g.why.length).toBeGreaterThan(0);
});

it('an empty answer fails every analysis case', async () => {
  for (const c of CASES.filter((c) => c.checks === 'analysis')) {
    expect((await c.grade({ result: result(''), proposals: [], pool })).pass, c.id).toBe(false);
  }
});
