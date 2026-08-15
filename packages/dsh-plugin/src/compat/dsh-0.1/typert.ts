/**
 * compat/dsh-0.1/typert — the MagicContext Remote seam.
 *
 * Validated in Phase 0 spike-4: strict descriptors + codecs, gateway dispatch,
 * `typertRemote` service binding, error envelopes, fiber-owned registration.
 * The Client half and the standalone Dashboard consume these endpoints.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import type TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import type {
  TypertContribution,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-registry/types";

export type {
  InvocationDescriptor,
  TypertContribution,
  TypertRegistry,
  TypertSchema,
};

/** Wire namespace of every MagicContext Remote endpoint (compatibility.json). */
export const MAGIC_CONTEXT_REMOTE_NAMESPACE = "magicContext";

/** Register one contribution; returns the exact disposer. */
export function registerRemoteContribution(
  ctx: Context,
  contribution: TypertContribution,
): () => Promise<void> {
  const typert = ctx.get("typert") as TypertRegistry | undefined;
  if (typert === undefined) throw new Error("typert registry unavailable");
  return typert.register(contribution);
}
