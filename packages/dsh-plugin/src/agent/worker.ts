/**
 * agent/worker — the minimal Magic worker (PLAN §5.13/D7) + recursion
 * isolation (PLAN §9 worker 递归隔离).
 *
 * A worker is a one-shot child agent with: depth pinned (maxDepth 0 — workers
 * can never spawn further), an explicit tool allowlist, delegated approval
 * pinned to 'never' (captureDelegatedPolicyOverrides), and no default shell /
 * network / credential inheritance beyond what the allowlist grants. It is
 * used for the tool-requiring Dreamer/Sidekick paths.
 *
 * RECURSION ISOLATION: the agent-plane Magic listeners (context plane,
 * knowledge gate, session tracking) must NOT process child sessions — a child
 * inherits the parent's preset composition, so without this gate every worker
 * turn would re-enter the full Magic pipeline. `isMagicChildSession` is the
 * single gate: header `origin === 'subagent'` or a persisted delegation
 * depth ≥ 1. This matches §5.10: Magic's per-session machinery applies to the
 * Magic-marked (top-level magic-standard) tree, while children run with
 * official semantics.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { textBlock } from "../compat/dsh-0.1/session";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  magicWorkerRequest,
  subagentsOf,
  type SubagentStartRequest,
} from "../compat/dsh-0.1/subagent";

/** Whether a session is a CHILD session (subagent origin or delegation depth). */
export function isMagicChildSession(agent: Agent): boolean {
  const header = agent.session?.header as
    | { origin?: string; delegationDepth?: number }
    | undefined;
  if (header?.origin === "subagent") return true;
  return typeof header?.delegationDepth === "number" && header.delegationDepth >= 1;
}

/** One worker run result. */
export interface MagicWorkerResult {
  readonly text: string;
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface MagicWorkerDeps {
  /** The parent agent (owner of the worker). */
  readonly parent: Agent;
  /** Worker label (persistent provenance). */
  readonly label: string;
  /** The worker's task prompt (user turn). */
  readonly prompt: string;
  /** Tool allowlist (default: the read-only maintenance surface). */
  readonly allow?: readonly string[];
  /** Optional system prompt for the worker. */
  readonly systemPrompt?: string;
  readonly signal: AbortSignal;
  /** Hard timeout (default 120s). */
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

/**
 * Run one Magic worker. Returns null on failure/cancel/timeout (never throws
 * to the caller's pre-step chain). Delegated policy overrides (approval
 * 'never' + the parent's sandbox mode) are applied BEFORE the first await of
 * the run.
 */
export async function runMagicWorker(
  ctx: Context,
  deps: MagicWorkerDeps,
): Promise<MagicWorkerResult | null> {
  const log = deps.log ?? (() => {});
  try {
    const subagents = subagentsOf(ctx);
    if (subagents === undefined) {
      log("[magic-context] worker skipped: subagents service unavailable");
      return null;
    }
    const started = Date.now();
    const request: SubagentStartRequest = magicWorkerRequest(deps.parent, {
      label: deps.label,
      prompt: [textBlock(deps.prompt)],
      allow: deps.allow ?? ["read", "grep", "glob", "fs_search"],
      maxDepth: 0, // workers can never spawn further (recursion cap)
      signal: deps.signal,
      persona: deps.systemPrompt,
    });

    const run = await subagents.start("spawn", request);
    // Approval pinning + sandbox inheritance BEFORE the run proceeds. The
    // overrides attach to the child SESSION; the local agent (when exposed)
    // carries it.
    const childSession = (run as unknown as { localAgent?: { session?: unknown } }).localAgent
      ?.session;
    if (childSession !== undefined) {
      appendDelegatedPolicyOverrides(childSession as never, captureDelegatedPolicyOverrides(deps.parent));
    }

    const timeout = deps.timeoutMs ?? 120_000;
    const result = await Promise.race([
      run.result,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => {
          run.dispose();
          resolve(null);
        }, timeout);
        deps.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            run.dispose();
            resolve(null);
          },
          { once: true },
        );
      }),
    ]);
    if (result === null) return null;
    const stopReason = (result as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted" || stopReason === "refusal") {
      return null;
    }
    const text = result.output
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    return {
      text,
      durationMs: Date.now() - started,
      toolCallCount: result.structured !== undefined ? 1 : 0,
    };
  } catch (error) {
    log(`[magic-context] worker failed (returns null): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
