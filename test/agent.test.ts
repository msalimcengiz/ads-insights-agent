import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ModelClient, runAgent, SYSTEM_PROMPT } from '../src/agent.js';
import { createPool, migrate } from '../src/db.js';
import { costOf } from '../src/pricing.js';
import { SEED_END, seed } from '../src/seed.js';
import { ALL_TOOLS } from '../src/tools/index.js';

const pool = createPool();
const ctx = { pool, accountId: 'acc_moda', runId: null, asOf: SEED_END };

beforeAll(async () => {
  await migrate(pool);
  await seed(pool);
});
afterAll(() => pool.end());

const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 };

function message(
  content: BetaContentBlock[],
  stop_reason: BetaMessage['stop_reason'],
  extra: Partial<BetaMessage> = {},
): BetaMessage {
  return {
    id: `msg_${Math.random()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage,
    ...extra,
  } as BetaMessage;
}

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as BetaContentBlock;

/** Returns scripted responses in order and records every request. */
function scripted(...responses: BetaMessage[]) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const client: ModelClient = async (params) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    return next;
  };
  return { client, requests };
}

describe('runAgent', () => {
  it('runs parallel tool calls and returns all results in one user message', async () => {
    const { client, requests } = scripted(
      message(
        [
          toolUse('t1', 'list_campaigns', { status: 'active' }),
          toolUse('t2', 'detect_anomalies', { metric: 'ctr', recent_days: 7, baseline_days: 28, threshold_pct: 40 }),
        ],
        'tool_use',
      ),
      message([text('TikTok UGC kampanyasında CTR %60 düştü.')], 'end_turn'),
    );
    const r = await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'Ne değişti?' });

    expect(r.stop).toBe('completed');
    expect(r.answer).toContain('CTR');
    expect(r.toolCalls.map((t) => [t.name, t.ok])).toEqual([
      ['list_campaigns', true],
      ['detect_anomalies', true],
    ]);
    const second = requests[1];
    const results = second?.messages.at(-1);
    expect(results?.role).toBe('user');
    expect(Array.isArray(results?.content) && results.content.map((b) => b.type)).toEqual([
      'tool_result',
      'tool_result',
    ]);
    expect(JSON.stringify(results)).toContain('c06');
  });

  it('sends a stable, cacheable prefix with the date in the user turn', async () => {
    const { client, requests } = scripted(message([text('ok')], 'end_turn'));
    await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'Merhaba' });
    const p = requests[0];
    expect(p?.system).toBe(SYSTEM_PROMPT);
    expect(p?.cache_control).toEqual({ type: 'ephemeral' });
    expect(p?.model).toBe('claude-opus-5-5');
    expect(p?.thinking).toEqual({ type: 'adaptive' });
    expect(p?.fallbacks).toBe('default');
    expect(JSON.stringify(p?.messages[0])).toContain(`[today: ${SEED_END}]`);
  });

  it('returns invalid input and guardrail failures to the model as is_error results', async () => {
    const { client, requests } = scripted(
      message(
        [
          toolUse('t1', 'get_performance', {
            campaign_ids: null,
            date_from: '2026-10-25',
            date_to: '2026-10-01',
            group_by: 'day',
          }),
          toolUse('t2', 'propose_action', {
            kind: 'change_budget',
            campaign_id: 'c03',
            new_daily_budget: 5000,
            reason: 'Best ROAS in the account.',
          }),
          toolUse('t3', 'drop_tables', {}),
        ],
        'tool_use',
      ),
      message([text('Düzelttim.')], 'end_turn'),
    );
    const r = await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'x' });

    expect(r.toolCalls.every((t) => !t.ok)).toBe(true);
    const content = requests[1]?.messages.at(-1)?.content as Array<{ is_error?: boolean; content: string }>;
    expect(content.map((c) => c.is_error)).toEqual([true, true, true]);
    expect(content[0]?.content).toMatch(/after date_to/);
    expect(content[1]?.content).toMatch(/±50%/);
    expect(content[2]?.content).toMatch(/Unknown tool/);
  });

  it('resumes after pause_turn and appends assistant content unchanged', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as BetaContentBlock;
    const { client, requests } = scripted(message([thinking], 'pause_turn'), message([text('done')], 'end_turn'));
    const r = await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'x' });
    expect(r.iterations).toBe(2);
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'assistant', content: [thinking] });
  });

  it('stops on refusal and reports the category', async () => {
    const { client } = scripted(
      message([], 'refusal', {
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      } as Partial<BetaMessage>),
    );
    const r = await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'x' });
    expect(r).toMatchObject({ stop: 'refusal', refusalCategory: 'cyber' });
  });

  it('enforces the iteration and cost limits', async () => {
    const loop = () => message([toolUse(`t${Math.random()}`, 'list_campaigns', { status: 'all' })], 'tool_use');
    const a = scripted(loop(), loop(), loop());
    expect(
      (
        await runAgent({
          client: a.client,
          tools: ALL_TOOLS,
          ctx,
          history: [],
          userMessage: 'x',
          config: { maxIterations: 3 },
        })
      ).stop,
    ).toBe('iteration_limit');

    const b = scripted(loop(), loop());
    const r = await runAgent({
      client: b.client,
      tools: ALL_TOOLS,
      ctx,
      history: [],
      userMessage: 'x',
      config: { maxCostUsd: 0.001 },
    });
    expect(r.stop).toBe('cost_limit');
    expect(r.iterations).toBe(1);
  });

  it('accumulates usage and prices it per served model', async () => {
    const { client } = scripted(
      message([toolUse('t1', 'list_campaigns', { status: 'all' })], 'tool_use'),
      message([text('ok')], 'end_turn', { model: 'claude-sonnet-5-5' }),
    );
    const r = await runAgent({ client, tools: ALL_TOOLS, ctx, history: [], userMessage: 'x' });
    expect(r.usage.requests).toBe(2);
    expect(r.usage.cache_read_input_tokens).toBe(8000);
    expect(r.usage.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(r.usage.cost_usd).toBeCloseTo(costOf('claude-opus-5-5', usage) + costOf('claude-sonnet-5-5', usage), 10);
    // Opus 5.5: 1000 × $4 + 200 × $20 + 4000 × $0.20 per million = $0.0088
    expect(costOf('claude-opus-5-5', usage)).toBeCloseTo(0.0088, 10);
  });
});
