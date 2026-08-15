/**
 * Subpath entry: `@xiao_hj909/magic-context-for-dsh/remote` — the Typert Remote row
 * the bundle patch mounts on the HOST plane. Registers the `magicContext/status`
 * endpoint against the live host service; skipped fail-open when the Typert
 * registry is absent (headless profiles).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { MagicContextHostService } from "../index";
import { registerMagicContextRemote } from "../host/remote";

export const name = "magic-context-remote";
export const inject = ["magicContextHost", "typert"];

export function apply(ctx: Context): void {
  const host = ctx.get("magicContextHost") as MagicContextHostService | undefined;
  if (host === undefined) {
    throw new Error("magic-context-remote: magicContextHost service unavailable");
  }
  const disposer = registerMagicContextRemote(ctx, host);
  if (disposer === undefined) {
    ctx.logger?.info?.("[magic-context] typert registry absent; magicContext remote skipped");
    return;
  }
  ctx.effect(() => disposer);
}

export default { name, inject, apply };
