/**
 * compat/dsh-0.1/prestep — the first-request gate seam.
 *
 * PLAN §4.1: the Magic gate registers on `agent/pre-step` with `prepend: true`
 * (outermost), awaits the DB/config/schema fence, then returns the final
 * `PreStepDecision`. Validated in Phase 0 spike-2.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-session";

/** The official pre-step decision (waterfall next() preserves current). */
export type PreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: UserMessage[] };

/** Payload of the `agent/pre-step` waterfall event. */
export interface PreStepPayload {
  readonly agent: Agent;
  readonly messages: UserMessage[];
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

/**
 * Register the Magic gate as the OUTERMOST pre-step listener. The gate runs
 * before every downstream listener; `next()` invokes the rest of the chain.
 * A gate that never calls `next()` vetoes the step (fail-closed).
 */
export function registerPreStepGate(
  ctx: Context,
  gate: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
): () => boolean {
  return ctx.on(
    "agent/pre-step",
    (payload: PreStepPayload, next: () => Promise<PreStepDecision>) =>
      gate(payload, next),
    { prepend: true },
  );
}
