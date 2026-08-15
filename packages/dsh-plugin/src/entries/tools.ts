/**
 * Subpath entry: `@xiao_hj909/magic-context-for-dsh/tools` — tool-registration
 * plugin row (optional; the agent row can register tools directly).
 */
import type { Context } from "@deepseek-ai/cordis";
import { registerCtxTools, type CtxToolsOptions } from "../agent/tools";

export const name = "magic-context-tools";

export function apply(ctx: Context, config: CtxToolsOptions = {}): void {
  registerCtxTools(ctx, config);
}

export default { name, apply };
