/**
 * agent/transcript — DshTranscript (Phase 3 slice T).
 *
 * Read-only view of a DSH session plus MutationPlan derivation. Mirrors the
 * Pi adapter's mapping semantics (`pi-plugin/read-session-pi.ts`) and the
 * design doc `docs/phase3-design.md` §3 / §9.9-9.12:
 *
 *   1. `readDshTranscript` — the model-visible transcript (surface nodes →
 *      core `RawMessage[]`), with a reversible event-seq ↔ ordinal map.
 *   2. `deriveMutationPlan` — runs the shared core pipeline stages
 *      (temporal markers → tagTranscript → applyPendingOperations →
 *      applyFlushedStatuses → reasoning replay) through a RECORDING
 *      transcript/target layer, producing `MutationOp`s that the coordinator
 *      slice (C) will apply through the surface CAS. This module NEVER
 *      mutates the view's messages or any source array (D4).
 *
 * Recording design: `RecordingPart` wraps each RawMessage part and records
 * every content mutation (`from` → `to`) on its owning `RecordingMessage`;
 * `RecordingTagTarget` implements the core `TagTarget` interface by
 * delegating to the shared tagTranscript-built targets (which call the
 * recording parts), so `applyPendingOperations`/`applyFlushedStatuses` run
 * unchanged and their effects land in the plan instead of the wire. At the
 * end, each dirty message coalesces into ONE replace op (per design §3:
 * "同一消息多个变更 → 合并为单个 replace op").
 *
 * Scope: tags / drops / reasoning / temporal stages only. The remaining
 * stages (nudge / decay / caveman / historian / recomp / wrapup / emergency)
 * arrive with later slices; stage lists are plain arrays so the pipeline is
 * extensible.
 *
 * Known Phase-4 handoffs (documented at each site):
 *   - reasoning clearing is REPLAY-only (watermark reads); the watermark-
 *     advancing clear pass lands with the coordinator, which owns pass type.
 *   - `minimalCacheClassForOp` is a temporary stand-in for the
 *     cache-classification slice (§6); the official `classifyPlan` replaces
 *     it at integration.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import {
  applyFlushedStatuses,
  applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import type {
  MessageLike,
  TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import type { ToolDropResult } from "@magic-context/core/hooks/magic-context/tool-drop-target";
import {
  byteSize,
  peelLeadingMcTagNotation,
  stripTagPrefix,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
  formatGap,
  TEMPORAL_MARKER_PATTERN,
  temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";
import {
  getOrCreateSessionMeta,
  getPendingOps,
  getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
  Transcript,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartKind,
} from "@magic-context/core/shared/transcript";
import type { KnowledgeSessionView } from "./knowledge-gate";
import {
  deriveEventMessage,
  type SessionEvent,
} from "../compat/dsh-0.1/session";

/* ─────────────────────────────── public types ─────────────────────────────── */

/** Input to {@link readDshTranscript}: the DSH session structural view. */
export interface DshTranscriptInput {
  readonly session: KnowledgeSessionView & {
    readonly header: { readonly id?: string; readonly cwd?: string };
  };
  readonly canonicalSessionId: string;
}

/**
 * Read-only transcript view (design §3). `messages` are the model-visible
 * (surface) messages in surface order; `surfaceNodes` are the DSH surface
 * event seqs they were derived from. `inputDigest` =
 * sha256(JSON(messages))[0:16]; `sourceWatermark` = the last log seq covered;
 * `generation` = surface.replaceGeneration snapshot.
 *
 * Each view message carries NON-ENUMERABLE metadata (invisible to
 * JSON.stringify, so the digest is unaffected): its surface node span
 * (read via {@link messageNodeSpan}) and its knowledge-baseline flag (read
 * via {@link isKnowledgeBaselineMessage}). The mutation plan uses those to
 * index ops into `surfaceNodes` and to keep the m[0]/m[1] knowledge baseline
 * out of the tag/drop pipeline (see `buildRecordingTranscript`).
 */
export interface DshTranscriptView {
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly messages: readonly RawMessage[];
  readonly surfaceNodes: readonly number[];
}

export type MutationKind =
  | "tags"
  | "drops"
  | "reasoning"
  | "temporal"
  | "nudge"
  | "decay"
  | "caveman"
  | "historian"
  | "recomp"
  | "wrapup"
  | "emergency";

/**
 * Temporary local cache-class union. The cache-classification slice
 * (`src/agent/cache-classification.ts`) owns the official `CacheClass`;
 * until it lands, `minimalCacheClassForOp` is the stand-in.
 */
export type CacheClass = "soft-plus" | "soft" | "hard";

export interface MutationOp {
  readonly kind: MutationKind;
  /** Surface node range [start, end) (pre-replacement indices into view.surfaceNodes). */
  readonly start: number;
  readonly end: number;
  /** Replacement text: the full Magic-rendered content of the user-role message. */
  readonly replacement: string;
  readonly cacheClass: CacheClass;
  readonly reason: string;
  /** DSH event seqs of every shadowed surface node (sourceEventSeqs coverage). */
  readonly shadowedSeqs: readonly number[];
}

export interface MutationPlan {
  readonly opId: string;
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly ops: readonly MutationOp[];
}

/** Reversible DSH event seq ↔ ordinal mapping (ctx_expand traceability). */
export interface DshOrdinalMap {
  readonly ordinalToSeq: ReadonlyMap<number, number>;
  readonly seqToOrdinal: ReadonlyMap<number, number>;
}

