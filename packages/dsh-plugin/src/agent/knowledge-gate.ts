/**
 * agent/knowledge-gate — the first-step knowledge injection gate (Phase 2
 * slice A).
 *
 * Registered on `agent/pre-step` with `prepend: true` (outermost, via the
 * compat seam registerPreStepGate). The gate:
 *
 *   1. awaits the host `magicContextHost.ready` bootstrap (fail-open on
 *      refusal);
 *   2. attributes the session to its project (`session_projects`, once per
 *      session — see session-track.ts);
 *   3. injects the Magic knowledge baseline — core m[0]/m[1] through
 *      mustMaterialize / materializeWithRetry (which internally renders m[1]
 *      and persists the cached m[0] via persistCachedM0) or, on a cache-valid
 *      defer pass, replays the persisted bytes — ONCE per session per surface
 *      generation (in-memory Map<sessionId, generation>) with a content
 *      watermark de-dup against the visible surface (resume safety);
 *   4. fires the auto-search hint evaluation for the incoming user message
 *      (fire-and-forget, see auto-search.ts);
 *   5. passes the pre-step decision through untouched (`await next()`).
 *
 * Injection timing: DSH `agent.inject()` queues model-facing context for the
 * NEXT pre-step batch (the current batch was already claimed when the waterfall
 * ran), so the knowledge baseline becomes model-visible on the following
 * request of the session. This matches the PLAN §4.1 "inject, do not rewrite"
 * contract — the adapter never mutates existing message arrays.
 *
 * Knowledge-mode preview: `compactionOff: true` by default — the zero-
 * compartment path where m[0] carries memory/docs/user-profile only and
 * historical compartments never render.
 */
import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import {
  mustMaterialize,
  materializeWithRetry,
  renderM1,
  type M0HardSignals,
  type M0M1RenderOptions,
  type M0M1State,
  type M0SnapshotMarkers,
  type MaterializeM0Result,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { parseCacheTtl } from "@magic-context/core/features/magic-context/scheduler";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  magicUserMessage,
  type MagicMessageSource,
} from "../compat/dsh-0.1/session";
import {
  registerPreStepGate,
  type PreStepDecision,
  type PreStepPayload,
} from "../compat/dsh-0.1/prestep";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { trackSessionProjectOnce, sessionProjectPath } from "./session-track";
import { maybeRunAutoSearchHint, type AutoSearchConfig } from "./auto-search";
import { isMagicChildSession } from "./worker";

/** The host-service slice the gate needs (structural view). */
export interface KnowledgeGateHostView {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
}

/** Knowledge (m0/m1) gate options surfaced in the agent plugin config. */
export interface KnowledgeConfig {
  enabled?: boolean;
  /** Session workspace directory (fallback when the header has no cwd). */
  directory?: string;
  /** m[0] includes the <project-docs> block (default true). */
  injectDocs?: boolean;
  /** Zero-compartment knowledge-mode path (default true — preview mode). */
  compactionOff?: boolean;
  memoryInjectionBudgetTokens?: number;
  historyBudgetTokens?: number;
  userProfileBudgetTokens?: number;
  muralEnabled?: boolean;
  /** Provider-side cache TTL ("5m", "1h", ...) for the HARD-bust signal. */
  cacheTtl?: string;
}

