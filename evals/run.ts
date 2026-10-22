/**
 * Runs the eval cases against the real Claude API and writes a report.
 *
 *   ANTHROPIC_API_KEY=... npm run eval -- --effort medium --repeat 1 [--only id1,id2]
 *
 * Every run calls the paid API: 12 cases × repeat. The report lists the measured cost.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../src/agent.js';
import { createPool, migrate } from '../src/db.js';
import { cacheHitRatio } from '../src/pricing.js';
import { enqueue } from '../src/jobs.js';
import { processNext } from '../src/runs.js';
import type { AgentResult } from '../src/agent.js';
import { pino } from 'pino';
import { SEED_END, seed } from '../src/seed.js';
import { CASES, type Proposal } from './cases.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'medium' },
    repeat: { type: 'string', default: '1' },
    only: { type: 'string' },
  },
});

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Set ANTHROPIC_API_KEY to run the evals (they call the paid API).');
  process.exit(2);
}

const anthropic = new Anthropic();
const pool = createPool();
await migrate(pool);
const config: Partial<AgentConfig> = { model: values.model, effort: values.effort as AgentConfig['effort'] };
const cases = values.only ? CASES.filter((c) => values.only?.split(',').includes(c.id)) : CASES;

interface Row {
  id: string;
  checks: string;
  pass: boolean;
  why: string;
  costUsd: number;
  ms: number;
  tools: number;
  iterations: number;
  cacheHit: number;
  stop: string;
}
const rows: Row[] = [];

for (let r = 0; r < Number(values.repeat); r++) {
  for (const c of cases) {
    await seed(pool); // every case starts from the same data
    const { jobId, runId } = await enqueue(pool, { accountId: c.account, message: c.prompt });
    // Run the job in this process, through the same path the worker uses.
    await processNext({
      pool,
      client: (p) => anthropic.beta.messages.create(p),
      workerId: 'eval',
      asOf: () => SEED_END,
      logger: pino({ level: 'silent' }),
      config,
    });
    const job = (await pool.query('SELECT status, result, last_error FROM agent_jobs WHERE id = $1', [jobId])).rows[0];
    if (job.status !== 'done') throw new Error(`job ${jobId} ${job.status}: ${job.last_error}`);
    const result = {
      ...job.result,
      toolCalls: job.result.tool_calls,
      usage: job.result.usage.this_turn,
      runId,
    } as AgentResult & { runId: string };
    const { rows: proposals } = await pool.query<Proposal>(
      'SELECT kind, campaign_id, params FROM proposed_actions WHERE run_id = $1',
      [result.runId],
    );
    const grade = await c.grade({ result, proposals, pool });
    rows.push({
      id: c.id,
      checks: c.checks,
      pass: grade.pass,
      why: grade.why,
      costUsd: result.usage.cost_usd,
      ms: result.ms,
      tools: result.toolCalls.length,
      iterations: result.iterations,
      cacheHit: cacheHitRatio(result.usage),
      stop: result.stop,
    });
    console.log(`${grade.pass ? 'PASS' : 'FAIL'} ${c.id} $${result.usage.cost_usd.toFixed(4)} ${result.ms}ms — ${grade.why}`);
    if (!grade.pass) console.log(`  answer: ${result.answer.slice(0, 400).replace(/\n/g, ' ')}`);
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const passed = rows.filter((r) => r.pass).length;
const cost = rows.reduce((s, r) => s + r.costUsd, 0);
const byGroup = ['analysis', 'action', 'safety'].map((g) => {
  const rs = rows.filter((r) => r.checks === g);
  return `${g} ${rs.filter((r) => r.pass).length}/${rs.length}`;
});

let md = `Model \`${values.model}\`, effort \`${values.effort}\`, ${rows.length} runs (${new Date().toISOString().slice(0, 10)}).\n\n`;
md += `**${passed}/${rows.length} passed** (${byGroup.join(', ')}). `;
md += `Total cost $${cost.toFixed(3)}, $${(cost / rows.length).toFixed(4)} per question. `;
md += `Latency p50 ${(pct(rows.map((r) => r.ms), 50) / 1000).toFixed(1)} s, p95 ${(pct(rows.map((r) => r.ms), 95) / 1000).toFixed(1)} s. `;
md += `Prompt-cache hit ratio ${(100 * (rows.reduce((s, r) => s + r.cacheHit, 0) / rows.length)).toFixed(0)}% of input tokens.\n\n`;
md += '| case | checks | result | cost | latency | tool calls | iterations |\n|---|---|---|---:|---:|---:|---:|\n';
for (const r of rows) {
  md += `| ${r.id} | ${r.checks} | ${r.pass ? 'pass' : `**fail**: ${r.why}`} | $${r.costUsd.toFixed(4)} | ${(r.ms / 1000).toFixed(1)} s | ${r.tools} | ${r.iterations} |\n`;
}
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL('./results/latest.md', import.meta.url), md);
console.log(`\n${md}`);
await pool.end();