/** Plan-derivation context (design §3). */
export interface PlanContext {
  readonly db: Database;
  /** Newest-N active tags exempt from pending drops (applyPendingOperations). */
  readonly protectedTags?: number;
  /** Injectable clock; reserved for later stages (decay/nudge). Unused by this slice. */
  readonly now?: () => number;
}

/* ────────────────────────────── event accessors ───────────────────────────── */

interface EventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly time?: unknown;
  readonly data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEvent(value: unknown): EventLike | null {
  return isRecord(value) ? (value as unknown as EventLike) : null;
}

function seqOf(event: EventLike): number {
  return typeof event.seq === "number" ? event.seq : -1;
}

function timeOf(event: EventLike): number | undefined {
  return typeof event.time === "number" ? event.time : undefined;
}

function dataOf(event: EventLike): Record<string, unknown> | null {
  return isRecord(event.data) ? event.data : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/* ───────────────────────────── message conversion ─────────────────────────── */

/** `synth-user-` prefix for synthetic tail user messages (design §9.9). */
export const SYNTH_USER_ID_PREFIX = "synth-user-";

function isSyntheticUserMessage(message: RawMessage): boolean {
  return typeof message.id === "string" && message.id.startsWith(SYNTH_USER_ID_PREFIX);
}

/** True for Magic-injected knowledge messages (source.plugin === 'magic-context'). */
function isKnowledgeMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "plugin" && source.plugin === "magic-context";
}

/**
 * True for DSH skill-catalog user messages (dsh-tool-skill's durable catalog
 * reminder: `source.kind === 'skill-catalog'` with `entries`). These must be
 * treated like knowledge baselines — excluded from the tag/drop pipeline — or
 * the §N§ prefix injection forces a surface replace each round, the catalog's
 * original event seq leaves the visible surface, `catalogHistory` can no
 * longer find a visible digest, and dsh-tool-skill re-injects the catalog on
 * every subsequent pre-step (the per-round <system-reminder> loop).
 */
function isSkillCatalogMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "skill-catalog";
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** User content blocks → `{type:"text", text}` parts; image/other blocks dropped (§9.9). */
function userTextParts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    parts.push({ type: "text", text: block.text });
  }
  return parts;
}

/**
 * Assistant content blocks → text parts + `{type:"tool", state:{input}}` parts
 * for tool calls (Pi `synthesizeAssistantParts` mirror). With
 * `keepReasoning`, `{type:"reasoning", text}` blocks are retained as parts so
 * the reasoning stage can plan their removal — the pure conversion drops them
 * (§9.9 "assistant thinking 丢弃"). Images/unknown dropped.
 */
function assistantParts(
  message: Record<string, unknown>,
  keepReasoning: boolean,
  toolNameByCallId: Map<string, string>,
): unknown[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool-call" && typeof block.id === "string") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      if (typeof block.name === "string" && block.name.length > 0) {
        toolNameByCallId.set(block.id, block.name);
      }
      parts.push({
        type: "tool",
        tool: name,
        callID: block.id,
        state: { input: parseToolArguments(block.arguments) },
      });
    } else if (
      keepReasoning &&
      (block.type === "reasoning" || block.type === "thinking") &&
      typeof block.text === "string"
    ) {
      parts.push({ type: "reasoning", text: block.text });
    }
  }
  return parts;
}

/**
 * ToolResultMessage → one `{type:"tool", tool, callID, state:{output}}` part;
 * multiple text fragments joined with "\n" (Pi `synthesizeToolResultParts`
 * mirror). The tool name resolves from `tool/call` events (or assistant
 * tool-call blocks) by callId; falls back to "unknown".
 */
function toolResultParts(
  message: Record<string, unknown>,
  toolNameByCallId: ReadonlyMap<string, string>,
): unknown[] {
  const content = Array.isArray(message.content) ? message.content : [];
  let callId: string | undefined;
  const source = isRecord(message.source) ? message.source : null;
  if (source && typeof source.callId === "string" && source.callId.length > 0) {
    callId = source.callId;
  }
  if (!callId) {
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "tool-result" &&
        typeof block.toolCallId === "string" &&
        block.toolCallId.length > 0
      ) {
        callId = block.toolCallId;
        break;
      }
    }
  }
  if (!callId) return [];

  const fragments: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool-result") continue;
    const inner = block.content;
    if (!Array.isArray(inner)) continue;
    for (const fragment of inner) {
      if (isRecord(fragment) && fragment.type === "text" && typeof fragment.text === "string") {
        fragments.push(fragment.text);
      }
    }
  }
  return [
    {
      type: "tool",
      tool: toolNameByCallId.get(callId) ?? "unknown",
      callID: callId,
      state: { output: fragments.join("\n") },
    },
  ];
}

/* ─────────────────────────── log → RawMessage walk ────────────────────────── */

/**
 * Per-message surface span: which surface node range (indices into
 * `surfaceNodes`) and event seqs a view message covers. A user message that
 * absorbed tool-result nodes covers [firstToolNode .. userNode].
 */
export interface DshMessageSpan {
  readonly nodeStart: number;
  readonly nodeEnd: number;
  readonly seqs: readonly number[];
}

/** Non-enumerable span marker attached to view messages (digest-invisible). */
export const DSH_MESSAGE_SPAN_KEY = "__dshMessageNodeSpan";
/** Non-enumerable knowledge-baseline marker attached to view messages. */
export const DSH_KNOWLEDGE_KEY = "__dshKnowledgeBaseline";
/** Non-enumerable skill-catalog marker attached to view messages. */
export const DSH_SKILL_CATALOG_KEY = "__dshSkillCatalog";

