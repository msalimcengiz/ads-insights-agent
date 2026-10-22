import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages';
import type pg from 'pg';
import type { z } from 'zod';

/**
 * Server-side context for every tool call. The account comes from the authenticated
 * request, never from model output, so a tool can only see and change its own tenant.
 */
export interface ToolContext {
  pool: pg.Pool;
  accountId: string;
  runId: string | null;
  /** "Today" for relative date questions; fixed in demos and evals for reproducibility. */
  asOf: string;
}

export interface AgentTool<S extends z.ZodType = z.ZodType, O = unknown> {
  definition: BetaTool;
  schema: S;
  /** true if the tool only records a proposal; nothing it does changes live campaigns. */
  proposesWrite: boolean;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<O>;
}

/** An error the model can act on (bad date range, unknown campaign, guardrail hit). */
export class ToolInputError extends Error {}

export function defineTool<S extends z.ZodType, O>(t: AgentTool<S, O>): AgentTool<S, O> {
  return t;
}
