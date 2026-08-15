/**
 * compat/dsh-0.1/tools — tool registration and worker tool scoping.
 *
 * Validated in Phase 0 spike-5: `defineTool` (strict schema + output render),
 * `tools.restrict({allow})` allowlist semantics (visible catalog + execution
 * both masked, `UNKNOWN_TOOL` for masked tools), unknown names fail loud.
 */
import {
  defineTool,
  type ToolDefinition,
  type ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";

export { defineTool };
export type { ToolDefinition, ToolRuntime };

/** Register a tool globally (host plane) and return its disposer. */
export function registerTool(ctx: Context, tool: ToolDefinition): () => void {
  const tools = ctx.get("tools") as ToolRuntime | undefined;
  if (tools === undefined) throw new Error("tools service unavailable");
  return tools.register(tool);
}

/** A tool-scoping mask for a worker child (allowlist semantics). */
export interface ToolAllowlist {
  readonly allow: readonly string[];
}

/**
 * Apply an allowlist restriction in a scoped (agent) context. Returns the
 * disposer that lifts it. `scopeCtx` must carry the agent scope (the child's
 * creation window).
 */
export function restrictToolsTo(
  scopeCtx: Context,
  allow: readonly string[],
): () => void {
  const tools = scopeCtx.get("tools") as ToolRuntime | undefined;
  if (tools === undefined) throw new Error("tools service unavailable");
  return tools.restrict({ allow: [...allow] });
}