/** The surface span of a view message, or null for messages without one. */
export function messageNodeSpan(message: RawMessage): DshMessageSpan | null {
  const span = (message as unknown as Record<string, unknown>)[DSH_MESSAGE_SPAN_KEY];
  return span !== null && typeof span === "object" ? (span as DshMessageSpan) : null;
}

/** True when the view message is a Magic-context knowledge baseline (m0/m1). */
export function isKnowledgeBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_KNOWLEDGE_KEY] === true;
}

/** True when the view message is a DSH skill-catalog reminder (dsh-tool-skill). */
export function isSkillCatalogBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_SKILL_CATALOG_KEY] === true;
}

interface DshWalkResult {
  readonly messages: RawMessage[];
  readonly spans: ReadonlyArray<DshMessageSpan | null>;
  readonly knowledgeOrdinals: ReadonlySet<number>;
  readonly skillCatalogOrdinals: ReadonlySet<number>;
  readonly ordinalToSeq: Map<number, number>;
  readonly seqToOrdinal: Map<number, number>;
}

/**
 * Shared walk. With `surfaceNodes` (surface order iteration) it produces the
 * model-visible messages; with null it walks the whole log in seq order (the
 * pure Pi-mirror conversion). Both keep tool-result folding consistent with
 * their own adjacency notion.
 */
