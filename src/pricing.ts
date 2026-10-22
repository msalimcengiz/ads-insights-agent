import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages';

/** USD per million tokens (Anthropic first-party list prices, October 2026). */
export const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  // The scripted demo stand-in (AGENT_MODEL=demo) costs nothing.
  demo: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  requests: number;
  cost_usd: number;
  /** Models that served requests, e.g. when a server-side fallback ran. */
  models: string[];
}

export const emptyUsage = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  requests: 0,
  cost_usd: 0,
  models: [],
});

export function costOf(
  model: string,
  u: Pick<BetaUsage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>,
): number {
  const p = PRICING[model];
  if (!p) return Number.NaN;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1_000_000
  );
}

export function addUsage(total: UsageTotals, model: string, u: BetaUsage): UsageTotals {
  return {
    input_tokens: total.input_tokens + u.input_tokens,
    output_tokens: total.output_tokens + u.output_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
    requests: total.requests + 1,
    cost_usd: total.cost_usd + costOf(model, u),
    models: total.models.includes(model) ? total.models : [...total.models, model],
  };
}

/** Share of input tokens served from the prompt cache. */
export function cacheHitRatio(u: UsageTotals): number {
  const all = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return all === 0 ? 0 : u.cache_read_input_tokens / all;
}
