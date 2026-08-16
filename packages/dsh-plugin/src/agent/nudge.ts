/**
 * agent/nudge — ctx_reduce Channel-1 / Channel-2 nudges (Pi parity).
 *
 * Pi appends `<system-reminder>` blocks in-turn (Channel 1) and escalates to a
 * synthetic-user ceiling interrupt (Channel 2). DSH follows its "inject, do not
 * rewrite" philosophy: the decision functions and reminder bodies are the
 * shared core's (`ctx-reduce-nudge`), and delivery rides `agent.inject(...)`
 * (visible on the next pre-step batch), deduplicated by a `mc-nudge:<kind>`
 * watermark on the live surface. State persistence (last_nudge_undropped /
 * last_nudge_level / channel2_nudge_state) uses the shared storage-meta
 * accessors, so a Pi↔DSH session pair shares cadence.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  CHANNEL1_FLOOR_TOKENS,
  decideChannel1,
  shouldTriggerChannel2,
  type ToolReclaimHint,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { getActiveTagTokenAggregate } from "@magic-context/core/features/magic-context/storage-tags";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import {
  getChannel2NudgeState,
  getLastNudgeLevel,
  getLastNudgeUndropped,
  setChannel2NudgeState,
  setLastNudgeLevel,
  setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { magicUserMessage, type MagicMessageSource } from "../compat/dsh-0.1/session";

/** Scan the session event log for the live context window + last input usage. */
export function scanSessionMetrics(agent: Agent): {
  lastInputTokens: number;
  contextWindow: number | undefined;
} {
  let lastInputTokens = 0;
  let contextWindow: number | undefined;
  const events = (agent.session as { events?: readonly unknown[] }).events ?? [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const e = event as { type?: unknown; data?: unknown };
    if (e.type === "request/context") {
      const cw = (e.data as { contextWindow?: unknown } | undefined)?.contextWindow;
      if (typeof cw === "number" && cw > 0) contextWindow = cw;
      continue;
    }
    if (e.type === "assistant/message") {
      const usage = (e.data as { usage?: unknown } | undefined)?.usage as
        | { inputTokens?: unknown }
        | undefined;
      if (usage !== undefined && typeof usage === "object") {
        const input = (usage as { inputTokens?: unknown }).inputTokens;
        if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
          lastInputTokens = input;
        }
      }
    }
  }
  return { lastInputTokens, contextWindow };
}

/** Oldest reclaimable tool tags, as reclaim hints (max 4, oldest first). */
function oldestReclaimableToolTags(tags: readonly TagEntry[], protectedTags: number): ToolReclaimHint[] {
  const active = [...tags]
    .filter((t) => t.type === "tool" && t.status === "active")
    .sort((a, b) => a.tagNumber - b.tagNumber);
  const protectedSet =
    protectedTags > 0
      ? new Set(
          [...tags]
            .filter((t) => t.type === "tool" && t.status === "active")
            .map((t) => t.tagNumber)
            .sort((a, b) => b - a)
            .slice(0, protectedTags),
        )
      : new Set<number>();
  return active.filter((t) => !protectedSet.has(t.tagNumber)).slice(0, 4)
    .map((t) => ({ tagNumber: t.tagNumber, toolName: t.toolName }));
}

function injectNudge(
  agent: Agent,
  sessionId: string,
  kind: "channel1" | "channel2",
  text: string,
): void {
  // Dedup: only inject when the surface has no live mc-nudge:<kind> node.
  const marker = `mc-nudge:${kind}`;
  const events = (agent.session as { events?: readonly unknown[] }).events ?? [];
  if (
    events.some((event) => {
      if (event === null || typeof event !== "object") return false;
      const e = event as { data?: { source?: { plugin?: unknown; messageId?: unknown } } };
      const source = e.data?.source;
      return source?.plugin === "magic-context" && source?.messageId === marker;
    })
  ) {
    return;
  }
  const source: MagicMessageSource = {
    kind: "plugin",
    plugin: "magic-context",
    messageId: marker,
  };
  const message = magicUserMessage(text, source, []);
  (agent as unknown as { inject?: (m: unknown) => void }).inject?.(message);
}

export interface NudgeOptions {
  /** execute-threshold percentage (default 65). */
  threshold?: number;
  /** Protected-tag tail (default 20). */
  protectedTags?: number;
  /** Override context window (default: scan the session events). */
  contextWindow?: number;
  /** Logger sink (optional). */
  log?: (message: string) => void;
}

/**
 * Evaluate both nudge channels for a magic session. Runs inside the pre-step
 * after plan application; never throws (fail-open).
 */
export function maybeNudgeChannels(
  db: Database,
  sessionId: string,
  agent: Agent,
  opts: NudgeOptions = {},
): void {
  try {
    const threshold = Math.max(0, opts.threshold ?? 65);
    const protectedTags = Math.max(0, opts.protectedTags ?? 20);
    const { lastInputTokens, contextWindow: scanWindow } = scanSessionMetrics(agent);
    const contextWindow = opts.contextWindow ?? scanWindow ?? 1_000_000;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return;

    const agg = getActiveTagTokenAggregate(db, sessionId, protectedTags);
    const reclaimable = agg.toolOutput ?? 0;

    // ── Channel 1: in-turn gentle/firm/urgent reminder ──
    if (reclaimable >= CHANNEL1_FLOOR_TOKENS) {
      const workingWindowTokens = Math.round((contextWindow * threshold) / 100);
      const pressure = lastInputTokens > 0 ? lastInputTokens / contextWindow : 0;
      const decision = decideChannel1({
        undroppedTokens: reclaimable,
        pressure,
        estimatedInputTokens: lastInputTokens + reclaimable,
        workingWindowTokens,
        lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
        lastNudgeLevel: getLastNudgeLevel(db, sessionId),
        hasRecentReduce: false,
      });
      setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
      setLastNudgeLevel(db, sessionId, decision.nextLastNudgeLevel);
      if (decision.fire) {
        const tags = getTagsBySession(db, sessionId);
        const hint = oldestReclaimableToolTags(tags, protectedTags);
        const reminder = buildChannel1Reminder(decision.level, decision.undroppedTokens, hint);
        injectNudge(agent, sessionId, "channel1", reminder);
        opts.log?.(`[magic-context] channel1 nudge fired: level=${decision.level} reclaimable~${Math.round(reclaimable / 1000)}k`);
      }
    }

    // ── Channel 2: ceiling escalation (one-shot per session) ──
    const usable = Math.max(0, Math.round((contextWindow * threshold) / 100) - lastInputTokens + agg.conversation + agg.toolCall);
    if (shouldTriggerChannel2({ reclaimableTokens: reclaimable, usableTokens: usable })) {
      const state = getChannel2NudgeState(db, sessionId);
      if (state === "") {
        const tags = getTagsBySession(db, sessionId);
        const hint = oldestReclaimableToolTags(tags, protectedTags);
        const reminder = buildChannel2Reminder(reclaimable, hint);
        // 一次性发送语义：注入前占位的状态机（pending → delivered）。
        setChannel2NudgeState(db, sessionId, "delivered");
        injectNudge(agent, sessionId, "channel2", reminder);
        opts.log?.(`[magic-context] channel2 nudge delivered: reclaimable~${Math.round(reclaimable / 1000)}k`);
      }
    }
  } catch {
    // Nudges must never break the pre-step chain (fail-open).
  }
}