function walkDshLog(events: readonly unknown[], surfaceNodes: readonly number[] | null): DshWalkResult {
  const eventBySeq = new Map<number, EventLike>();
  const toolNameByCallId = new Map<string, string>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0 && !eventBySeq.has(seq)) eventBySeq.set(seq, event);
    const data = dataOf(event);
    if (event.type === "tool/call" && data) {
      const callId = data.callId;
      const name = data.name;
      if (typeof callId === "string" && callId.length > 0 && typeof name === "string") {
        toolNameByCallId.set(callId, name);
      }
    }
  }

  const ordered: EventLike[] =
    surfaceNodes !== null
      ? surfaceNodes
          .map((seq) => eventBySeq.get(seq))
          .filter((event): event is EventLike => event !== undefined)
      : events
          .map(asEvent)
          .filter((event): event is EventLike => event !== null);

  const messages: RawMessage[] = [];
  const spans: Array<DshMessageSpan | null> = [];
  const knowledgeOrdinals = new Set<number>();
  const skillCatalogOrdinals = new Set<number>();
  const ordinalToSeq = new Map<number, number>();
  const seqToOrdinal = new Map<number, number>();

  let pendingParts: unknown[] = [];
  let pendingSeqs: number[] = [];
  let pendingStartIndex: number | null = null;
  let pendingFirstId: string | null = null;
  let pendingFirstSeq = -1;
  let pendingFirstTime: number | undefined = undefined;

  // An assistant message carrying tool-call blocks is held back until its
  // tool results arrive: folding the results into the next user message must
  // ALSO fold the tool-call assistant node, otherwise the surface keeps an
  // assistant `tool_calls` block with no following `role=tool` message and
  // the LLM API rejects the sequence (insufficient tool messages).
  let pendingAssistant:
    | { nodeIndex: number; seq: number; parts: unknown[]; createdAt: number | null; id: string }
    | null = null;

  const resetPending = (): void => {
    pendingParts = [];
    pendingSeqs = [];
    pendingStartIndex = null;
    pendingFirstId = null;
    pendingFirstSeq = -1;
    pendingFirstTime = undefined;
    pendingAssistant = null;
  };

  /** Push one assistant message as-is (orphan tool-call / normal path). */
  const pushAssistant = (item: {
    nodeIndex: number;
    seq: number;
    parts: unknown[];
    createdAt: number | null;
    id: string;
  }): void => {
    const ordinal = messages.length + 1;
    messages.push({
      ordinal,
      id: item.id,
      role: "assistant",
      parts: item.parts,
      createdAt: item.createdAt,
      version: item.seq >= 0 ? item.seq : null,
    });
    spans.push(
      surfaceNodes !== null
        ? { nodeStart: item.nodeIndex, nodeEnd: item.nodeIndex + 1, seqs: [item.seq] }
        : null,
    );
    ordinalToSeq.set(ordinal, item.seq);
    if (item.seq >= 0) seqToOrdinal.set(item.seq, ordinal);
  };

  const flushSynthetic = (): void => {
    if (pendingParts.length === 0 && pendingAssistant === null) return;
    const ordinal = messages.length + 1;
    const seqs = [
      ...(pendingAssistant === null ? [] : [pendingAssistant.seq]),
      ...pendingSeqs,
    ];
    const start = Math.min(
      pendingStartIndex ?? Number.POSITIVE_INFINITY,
      pendingAssistant?.nodeIndex ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(start)) throw new Error("fold flush without any covered node");
    messages.push({
      ordinal,
      id: `${SYNTH_USER_ID_PREFIX}${pendingFirstId ?? "tail"}`,
      role: "user",
      parts: [...(pendingAssistant?.parts ?? []), ...pendingParts],
      createdAt: pendingFirstTime ?? null,
      version: pendingFirstSeq >= 0 ? pendingFirstSeq : null,
    });
    spans.push(
      surfaceNodes !== null
        ? { nodeStart: start, nodeEnd: start + seqs.length, seqs: [...seqs] }
        : null,
    );
    if (pendingFirstSeq >= 0) ordinalToSeq.set(ordinal, pendingFirstSeq);
    for (const s of seqs) seqToOrdinal.set(s, ordinal);
    resetPending();
  };

  for (let nodeIndex = 0; nodeIndex < ordered.length; nodeIndex += 1) {
    const event = ordered[nodeIndex];
    const type = event.type;
    if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") {
      continue; // log-only events (tool/call, turn/*, request/*, ...) — skipped
    }
    const message = deriveEventMessage(event as unknown as SessionEvent);
    if (!message) continue; // e.g. empty-content assistant/message
    const record = message as unknown as Record<string, unknown>;
    const seq = seqOf(event);

    if (type === "assistant/message") {
      if (pendingParts.length > 0) flushSynthetic();
      const parts = assistantParts(record, surfaceNodes !== null, toolNameByCallId);
      const hasToolCalls = parts.some(
        (part) => isRecord(part) && part.type === "tool" && typeof part.callID === "string",
      );
      if (hasToolCalls) {
        // Hold the tool-call assistant until its results arrive; the fold
        // (into the next user / synthetic tail) will include this node.
        pendingAssistant = {
          nodeIndex,
          seq,
          parts,
          createdAt: timeOf(event) ?? null,
          id: String(message.id),
        };
        continue;
      }
      // Orphan tool-call assistant (no results followed): keep as-is.
      if (pendingAssistant !== null) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      pushAssistant({ nodeIndex, seq, parts, createdAt: timeOf(event) ?? null, id: String(message.id) });
      continue;
    }

    if (type === "user/message") {
      // An orphan tool-call assistant (no results) stays as its own message.
      if (pendingAssistant !== null && pendingParts.length === 0) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      const ordinal = messages.length + 1;
      const start =
        surfaceNodes !== null
          ? Math.min(
              pendingStartIndex ?? Number.POSITIVE_INFINITY,
              pendingAssistant?.nodeIndex ?? Number.POSITIVE_INFINITY,
              nodeIndex,
            )
          : nodeIndex;
      const knowledge = isKnowledgeMessage(record);
      const skillCatalog = isSkillCatalogMessage(record);
      messages.push({
        ordinal,
        id: String(message.id),
        role: "user",
        parts: [
          ...(pendingAssistant?.parts ?? []),
          ...pendingParts,
          ...userTextParts(record.content),
        ],
        createdAt: timeOf(event) ?? null,
        version: seq >= 0 ? seq : null,
      });
      spans.push(
        surfaceNodes !== null
          ? {
              nodeStart: start,
              nodeEnd: nodeIndex + 1,
              seqs: [...(pendingAssistant === null ? [] : [pendingAssistant.seq]), ...pendingSeqs, seq],
            }
          : null,
      );
      ordinalToSeq.set(ordinal, seq);
      for (const s of [...(pendingAssistant === null ? [] : [pendingAssistant.seq]), ...pendingSeqs, seq]) {
        seqToOrdinal.set(s, ordinal);
      }
      if (knowledge) knowledgeOrdinals.add(ordinal);
      if (skillCatalog) skillCatalogOrdinals.add(ordinal);
      resetPending();
      continue;
    }

    // tool/result — folded into the next user (or synthetic tail user).
    pendingParts.push(...toolResultParts(record, toolNameByCallId));
    pendingSeqs.push(seq);
    if (pendingStartIndex === null) pendingStartIndex = nodeIndex;
    if (pendingFirstId === null) pendingFirstId = String(message.id);
    if (pendingFirstSeq < 0) pendingFirstSeq = seq;
    if (pendingFirstTime === undefined) pendingFirstTime = timeOf(event);
  }

  if (pendingAssistant !== null && pendingParts.length === 0) {
    // Tail orphan tool-call assistant (no results) — keep as-is.
    pushAssistant(pendingAssistant);
    pendingAssistant = null;
  }
  if (pendingParts.length > 0 || pendingAssistant !== null) flushSynthetic();
  return { messages, spans, knowledgeOrdinals, skillCatalogOrdinals, ordinalToSeq, seqToOrdinal };
}

/**
 * Pure conversion of a DSH event log into core `RawMessage[]` (Pi-mirror
 * mapping; see module doc). Ordinals are 1-based and monotonic over message
 * events only; tool-results fold into the following user message; a dangling
 * tool-result tail becomes a synthetic user (`synth-user-` prefix). Assistant
 * thinking is dropped here (the VIEW keeps it for the reasoning stage).
 */
export function convertDshEventsToRawMessages(events: readonly unknown[]): RawMessage[] {
  return walkDshLog(events, null).messages;
}

/**
 * Reversible DSH event seq ↔ ordinal map for a log (or, with `surfaceNodes`,
 * for the surface view). `ordinalToSeq` maps each message to its own event
 * seq (synthetic users map to their first folded tool-result seq);
 * `seqToOrdinal` maps every contributing event seq (tool-result seqs fold
 * into the containing message's ordinal) back to its ordinal.
 */
export function buildDshOrdinalMap(
  events: readonly unknown[],
  surfaceNodes?: readonly number[],
): DshOrdinalMap {
  const walk = walkDshLog(events, surfaceNodes ?? null);
  return { ordinalToSeq: new Map(walk.ordinalToSeq), seqToOrdinal: new Map(walk.seqToOrdinal) };
}

