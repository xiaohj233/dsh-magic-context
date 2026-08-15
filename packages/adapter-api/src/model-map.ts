/**
 * DSH model-geometry facade (PLAN §2 "模型几何").
 *
 * The shared magic-context config stores model references in the canonical
 * (OpenCode) form. Each non-OpenCode harness owns an explicit provider-prefix
 * translation (see core `shared/harness-provider-map.ts` for the Pi pair).
 * DSH's native route is `deepseek-official/<model>` (the base composition's
 * default adapter) plus any provider profiles configured in settings; this
 * module owns the DSH↔canonical edge transforms.
 *
 * NOTE: the canonical provider vocabulary is finalized against the DSH
 * reference in Phase 2 (knowledge mode preview) — the starter map below is
 * the identity-plus-deepseek surface and is unit-tested as such.
 */

/** Canonical provider prefix used by Magic's shared config for DeepSeek routes. */
export const CANONICAL_DEEPSEEK_PROVIDER = "deepseek";

/** DSH-native provider prefix for the official DeepSeek adapter. */
export const DSH_DEEPSEEK_PROVIDER = "deepseek-official";

const DSH_TO_CANONICAL_PROVIDER: Readonly<Record<string, string>> = {
  [DSH_DEEPSEEK_PROVIDER]: CANONICAL_DEEPSEEK_PROVIDER,
};

const CANONICAL_TO_DSH_PROVIDER: Readonly<Record<string, string>> = {
  [CANONICAL_DEEPSEEK_PROVIDER]: DSH_DEEPSEEK_PROVIDER,
};

/** Remap only the provider prefix (text before the first "/"), preserving the
 *  model id verbatim. No "/", empty provider, or unmapped provider → unchanged.
 *  Own-property lookups only (prototype-collision safe). */
function remapProviderPrefix(ref: string, map: Readonly<Record<string, string>>): string {
  if (typeof ref !== "string") return ref;
  const slash = ref.indexOf("/");
  if (slash <= 0) return ref;
  const provider = ref.slice(0, slash);
  if (!Object.hasOwn(map, provider)) return ref;
  return `${map[provider]}${ref.slice(slash)}`;
}

/** DSH-native `provider/model` → canonical (OpenCode) shared-config form. */
export function dshModelRefToCanonical(ref: string): string {
  return remapProviderPrefix(ref, DSH_TO_CANONICAL_PROVIDER);
}

/** Canonical shared-config `provider/model` → DSH-native form. Idempotent. */
export function resolveModelRefForDsh(ref: string): string {
  return remapProviderPrefix(dshModelRefToCanonical(ref), CANONICAL_TO_DSH_PROVIDER);
}

/**
 * DSH context-window geometry (Phase 2 fills exact values from `tokenMeter` +
 * the routed model's advertised window; the seam is what Phase 1 pins).
 */
export interface DshWindowGeometry {
  /** Advertised model context window in tokens, when known. */
  readonly contextWindow?: number;
  /** Output reservation floor applied by the adapter. */
  readonly outputFloorTokens: number;
}
