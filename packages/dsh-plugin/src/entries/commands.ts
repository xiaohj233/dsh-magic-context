/**
 * Subpath entry: `@xiao_hj909/magic-context-for-dsh/commands` — command-registration
 * plugin row (optional; the agent row can register commands directly).
 */
import type { Context } from "@deepseek-ai/cordis";
import { registerCtxCommands, type CtxCommandsOptions } from "../agent/commands";

export const name = "magic-context-commands";

export function apply(ctx: Context, config: CtxCommandsOptions = {}): void {
  registerCtxCommands(ctx, config);
}

export default { name, apply };