/** Convenience reverse lookup: the DSH event seq that produced `ordinal`. */
export function dshSeqForOrdinal(
  events: readonly unknown[],
  ordinal: number,
  surfaceNodes?: readonly number[],
): number | undefined {
  return buildDshOrdinalMap(events, surfaceNodes).ordinalToSeq.get(ordinal);
}

/** Surface node indices occupied by Magic-context knowledge messages (m0/m1). */
export function findKnowledgeBaselineNodeIndices(
  events: readonly unknown[],
  surfaceNodes: readonly number[],
): number[] {
  const eventBySeq = new Map<number, EventLike>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0) eventBySeq.set(seq, event);
  }
  const out: number[] = [];
  surfaceNodes.forEach((seq, index) => {
    const event = eventBySeq.get(seq);
    if (!event || event.type !== "user/message") return;
    const data = dataOf(event);
    if (data && isKnowledgeMessage(data)) out.push(index);
  });
  return out;
}

/* ────────────────────────────────── view ──────────────────────────────────── */

/** Build the read-only transcript view (design §3). */
export function readDshTranscript(input: DshTranscriptInput): DshTranscriptView {
  const events = Array.isArray(input.session.events) ? input.session.events : [];
  const nodes = Array.isArray(input.session.surface?.nodes)
    ? [...input.session.surface.nodes]
    : [];
  const walk = walkDshLog(events, nodes);

  for (let i = 0; i < walk.messages.length; i += 1) {
    const message = walk.messages[i];
    const span = walk.spans[i];
    if (span !== null) {
      Object.defineProperty(message, DSH_MESSAGE_SPAN_KEY, {
        value: span,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.knowledgeOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_KNOWLEDGE_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.skillCatalogOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_SKILL_CATALOG_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  return {
    sessionId: input.canonicalSessionId,
    sourceWatermark: maxEventSeq(events),
    inputDigest: sha256Hex(JSON.stringify(walk.messages)).slice(0, 16),
    generation:
      typeof input.session.surface?.replaceGeneration === "number"
        ? input.session.surface.replaceGeneration
        : 0,
    messages: walk.messages,
    surfaceNodes: nodes,
  };
}

function maxEventSeq(events: readonly unknown[]): number {
  let max = 0;
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq > max) max = seq;
  }
  return max;
}

/* ─────────────────────────── recording transcript ─────────────────────────── */

/** Canonical dropped placeholder (byte-identical to buildReplacementContent). */
const DROPPED_SENTINEL_PATTERN = /^\[dropped\s+\u00a7\d+\u00a7\]$/;

export type RecordingPartField = "text" | "output" | "input" | "sentinel" | "reasoning";

/** One recorded content change: which part went from what to what. */
export interface MutationRecord {
  /** Index into the owning message's parts; -1 for message-level records (reasoning). */
  readonly partIndex: number;
  readonly field: RecordingPartField;
  readonly from: string;
  readonly to: string;
  /** Tag number the mutation belongs to (reasoning watermark records). */
  readonly tag?: number;
}

function classifyRecordingPart(raw: Record<string, unknown>): TranscriptPartKind {
  switch (raw.type) {
    case "text":
      return "text";
    case "reasoning":
    case "thinking":
      return "thinking";
    case "tool": {
      const state = isRecord(raw.state) ? raw.state : null;
      return state !== null && state.output !== undefined ? "tool_result" : "tool_use";
    }
    case "image":
      return "image";
    default:
      return "unknown";
  }
}

/**
 * Recording TranscriptPart: wraps one RawMessage part, exposes the shared
 * `TranscriptPart` mutation surface, and records every mutation on its
 * owning RecordingMessage instead of changing any source array.
 */
export class RecordingPart implements TranscriptPart {
  readonly kind: TranscriptPartKind;
  readonly id: string | undefined;
  readonly partIndex: number;
  private readonly owner: RecordingMessage;
  private readonly raw: Record<string, unknown>;
  private readonly toolName: string | undefined;
  private readonly callId: string | undefined;
  private payload: string | undefined;
  private input: Record<string, unknown> | null;

  constructor(owner: RecordingMessage, partIndex: number, raw: unknown) {
    this.owner = owner;
    this.partIndex = partIndex;
    this.raw = isRecord(raw) ? raw : {};
    this.kind = classifyRecordingPart(this.raw);
    this.callId = typeof this.raw.callID === "string" ? this.raw.callID : undefined;
    this.toolName = typeof this.raw.tool === "string" ? this.raw.tool : undefined;
    this.id = this.callId;
    this.input = this.readInputState();
    this.payload = this.initPayload();
  }

  private readInputState(): Record<string, unknown> | null {
    if (this.kind !== "tool_use" && this.kind !== "tool_result") return null;
    const state = isRecord(this.raw.state) ? this.raw.state : null;
    return state !== null && isRecord(state.input) ? state.input : null;
  }

  private initPayload(): string | undefined {
    if (this.kind === "text") return typeof this.raw.text === "string" ? this.raw.text : "";
    if (this.kind === "thinking") {
      const text = typeof this.raw.text === "string" ? this.raw.text : undefined;
      return text ?? (typeof this.raw.thinking === "string" ? this.raw.thinking : "");
    }
    if (this.kind === "tool_use") return JSON.stringify(this.input ?? {});
    if (this.kind === "tool_result") {
      const state = isRecord(this.raw.state) ? this.raw.state : null;
      const output = state !== null ? state.output : undefined;
      if (typeof output === "string") return output;
      return output !== undefined ? JSON.stringify(output) : "";
    }
    return "";
  }

  private record(field: RecordingPartField, from: string, to: string, tag?: number): void {
    const record: MutationRecord = {
      partIndex: this.partIndex,
      field,
      from,
      to,
      ...(tag !== undefined ? { tag } : {}),
    };
    this.owner.mutations.push(record);
  }

  getText(): string | undefined {
    return this.payload;
  }

  setText(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("text", from, newText);
    return true;
  }

  setToolOutput(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("output", from, newText);
    return true;
  }

  getToolInput(): Record<string, unknown> | null {
    return this.input;
  }

  setToolInput(input: Record<string, unknown>): boolean {
    if (input === this.input) return false;
    const from = JSON.stringify(this.input ?? {});
    this.input = input;
    this.record("input", from, JSON.stringify(input));
    return true;
  }

  getToolMetadata(): {
    toolName: string | undefined;
    inputByteSize: number;
    inputTokenCount: number;
  } {
    if (this.kind === "tool_use" || this.kind === "tool_result") {
      return {
        toolName: this.toolName,
        inputByteSize: byteSize(JSON.stringify(this.input ?? {})),
        inputTokenCount: 0,
      };
    }
    return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
  }

  replaceWithSentinel(sentinelText: string): boolean {
    if (this.payload === sentinelText) return false;
    const from = this.payload ?? "";
    this.payload = sentinelText;
    this.record("sentinel", from, sentinelText);
    return true;
  }

  /** Deterministic text rendering of this part's CURRENT state. */
  render(): string | null {
    if (this.kind === "thinking" || this.kind === "image") return null;
    const payload = this.payload ?? "";
    if (this.kind === "text" || this.kind === "unknown") return payload.length > 0 ? payload : null;
    if (DROPPED_SENTINEL_PATTERN.test(payload)) return payload.length > 0 ? payload : null;
    const head = this.kind === "tool_use" ? "tool" : "tool result";
    const lines = [
      `[${head}: ${this.toolName ?? "tool"}${this.callId ? ` #${this.callId}` : ""}]`,
    ];
    if (this.input) lines.push(`input: ${JSON.stringify(this.input)}`);
    if (this.kind === "tool_result" && payload.length > 0) lines.push(`output:\n${payload}`);
    return lines.join("\n");
  }
}

/**
 * Recording TranscriptMessage: accumulates {@link MutationRecord}s from its
 * parts and coalesces them into one op at plan time.
 */
export class RecordingMessage implements TranscriptMessage {
  readonly info: { id?: string; role: string; sessionId?: string };
  readonly parts: RecordingPart[] = [];
  readonly span: DshMessageSpan | null;
  readonly mutations: MutationRecord[] = [];

  constructor(
    info: { id?: string; role: string; sessionId?: string },
    span: DshMessageSpan | null,
  ) {
    this.info = info;
    this.span = span;
  }

  addPart(raw: unknown): RecordingPart {
    const part = new RecordingPart(this, this.parts.length, raw);
    this.parts.push(part);
    return part;
  }

  isDirty(): boolean {
    return this.mutations.length > 0;
  }

  /** Coalesced op kind: the "worst" of this message's mutations (drops > reasoning > tags). */
  opKind(): MutationKind {
    if (
      this.mutations.some(
        (record) =>
          record.field === "sentinel" ||
          record.field === "output" ||
          record.field === "input" ||
          DROPPED_SENTINEL_PATTERN.test(record.to),
      )
    ) {
      return "drops";
    }
    if (this.mutations.some((record) => record.field === "reasoning")) return "reasoning";
    return "tags";
  }

  /** Deterministic human-readable reason for the coalesced op. */
  reason(): string {
    const parts: string[] = [];
    for (const record of this.mutations) {
      if (record.field === "sentinel") {
        parts.push(`drop → ${record.to}`);
      } else if (record.field === "reasoning") {
        parts.push(`reasoning cleared through tag §${record.tag ?? "?"}§`);
      } else if (/^\u00a7\d+\u00a7/.test(record.to)) {
        const space = record.to.indexOf(" ");
        parts.push(`tag prefix ${space > 0 ? record.to.slice(0, space) : record.to}`);
      } else {
        parts.push(`${record.field} → ${record.to}`);
      }
    }
    return parts.join("; ");
  }

  /** Full Magic-rendered text of this message in its CURRENT (recorded) state. */
  render(): string {
    return this.parts
      .map((part) => part.render())
      .filter((value): value is string => value !== null && value.length > 0)
      .join("\n\n");
  }
}

/** Recording Transcript: same shape the shared tagTranscript walks. */
export class RecordingTranscript implements Transcript {
  readonly harness: "opencode" = "opencode";
  readonly messages: RecordingMessage[];

  constructor(messages: RecordingMessage[]) {
    this.messages = messages;
  }

  /** Recording never mutates source arrays; nothing to commit. */
  commit(): void {}
}

/**
 * Recording TagTarget (design §9.3): implements the core TagTarget interface
 * by delegating to the shared tagTranscript-built target. The shared target
 * calls our RecordingParts, so every setContent/drop/truncate/editMarker
 * lands as MutationRecords on the affected messages instead of changing any
 * source array. One tag → one target; per-message records are coalesced into
 * one replace op at plan time.
 */
export class RecordingTagTarget implements TagTarget {
  constructor(
    readonly tagId: number,
    private readonly inner: TagTarget,
  ) {}

  setContent(content: string): boolean {
    return this.inner.setContent(content);
  }

  getContent(): string | null {
    return this.inner.getContent?.() ?? null;
  }

  drop(): ToolDropResult {
    return this.inner.drop?.() ?? "absent";
  }

  truncate(): ToolDropResult {
    return this.inner.truncate?.() ?? "absent";
  }

  editMarker(): ToolDropResult {
    return this.inner.editMarker?.() ?? "absent";
  }

  canDrop(): boolean {
    return this.inner.canDrop?.() ?? false;
  }

  readInput(): Record<string, unknown> | null {
    return this.inner.readInput?.() ?? null;
  }

  get message(): MessageLike | undefined {
    return this.inner.message;
  }
}

/* ────────────────────────────── plan derivation ───────────────────────────── */

function buildRecordingTranscript(
  view: DshTranscriptView,
): { transcript: RecordingTranscript; byMessageId: Map<string, RecordingMessage> } {
  const messages: RecordingMessage[] = [];
  const byMessageId = new Map<string, RecordingMessage>();
  for (const raw of view.messages) {
    // Knowledge-baseline (m0/m1) messages stay out of the tag/drop pipeline:
    // the coordinator's surface replace would give them a NEW event id each
    // pass, so tag numbers (and §N§ prefixes) would churn forever — the
    // replay invariant (design §3) would break. They remain in the view
    // (digest + cache classification) but never produce ops.
    //
    // Skill-catalog reminders (dsh-tool-skill) get the same protection: the
    // catalog's digest must stay visible to the session surface unchanged or
    // catalogHistory() cannot find the published digest and dsh-tool-skill
    // re-injects the <system-reminder> on every pre-step. Tagging/prefixing
    // them would force a surface replace each round (new seq), breaking the
    // visible-digest invariant and causing the per-round catalog loop.
    if (isKnowledgeBaselineMessage(raw)) continue;
    if (isSkillCatalogBaselineMessage(raw)) continue;
    const message = new RecordingMessage(
      { id: raw.id, role: raw.role, sessionId: view.sessionId },
      messageNodeSpan(raw),
    );
    for (const part of raw.parts) message.addPart(part);
    messages.push(message);
    if (typeof raw.id === "string") byMessageId.set(raw.id, message);
  }
  return { transcript: new RecordingTranscript(messages), byMessageId };
}

/**
 * Temporary cache classification (design §6 stand-in). Rules:
 *   - pure tail append (insertion at/after the last surface node) → soft-plus;
 *   - a replace covering a knowledge-baseline node (m0/m1) → hard;
 *   - everything else → soft.
 * The cache-classification slice owns the official `classifyPlan`; this is
 * replaced at integration.
 */
export function minimalCacheClassForOp(
  range: { readonly start: number; readonly end: number },
  surfaceNodeCount: number,
  baselineNodeIndices: readonly number[] = [],
): CacheClass {
  if (range.start >= surfaceNodeCount) return "soft-plus";
  for (let i = range.start; i < range.end; i += 1) {
    if (baselineNodeIndices.includes(i)) return "hard";
  }
  return "soft";
}

function baselineNodeIndices(view: DshTranscriptView): number[] {
  const out: number[] = [];
  for (const message of view.messages) {
    if (!isKnowledgeBaselineMessage(message)) continue;
    const span = messageNodeSpan(message);
    if (span !== null) out.push(span.nodeStart);
  }
  return out;
}

/**
 * Stage 1: temporal gap markers (design §9.10.1). Idempotent: skipped when
 * the user message already carries a marker prefix or the immediately
 * preceding message IS a marker message. Produces "insertion" ops with
 * start === end === insertion point (the user message's node span start) and
 * empty shadowedSeqs. NOTE for the coordinator slice: the DSH surface has no
 * pure-insert surface op, so insertion ops must be merged into an adjacent
 * replace (or appended at the tail) at apply time.
 */
function planTemporalMarkers(view: DshTranscriptView): MutationOp[] {
  const ops: MutationOp[] = [];
  const baseline = baselineNodeIndices(view);
  let prev: RawMessage | null = null;
  for (const message of view.messages) {
    const isGapEligibleUser =
      message.role === "user" &&
      !isKnowledgeBaselineMessage(message) &&
      !isSkillCatalogBaselineMessage(message) &&
      !isSyntheticUserMessage(message);
    if (isGapEligibleUser && prev !== null) {
      const prevTime = typeof prev.createdAt === "number" ? prev.createdAt : null;
      const currTime = typeof message.createdAt === "number" ? message.createdAt : null;
      if (prevTime !== null && currTime !== null) {
        const gapSeconds = Math.floor((currTime - prevTime) / 1000);
        const marker = temporalMarkerPrefix(gapSeconds);
        if (marker !== null && !hasTemporalMarker(message) && !isTemporalMarkerMessage(prev)) {
          const span = messageNodeSpan(message);
          if (span !== null) {
            ops.push({
              kind: "temporal",
              start: span.nodeStart,
              end: span.nodeStart,
              replacement: marker,
              cacheClass: minimalCacheClassForOp(
                { start: span.nodeStart, end: span.nodeStart },
                view.surfaceNodes.length,
                baseline,
              ),
              reason: `temporal gap ${formatGap(gapSeconds) ?? "?"}`,
              shadowedSeqs: [],
            });
          }
        }
      }
    }
    if (!isKnowledgeBaselineMessage(message) && !isSkillCatalogBaselineMessage(message)) {
      prev = message;
    }
  }
  return ops;
}

function hasTemporalMarker(message: RawMessage): boolean {
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    return TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(part.text).body);
  }
  return false;
}

