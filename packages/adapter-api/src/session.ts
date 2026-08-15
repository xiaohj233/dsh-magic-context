/**
 * HarnessSession — the explicit Host-neutral session surface an adapter
 * implements so core historian/dreamer/transcript paths can read raw history,
 * append compaction markers, and attribute stable message ids, without knowing
 * whether the harness is Pi or DSH.
 *
 * Maps the Pi primitives from magic-reference §10 that the shared core consumes
 * (getBranch → read raw messages, appendCompaction, stable ids, usage fields):
 *   session.id               ← Pi `ctx.sessionManager.getSessionId()`
 *   session.readBranch       ← Pi `ctx.sessionManager.getBranch(fromId?)`
 *   session.appendCompaction ← Pi `ctx.sessionManager.appendCompaction(...)`
 *   session.stableId         ← Pi `resolvePiStableId`
 *   session.modelMeta        ← Pi `message.usage/provider/model` extraction
 */
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

/** Raw-message source contract (core `withRawMessageProvider`). */
export type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

/** Model-visible usage metadata extracted from a harness-native message. */
export interface HarnessMessageUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
}

/** One compaction marker insertion (Pi appendCompaction equivalent). */
export interface HarnessCompactionInput {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly details?: unknown;
  readonly fromHook?: boolean;
}

export interface HarnessSession {
  /** Canonical Magic session key for this session. */
  readonly id: string;
  /** DSH-native session id (invertible from {@link id}). */
  readonly nativeId: string;
  /** Read the session branch as raw messages (contiguous, ordered). */
  readBranch(): RawMessage[];
  /** Append a Magic-owned compaction marker into the native session stream. */
  appendCompaction(input: HarnessCompactionInput): string | undefined;
  /** Resolve a stable message identity for a message at `index` (or by ref). */
  stableId(index: number, ref?: unknown): string;
  /** Extract usage metadata from a native message, when present. */
  usageOf(message: unknown): HarnessMessageUsage | null;
  /** True when the session is mid-turn (historian boundary rules). */
  isMidTurn(): boolean;
}