export interface KnowledgeGateDeps {
  readonly host: KnowledgeGateHostView;
  readonly config: KnowledgeConfig;
  readonly autoSearch: AutoSearchConfig;
  /** Mural image injection (Phase 4): vision-gated image block on m0. */
  readonly mural?: {
    /** Master switch (config mural.enabled). */
    enabled?: boolean;
    /** Vision gate for the session's model (production: modelSupportsVision). */
    supportsVision?: (agent: KnowledgeAgentView) => boolean;
    /** Persist the mural data URL as an attachment and return the image block. */
    resolveImage?: (dataUrl: string) => Promise<unknown | null>;
  };
  /** Injectable clock (tests). */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** Per-plugin gate state (owned by the registration, reset on plugin reload). */
export interface KnowledgeGateState {
  /** sessionId → surface generation already injected for. */
  readonly injectedGenerations: Map<string, number>;
  /** sessionId → project attribution already recorded for. */
  readonly trackedSessions: Set<string>;
  /** Messages injected by the most recent pass (first-round prepend). */
  lastInjectedMessages: unknown[];
}

export function createKnowledgeGateState(): KnowledgeGateState {
  return { injectedGenerations: new Map(), trackedSessions: new Set(), lastInjectedMessages: [] };
}

/** The session surface slice the gate reads (test-friendly structural view). */
export interface KnowledgeSessionView {
  readonly surface: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
  readonly events: readonly unknown[];
  readonly header: { readonly cwd?: string };
}

/** The agent slice the gate drives (structural view over DSH Agent). */
export interface KnowledgeAgentView {
  readonly id: SessionId;
  readonly options: { readonly provider?: string; readonly model?: string };
  readonly session: KnowledgeSessionView;
  inject(message: UserMessage): void;
}

/** One materialized knowledge payload ready for injection. */
export interface KnowledgeBlocks {
  readonly m0Text: string;
  readonly m1Text: string;
  /** Combined model-facing text (m0 + optional m1 delta). */
  readonly text: string;
  readonly watermark: string;
  readonly revision: string;
  readonly digest: string;
}

/**
 * Mirror of the core's M1 "nothing new" placeholder (inject-compartments.ts).
 * The adapter strips it so the model never sees the "no new content" stub.
 */
const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function decodeUtf8(bytes: Buffer | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

/** Provider/model key for the HARD-bust signal ("provider/model", or ""). */
function modelKeyOf(agent: KnowledgeAgentView): string {
  const { provider, model } = agent.options;
  if (!provider || !model) return "";
  return `${provider}/${model}`;
}

/** Compute the runtime HARD-bust signals (system/model/TTL idle). */
export function computeHardSignals(
  deps: Pick<KnowledgeGateDeps, "config" | "now">,
  meta: { systemPromptHash?: string | number; lastResponseTime: number },
  agent: KnowledgeAgentView,
): M0HardSignals {
  const modelKey = modelKeyOf(agent);
  const rawSystemHash = typeof meta.systemPromptHash === "string" ? meta.systemPromptHash : "";
  const systemHash =
    rawSystemHash !== "" && rawSystemHash !== "0" ? rawSystemHash : "";
  let cacheExpired = false;
  if (meta.lastResponseTime > 0) {
    try {
      const ttl = resolveCacheTtl(deps.config.cacheTtl ?? "5m", modelKey || undefined);
      const ttlMs = parseCacheTtl(ttl);
      const now = deps.now?.() ?? Date.now();
      cacheExpired = now - meta.lastResponseTime > ttlMs;
    } catch {
      cacheExpired = false;
    }
  }
  return { systemHash, modelKey, cacheExpired, lastResponseTime: meta.lastResponseTime };
}

/**
 * Core pipeline: mustMaterialize → materializeWithRetry (m0/m1 render +
 * persistCachedM0, contention-retried) or, on a cache-valid defer pass, replay
 * the persisted bytes. Returns the injection-ready blocks + content watermark.
 */
export function materializeKnowledgeBlocks(
  deps: KnowledgeGateDeps,
  db: Database,
  magicSessionId: string,
  projectPath: string | undefined,
  directory: string | undefined,
  agent: KnowledgeAgentView,
): KnowledgeBlocks | null {
  const meta = getOrCreateSessionMeta(db, magicSessionId);
  const state = meta as unknown as M0M1State;
  const hardSignals = computeHardSignals(deps, meta, agent);
  const renderOptions: M0M1RenderOptions = {
    db,
    sessionId: magicSessionId,
    state,
    projectPath,
    // projectDirectory is the FILESYSTEM directory (docs read); projectPath is
    // the canonical project identity (memory lookup). Keep them distinct.
    projectDirectory: directory ?? "",
    injectDocs: deps.config.injectDocs ?? true,
    compactionOff: deps.config.compactionOff ?? true,
    memoryInjectionBudgetTokens: deps.config.memoryInjectionBudgetTokens,
    historyBudgetTokens: deps.config.historyBudgetTokens,
    userProfileBudgetTokens: deps.config.userProfileBudgetTokens,
    muralEnabled: deps.config.muralEnabled ?? false,
    hardSignals,
  };

  const decision = mustMaterialize({
    db,
    sessionId: magicSessionId,
    state,
    projectPath,
    hardSignals,
    injectDocs: renderOptions.injectDocs,
    muralEnabled: renderOptions.muralEnabled,
    memoryInjectionBudgetTokens: renderOptions.memoryInjectionBudgetTokens,
    historyBudgetTokens: renderOptions.historyBudgetTokens,
  });

  let m0Text: string;
  let m1Text: string;
  let markers: M0SnapshotMarkers | null;
  let materializedAt: number;

  if (decision.value) {
    const result: MaterializeM0Result = materializeWithRetry(renderOptions);
    m0Text = result.m0Text;
    m1Text = result.m1Text;
    markers = result.snapshotMarkers;
    materializedAt = result.snapshotMarkers.materializedAt;
    // Hold the markers for in-process defer passes (fresh m1 delta rendering).
    state.snapshotMarkers = result.snapshotMarkers;
  } else {
    // Defer: replay the persisted baseline bytes.
    m0Text = decodeUtf8(state.cachedM0Bytes) ?? "";
    m1Text = decodeUtf8(state.cachedM1Bytes) ?? "";
    materializedAt = state.cachedM0MaterializedAt ?? 0;
    markers = state.snapshotMarkers ?? null;
    if (markers) {
      // Fresh m1 delta against the held markers so additive memories surface
      // even when the cache is valid (soft refresh, non-persisted).
      try {
        const fresh = renderM1(renderOptions, markers, []);
        if (fresh && fresh.trim().length > 0 && fresh !== M1_EMPTY_PLACEHOLDER) {
          m1Text = fresh;
        }
      } catch {
        // Keep the cached m1 on any marker mismatch.
      }
    }
  }

  if (m0Text.length === 0) return null;

  const m1Part =
    m1Text.trim().length > 0 && m1Text !== M1_EMPTY_PLACEHOLDER ? `\n\n${m1Text}` : "";
  const text = `${m0Text}${m1Part}`;
  const digest = sha256Hex(text).slice(0, 16);
  const revision = String(materializedAt);
  return {
    m0Text,
    m1Text,
    text,
    watermark: `mc-kb:${revision}:${digest}`,
    revision,
    digest,
  };
}

/**
 * Watermark de-dup against the VISIBLE surface: true when a Magic knowledge
 * message with this watermark is already a live surface node (resume replay —
 * the durable log still carries it, so a restarted process must not re-inject).
 * Replaced (shadowed) nodes do not count, so a compacted session re-injects.
 */
export function isMagicWatermarkOnSurface(
  session: KnowledgeSessionView,
  watermark: string,
): boolean {
  const events = session.events;
  for (const seq of session.surface.nodes) {
    const event = events[seq] as
      | { type?: string; data?: { source?: MagicMessageSource | { kind?: string } } }
      | undefined;
    if (!event || event.type !== "user/message") continue;
    const source = event.data?.source;
    if (
      source &&
      source.kind === "plugin" &&
      (source as MagicMessageSource).plugin === "magic-context" &&
      (source as MagicMessageSource).messageId === watermark
    ) {
      return true;
    }
  }
  return false;
}

/** Inject the knowledge baseline once per (session, surface generation). */
export async function maybeInjectKnowledge(
  state: KnowledgeGateState,
  deps: KnowledgeGateDeps,
  agent: KnowledgeAgentView,
  db: Database,
  magicSessionId: string,
  projectPath: string | undefined,
  directory: string | undefined,
): Promise<void> {
  if (deps.config.enabled === false) return;
  const generation = agent.session.surface.replaceGeneration;
  if (state.injectedGenerations.get(magicSessionId) === generation) return;

  const blocks = materializeKnowledgeBlocks(
    deps,
    db,
    magicSessionId,
    projectPath,
    directory,
    agent,
  );
  if (blocks === null) return;

  if (isMagicWatermarkOnSurface(agent.session, blocks.watermark)) {
    // Resume: the persisted surface already carries this exact baseline.
    state.injectedGenerations.set(magicSessionId, generation);
    return;
  }

  const source: MagicMessageSource = {
    kind: "plugin",
    plugin: "magic-context",
    messageId: blocks.watermark,
    revision: blocks.revision,
    digest: blocks.digest,
  };
  // Mural (Phase 4): when enabled + the model supports vision + the m0 fold
  // produced a mural, persist the data URL as an attachment and ride the
  // image block on the injected baseline message. The extra blocks ride the
  // content array of the SAME message (createUserMessage deep-freezes, so the
  // array is assembled before construction).
  const mural = deps.mural;
  let muralBlock: unknown = null;
  if (mural?.enabled === true && (mural.supportsVision?.(agent) ?? false)) {
    try {
      const meta = getOrCreateSessionMeta(db, magicSessionId) as unknown as {
        cachedM0MuralDataUrl?: string | null;
      };
      const dataUrl = meta.cachedM0MuralDataUrl;
      if (typeof dataUrl === "string" && dataUrl.length > 0 && mural.resolveImage !== undefined) {
        muralBlock = await mural.resolveImage(dataUrl);
      }
    } catch (error) {
      deps.log?.(
        `[magic-context] mural injection skipped (fail-open): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const muralBlocks =
    muralBlock === null || muralBlock === undefined
      ? []
      : ([muralBlock] as unknown as Parameters<typeof magicUserMessage>[2]);
  // Pi 语义：m0 与 m1 是两条独立合成 user 消息（m0/m1 缓存分裂契约）。
  const m0Message = magicUserMessage(blocks.m0Text, source, muralBlocks);
  const m1Source: MagicMessageSource = {
    ...source,
    messageId: `${blocks.watermark}:m1`,
  };
  const m1Message = magicUserMessage(blocks.m1Text, m1Source, []);
  agent.inject(m0Message);
  agent.inject(m1Message);
  state.injectedGenerations.set(magicSessionId, generation);
  // 首轮 pre-step 前置用：本次 LLM 调用即可见（Pi transform unshift 语义）。
  state.lastInjectedMessages = [m0Message, m1Message];
  deps.log?.(
    `[magic-context] injected knowledge baseline ${blocks.watermark} for ${magicSessionId}@gen${generation}`,
  );
}

/** Resolve the canonical project identity for a session workspace. */
export function resolveKnowledgeProjectPath(directory: string | undefined): string | undefined {
  if (!directory || directory.length === 0) return undefined;
  try {
    return resolveProjectIdentityForSession(directory) || undefined;
  } catch {
    return undefined;
  }
}

/** Full gate body (host wait → track → knowledge → auto-search → next). */
export async function runKnowledgeGateStep(
  state: KnowledgeGateState,
  deps: KnowledgeGateDeps,
  payload: Pick<PreStepPayload, "agent" | "messages">,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const agent = payload.agent as unknown as KnowledgeAgentView;
  try {
    // Recursion isolation (PLAN §9): child sessions (subagents/workers) run
    // with official semantics — no Magic knowledge processing on children.
    if (isMagicChildSession(agent as unknown as import("@deepseek-ai/dsh-agent").Agent)) {
      return await next();
    }
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind === "ok") {
      const db = bootstrap.db;
      const magicSessionId = deps.host.canonicalKey(agent.id);
      const directory = sessionProjectPath(agent, deps.config.directory);
      const projectPath = resolveKnowledgeProjectPath(directory);

      // Session → project attribution (once per session).
      trackSessionProjectOnce(state.trackedSessions, db, magicSessionId, projectPath);

      // Knowledge baseline (once per surface generation).
      await maybeInjectKnowledge(state, deps, agent, db, magicSessionId, projectPath, directory);
      // Pi transform 语义：首轮注入的消息前置到本次调用的消息列表（立即可见）。
      // agent.inject 排队到下一批 pre-step；前置只影响本次调用，不写 surface，
      // 因此不会与下一批 surface 中的基线重复（watermark/状态去重）。
      if (state.lastInjectedMessages.length > 0) {
        const injected = state.lastInjectedMessages;
        state.lastInjectedMessages = [];
        (payload.messages as unknown[]).unshift(...injected);
      }

      // Auto-search hint on the incoming user message — fire-and-forget so the
      // pre-step chain is never delayed by search latency (3s cap inside).
      void maybeRunAutoSearchHint({
        db,
        sessionId: magicSessionId,
        projectPath: projectPath ?? "",
        messages: payload.messages,
        agent,
        config: deps.autoSearch,
        log: deps.log,
      }).catch((error: unknown) => {
        deps.log?.(
          `[magic-context] auto-search crashed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } else {
      deps.log?.(
        `[magic-context] knowledge gate skipped: storage bootstrap ${bootstrap.kind} (${String(bootstrap.detail)})`,
      );
    }
  } catch (error) {
    deps.log?.(
      `[magic-context] knowledge gate failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return await next();
}

/**
 * Register the knowledge gate as the OUTERMOST pre-step listener. The gate
 * never vetoes a step: it delays only until injection readiness and always
 * resolves the downstream decision.
 */
export function registerKnowledgeGate(ctx: Context, deps: KnowledgeGateDeps): () => boolean {
  const state = createKnowledgeGateState();
  return registerPreStepGate(ctx, (payload, next) =>
    runKnowledgeGateStep(state, deps, payload, next),
  );
}