/** True when every non-empty text part of the message is a temporal marker. */
function isTemporalMarkerMessage(message: RawMessage): boolean {
  let sawMarker = false;
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (text.trim().length === 0) continue;
    if (TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(text).body)) {
      sawMarker = true;
    } else {
      return false;
    }
  }
  return sawMarker;
}

/**
 * Stage 5: reasoning replay (design §9.10.7, Pi `replayClearedReasoning`
 * mirror). For assistant messages whose max tag number is at or below the
 * `clearedReasoningThroughTag` watermark and whose content still carries
 * reasoning blocks, record a reasoning mutation — the message's replacement
 * render then excludes the reasoning. Minimal deterministic version; the
 * watermark-advancing clear pass and inline `<thinking>` stripping land in
 * Phase 4 (the coordinator owns pass type).
 */
function planReasoningReplay(
  view: DshTranscriptView,
  byMessageId: ReadonlyMap<string, RecordingMessage>,
  targets: ReadonlyMap<number, TagTarget>,
  db: Database,
): void {
  const meta = getOrCreateSessionMeta(db, view.sessionId);
  const watermark = typeof meta.clearedReasoningThroughTag === "number" ? meta.clearedReasoningThroughTag : 0;
  if (watermark <= 0) return;

  const maxTagById = new Map<string, number>();
  for (const [tagId, target] of targets) {
    const id = target.message?.info?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const prev = maxTagById.get(id) ?? 0;
    if (tagId > prev) maxTagById.set(id, tagId);
  }

  for (const message of view.messages) {
    if (message.role !== "assistant" || typeof message.id !== "string") continue;
    const msgTag = maxTagById.get(message.id) ?? 0;
    if (msgTag === 0 || msgTag > watermark) continue;
    const reasoningTexts: string[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type !== "reasoning" && type !== "thinking") continue;
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof part.thinking === "string"
            ? part.thinking
            : "";
      if (text.length > 0 && text !== "[cleared]") reasoningTexts.push(text);
    }
    if (reasoningTexts.length === 0) continue;
    const recording = byMessageId.get(message.id);
    if (!recording) continue;
    recording.mutations.push({
      partIndex: -1,
      field: "reasoning",
      from: reasoningTexts.join("\n"),
      to: "[cleared]",
      tag: msgTag,
    });
  }
}

