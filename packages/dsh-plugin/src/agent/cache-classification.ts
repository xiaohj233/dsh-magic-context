/**
 * agent/cache-classification — SOFT+/SOFT/HARD cache classification (Phase 3,
 * PLAN §4.3).
 *
 * Cache conclusions are grounded in the ACTUAL provider-visible message
 * arrays: the byte-hash of the serialized system/tools/messages prefix and the
 * first content-diff between consecutive requests. Provider counters
 * (cacheReadTokens etc.) are auxiliary evidence only.
 *
 *   SOFT+  — changes only append to the tail: the whole prefix is reused.
 *   SOFT   — mid-range replacement at/after the m1 boundary: invalidation
 *            starts at the first changed token, bounded to the changed range.
 *   HARD   — only the enumerated triggers (baseline merge, model/system/tool
 *            changes, TTL expiry, overflow recovery) may produce a large
 *            invalidation; anything else mid-range must NOT classify hard.
 */
import type { MutationOp } from "./transcript";

export type CacheClass = "soft-plus" | "soft" | "hard";

export interface FirstDiff {
  /** Index of the first message whose content differs (-1 = identical). */
  readonly index: number;
  /** True when every difference sits at/after the previous tail (prefix reuse). */
  readonly tailAppend: boolean;
  /** First/last changed message indices (message-level range; null = identical). */
  readonly range: { readonly start: number; readonly end: number } | null;
}

/** Serialize one message to the bytes whose hash the cache prefix is keyed on. */
export function messageBytes(message: unknown): string {
  return JSON.stringify(message);
}

/** Hash of the serialized prefix up to and including `count` messages. */
export function prefixHash(messages: readonly unknown[], count: number): string {
  let hash = 0;
  for (let i = 0; i < count && i < messages.length; i += 1) {
    const bytes = messageBytes(messages[i]);
    for (let j = 0; j < bytes.length; j += 1) {
      hash = (hash * 31 + bytes.charCodeAt(j)) | 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * First content diff between two message arrays. `-1` when identical.
 * tailAppend is true when the arrays share a common prefix of length
 * min(len) and the extra messages are all in `after` (the tail grew).
 */
export function firstDiffIndex(before: readonly unknown[], after: readonly unknown[]): number {
  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i += 1) {
    if (messageBytes(before[i]) !== messageBytes(after[i])) return i;
  }
  return before.length === after.length ? -1 : common;
}

export function compareSurfaces(before: readonly unknown[], after: readonly unknown[]): FirstDiff {
  const index = firstDiffIndex(before, after);
  if (index < 0) return { index: -1, tailAppend: false, range: null };
  const tailAppend = index >= before.length;
  // The changed range: from the first differing message to the last
  // differing/extra message.
  let end = after.length - 1;
  while (end >= index && messageBytes(after[end]) === messageBytes(before[end])) {
    end -= 1;
  }
  return { index, tailAppend, range: { start: index, end: Math.max(index, end) } };
}

// ── HARD triggers (the enumerated set; PLAN §4.3) ───────────────────────────

export type HardTrigger =
  | "baseline-merge"
  | "model-change"
  | "system-change"
  | "tool-change"
  | "ttl-expiry"
  | "overflow-recovery";

export const HARD_TRIGGERS: readonly HardTrigger[] = [
  "baseline-merge",
  "model-change",
  "system-change",
  "tool-change",
  "ttl-expiry",
  "overflow-recovery",
];

/** Canonical materialize reasons that MUST classify hard (design §9.1). */
const HARD_REASONS: ReadonlySet<string> = new Set([
  "baseline-merge",
  "model_change",
  "system_hash",
  "tool_set_hash",
  "ttl_idle",
  "ttl_expiry",
  "overflow_recovery",
  "pressure_refold",
  "max_mutation_id",
  "upgrade_state",
  "profile_transition",
]);

/** Whether a materialize-reason string is one of the enumerated HARD triggers. */
export function isHardTrigger(reason: string): boolean {
  return HARD_REASONS.has(reason) || (HARD_TRIGGERS as readonly string[]).includes(reason);
}

/** Enumerate which HARD triggers are present in the given meta signals. */
export function hardTriggersFor(meta: {
  readonly systemPromptHash?: string;
  readonly modelKey?: string;
  readonly toolSetHash?: string;
  readonly cacheExpired?: boolean;
  readonly overflowRecovered?: boolean;
}): readonly HardTrigger[] {
  const out: HardTrigger[] = [];
  if (typeof meta.systemPromptHash === "string" && meta.systemPromptHash.length > 0) {
    out.push("system-change");
  }
  if (typeof meta.modelKey === "string" && meta.modelKey.length > 0) {
    out.push("model-change");
  }
  if (typeof meta.toolSetHash === "string" && meta.toolSetHash.length > 0) {
    out.push("tool-change");
  }
  if (meta.cacheExpired === true) out.push("ttl-expiry");
  if (meta.overflowRecovered === true) out.push("overflow-recovery");
  return out;
}

// ── plan-level classification ────────────────────────────────────────────────

/**
 * Classify a MutationPlan against the surface geometry.
 *
 * @param ops - the plan ops.
 * @param m0EndIndex - one-past-the-last node index of the m0 baseline (0 when
 *   no baseline is present). Ops at/after this index are SOFT-eligible;
 *   ops covering baseline nodes are HARD.
 * @param surfaceNodeCount - surface node count at plan time.
 */
export function classifyPlan(
  ops: readonly Pick<MutationOp, "start" | "end" | "cacheClass" | "reason">[],
  m0EndIndex: number,
  surfaceNodeCount: number,
): CacheClass {
  if (ops.length === 0) return "soft-plus";
  let worst: CacheClass = "soft-plus";
  for (const op of ops) {
    let opClass: CacheClass;
    if (op.cacheClass === "hard" || isHardTrigger(op.reason)) {
      opClass = "hard";
    } else if (op.start >= surfaceNodeCount) {
      // Insertion at/after the tail — prefix reuse preserved.
      opClass = "soft-plus";
    } else if (op.end <= m0EndIndex) {
      // The op touches the baseline — a large-range invalidation.
      opClass = "hard";
    } else {
      opClass = "soft";
    }
    if (opClass === "hard") return "hard";
    if (opClass === "soft") worst = "soft";
  }
  return worst;
}
