/**
 * @xiao_hj909/magic-context-for-dsh-adapter — adapter-api.
 *
 * Stable Host-neutral facade over the shared Magic Context core for harness
 * adapters. Initial surface (Phase 1): harness identity boundary, canonical
 * session identity, DSH model geometry, and the explicit HarnessRuntime /
 * HarnessSession contracts the DSH adapter implements.
 *
 * Import-boundary rule (PLAN §2): DSH packages depend only on this package
 * and the compat layer; this package re-exports/wraps core, never copies it.
 */
export {
  DSH_HARNESS,
  DSH_SESSION_KEY_PREFIX,
  canonicalSessionKey,
  currentHarness,
  parseDshSessionKey,
  setDshHarness,
} from "./harness";
export type { DshHarnessId, ParsedDshSessionKey } from "./harness";

export {
  CANONICAL_DEEPSEEK_PROVIDER,
  DSH_DEEPSEEK_PROVIDER,
  dshModelRefToCanonical,
  resolveModelRefForDsh,
} from "./model-map";
export type { DshWindowGeometry } from "./model-map";

export type { HarnessRuntime } from "./runtime";

export {
  type HarnessCompactionInput,
  type HarnessMessageUsage,
  type HarnessSession,
  type RawMessage,
} from "./session";
