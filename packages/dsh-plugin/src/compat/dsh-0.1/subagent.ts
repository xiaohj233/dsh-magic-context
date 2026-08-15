/**
 * compat/dsh-0.1/subagent — the minimal worker seam (PLAN §5.13 / D7).
 *
 * Validated in Phase 0 spike-5: capability validation is fail-loud, depth is
 * capped, tool scoping uses `toolFilter`, delegated approval is pinned to
 * 'never'. The adapter does NOT depend on any undeclared `AgentOptions.role`
 * field.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
  SubagentDepthError,
  type SubagentRuntime,
  type SubagentStartRequest,
} from "@deepseek-ai/dsh-subagent";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export {
  SubagentDepthError,
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
};
export type { SubagentRuntime, SubagentStartRequest, ToolRestriction };

/** Tool allowlist for a Magic worker (read-only maintenance surface). */
export const MAGIC_WORKER_READONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "fs_search",
];

/** Tool allowlist for tool-requiring Sidekick workers. */
export const MAGIC_SIDEKICK_TOOLS: readonly string[] = [
  ...MAGIC_WORKER_READONLY_TOOLS,
  "ctx_search",
];

/**
 * Build the one-shot spawn request for a Magic worker: depth pinned, tools
 * allowlisted, persona marker, parent-bound cancellation.
 */
export function magicWorkerRequest(
  parent: Agent,
  opts: {
    label: string;
    prompt: ContentBlock[];
    allow: readonly string[];
    maxDepth?: number;
    signal: AbortSignal;
    persona?: string;
  },
): SubagentStartRequest {
  return {
    label: opts.label,
    prompt: opts.prompt,
    parent,
    signal: opts.signal,
    maxDepth: opts.maxDepth ?? 1,
    toolFilter: { allow: [...opts.allow] } satisfies ToolRestriction,
    ...(opts.persona === undefined ? {} : { persona: opts.persona }),
  };
}

/** Resolve the subagents service from a context (undefined-safe read). */
export function subagentsOf(ctx: Context): SubagentRuntime | undefined {
  return ctx.get("subagents") as SubagentRuntime | undefined;
}