/**
 * Derive a MutationPlan from the view + shared DB state (design §3).
 *
 * Pipeline (this slice: stages 1-5 of §9.10, all through the recording
 * layer — the view's messages are never mutated):
 *   1. temporal gap markers (idempotent insertion ops);
 *   2. tagTranscript (shared; §N§ prefix injections recorded on parts);
 *   3. applyPendingOperations (shared, recording TagTargets, preloaded reads);
 *   4. applyFlushedStatuses (every pass; byte-level drop replay);
 *   5. reasoning replay from the clearedReasoningThroughTag watermark.
 *
 * Determinism: the view is immutable, so re-deriving from the same log +
 * DB state yields byte-identical ops (replay invariant). Returns null when
 * nothing changed.
 */
export function deriveMutationPlan(view: DshTranscriptView, ctx: PlanContext): MutationPlan | null {
  const db = ctx.db;
  const sessionId = view.sessionId;
  const protectedTags = Math.max(0, Math.floor(ctx.protectedTags ?? 0));

  const ops: MutationOp[] = [...planTemporalMarkers(view)];

  const { transcript, byMessageId } = buildRecordingTranscript(view);
  if (transcript.messages.length > 0) {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const tagged = tagTranscript(sessionId, transcript, tagger, db);

    // Wrap the shared targets: recording targets delegate to them, and the
    // shared targets call our recording parts — every mutation is recorded.
    const recordingTargets = new Map<number, TagTarget>();
    for (const [tagId, target] of tagged.targets) {
      recordingTargets.set(tagId, new RecordingTagTarget(tagId, target));
    }

    // Preloaded reads: avoid re-reading tags/pending ops inside the shared
    // stages (the transaction body reads them otherwise).
    const preloadedTags = getTagsBySession(db, sessionId);
    const preloadedPendingOps = getPendingOps(db, sessionId);
    applyPendingOperations(
      sessionId,
      db,
      recordingTargets,
      protectedTags,
      preloadedTags,
      preloadedPendingOps,
    );
    applyFlushedStatuses(sessionId, db, recordingTargets, preloadedTags);

    planReasoningReplay(view, byMessageId, recordingTargets, db);

    const baseline = baselineNodeIndices(view);
    for (const message of transcript.messages) {
      if (!message.isDirty()) continue;
      const span = message.span;
      if (span === null || span.seqs.length === 0) continue; // no surface coverage
      ops.push({
        kind: message.opKind(),
        start: span.nodeStart,
        end: span.nodeEnd,
        replacement: message.render(),
        cacheClass: minimalCacheClassForOp(
          { start: span.nodeStart, end: span.nodeEnd },
          view.surfaceNodes.length,
          baseline,
        ),
        reason: message.reason(),
        shadowedSeqs: [...span.seqs],
      });
    }
  }

  if (ops.length === 0) return null;
  ops.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    opId: randomUUID(),
    sessionId: view.sessionId,
    sourceWatermark: view.sourceWatermark,
    inputDigest: view.inputDigest,
    generation: view.generation,
    ops,
  };
}
