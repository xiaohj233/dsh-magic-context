/**
 * Harness identity boundary for the DSH adapter.
 *
 * Magic Context's core declares a CLOSED `HarnessId = "opencode" | "pi"`
 * (packages/plugin/src/shared/harness.ts). The DSH port must not modify core
 * (project constraint), so this module is the single place that:
 *  1. declares the DSH harness identity as a runtime string "dsh";
 *  2. crosses the closed-union type boundary with an explicit, documented cast
 *     (runtime values are plain strings; the core persists them into TEXT
 *     columns and never runtime-switches on the unknown branch);
 *  3. derives the canonical Magic session key for a DSH session:
 *     `dsh:<home-hash>:<dsh-session-id>` (PLAN §2 SQLite row note), which is
 *     INVERTIBLE — the DSH-native session id is recoverable by parsing, so no
 *     separate external identity map table is required (recorded deviation).
 *
 * Call sites must invoke `setDshHarness()` before the first database write,
 * exactly like the Pi adapter calls `setHarness("pi")`.
 */
import { setHarness, getHarness } from "@magic-context/core/shared/harness";

/** DSH harness identity as persisted into the shared SQLite `harness` column. */
export const DSH_HARNESS = "dsh" as const;

/**
 * Narrow the closed core union to the DSH string. This is the ONLY place the
 * type boundary is crossed; core code compiled against `HarnessId` never sees
 * the widening, and at runtime the value is an ordinary string.
 */
export type DshHarnessId = "dsh";

/** Lock the harness identity to "dsh" (idempotent; throws on a different value). */
export function setDshHarness(): void {
  setHarness(DSH_HARNESS as Parameters<typeof setHarness>[0]);
}

/** Current harness identity (runtime string). */
export function currentHarness(): string {
  return getHarness();
}

/** Canonical Magic session key namespace prefix (compatibility.json database.sessionKeyNamespace). */
export const DSH_SESSION_KEY_PREFIX = "dsh";

/** Separator between canonical-key segments. */
const SEP = ":";

/**
 * Derive the canonical Magic session key for a DSH session.
 * @param homeHash - stable short hash of the DSH home (e.g. first 8 hex chars of sha256).
 * @param dshSessionId - the DSH-native session id (header.id).
 * @returns `dsh:<homeHash>:<dshSessionId>`.
 */
export function canonicalSessionKey(homeHash: string, dshSessionId: string): string {
  if (homeHash.length === 0) throw new Error("canonicalSessionKey: homeHash must be non-empty");
  if (dshSessionId.length === 0) throw new Error("canonicalSessionKey: dshSessionId must be non-empty");
  if (dshSessionId.includes(SEP)) {
    throw new Error(`canonicalSessionKey: dshSessionId must not contain "${SEP}"`);
  }
  return `${DSH_SESSION_KEY_PREFIX}${SEP}${homeHash}${SEP}${dshSessionId}`;
}

/** Parsed canonical DSH session key. */
export interface ParsedDshSessionKey {
  readonly homeHash: string;
  readonly dshSessionId: string;
}

/**
 * Invert {@link canonicalSessionKey}. Returns undefined for keys that are not
 * in the canonical DSH form (e.g. an OpenCode or Pi session id, or a key from
 * a different home hash).
 */
export function parseDshSessionKey(key: string): ParsedDshSessionKey | undefined {
  if (typeof key !== "string") return undefined;
  const first = key.indexOf(SEP);
  if (first <= 0) return undefined;
  if (key.slice(0, first) !== DSH_SESSION_KEY_PREFIX) return undefined;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1 || second === key.length - 1) return undefined;
  const homeHash = key.slice(first + 1, second);
  const dshSessionId = key.slice(second + 1);
  if (homeHash.length === 0 || dshSessionId.length === 0) return undefined;
  return { homeHash, dshSessionId };
}
