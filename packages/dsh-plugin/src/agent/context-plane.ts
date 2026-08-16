/**
 * agent/context-plane — the pre-step wiring of the context-management plane
 * (Phase 3): per-session outbox reconciliation + MutationPlan derivation +
 * serialized coordinator application. Runs INSIDE the agent pre-step
 * waterfall, after the knowledge gate (registered first, so this gate is
 * inner): drops/prefixes/reasoning/temporal ops land on the surface before the
 * request is derived — the Magic semantics (mutations visible to the current
 * step), executed through the surface CAS (never a direct rewrite).
 *
 * The historian plane (compartment publication + summarize hook + deferred
 * signals) registers alongside when its slice lands.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DshStorageBootstrap } from "../host/bootstrap";
import {
  registerPreStepGate,
  type PreStepDecision,
  type PreStepPayload,
} from "../compat/dsh-0.1/prestep";
import {
  createCoordinatorState,
  enqueuePlan,
  type CoordinatorHostView,
  type CoordinatorState,
} from "./coordinator";
import {
  initializeDshAdapterTables,
  reconcileSessionOutbox,
} from "./outbox";
import {
  deriveMutationPlan,
  readDshTranscript,
  type PlanContext,
} from "./transcript";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { checkDshCompartmentTrigger } from "./historian";
import { maybeNudgeChannels } from "./nudge";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { isMagicChildSession } from "./worker";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";

/** The host-service slice the context plane needs (structural view). */
export interface ContextPlaneHostView {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
}

export interface ContextPlaneConfig {
  enabled?: boolean;
  /** Protected-tag tail for drop selection (default 20). */
  protectedTags?: number;
  /** Heuristic cleanup options (routed from the shared config). */
  heuristicCleanup?: { readonly caveman?: { readonly enabled: boolean; readonly minChars: number } };
}

/** Historian background-pass plane (Phase 4): trigger + fire. */
export interface ContextPlaneHistorianConfig {
  enabled?: boolean;
  /** executeThresholdPercentage (default 65). */
  executeThresholdPercentage?: number;
  /** Minimum eligible tokens for a size-based fire (default 0 = off). */
  triggerBudgetTokens?: number;
  /** Model context window (<= 0 falls back to the shared 128k default). */
  contextLimit?: number;
  /** Commit-cluster trigger (shared semantics: enabled + min_clusters). */
  commitClusterTrigger?: { enabled: boolean; min_clusters: number };
}

/** Context-pressure read for the trigger (structural; injectable in tests). */
export interface ContextPressureSample {
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
}

export interface ContextPlaneDeps {
  readonly host: ContextPlaneHostView;
  readonly config?: ContextPlaneConfig;
  /** Heuristic cleanup config (routed from the shared config by the integrator). */
  readonly heuristicCleanup?: { readonly caveman?: { readonly enabled: boolean; readonly minChars: number } };
  /** Historian plane: fire the background compartment pass (fire-and-forget). */
  readonly historian?: {
    readonly config?: ContextPlaneHistorianConfig;
    /** Read the current context pressure (production: sessionProjections). */
    readPressure?: (agent: Agent) => ContextPressureSample | undefined;
    /** Fire one background historian pass for the session. */
    fire: (deps: {
      readonly db: Database;
      readonly sessionId: string;
      readonly directory?: string;
      readonly provider: RawMessageProvider;
    }) => void;
  };
  /** Workspace directory for the historian fire (project memory scope). */
  readonly directory?: string;
  readonly log?: (message: string) => void;
}

/** Per-plugin state (reset on plugin reload; the outbox is authoritative). */
export interface ContextPlaneState {
  readonly coordinator: CoordinatorState;
  /** sessionId → reconciliation already run this process. */
  readonly reconciled: Set<string>;
  /** Adapter tables already ensured for this process (idempotent init). */
  tablesInitialized: boolean;
}

export function createContextPlaneState(): ContextPlaneState {
  return {
    coordinator: createCoordinatorState(),
    reconciled: new Set(),
    tablesInitialized: false,
  };
}

/** DSH-log view adapter for the outbox reconciliation. */
function sessionLogView(
  db: Database,
  sessionId: string,
  agent: Agent,
  canonicalSessionId: string,
): { hasSeq(seq: number): boolean; generation: number } {
  const events = agent.session.events;
  const seqSet = new Set<number>();
  for (const event of events) {
    if (event !== null && typeof event === "object") {
      const seq = (event as { seq?: unknown }).seq;
      if (typeof seq === "number") seqSet.add(seq);
    }
  }
  return {
    hasSeq: (seq: number) => seqSet.has(seq),
    generation: agent.session.surface.replaceGeneration,
  };
}

/**
 * Lightweight commit-cluster signal (Pi/OpenCode parity in spirit): count
 * contiguous bursts of commit-hash mentions in the most recent assistant
 * texts. The shared trigger counts clusters in the chunk's TC scan; here the
 * session log is the same source, scanned conservatively (>= min_clusters
 * distinct bursts). Gated additionally by the eligible-token budget below.
 */
const COMMIT_MENTION_RE = /(?:^|[\s(`])[0-9a-f]{7,40}(?:$|[\s`)])/i;
export function recentCommitClusterCount(agent: Agent): number {
  try {
    const events = (agent.session as { events?: readonly unknown[] }).events ?? [];
    const texts: string[] = [];
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      const e = event as { type?: unknown; data?: { content?: unknown } };
      if (e.type !== "assistant/message") continue;
      const content = e.data?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string") texts.push(text);
          }
        }
      }
    }
    const recent = texts.slice(-10);
    let clusters = 0;
    let inCluster = false;
    for (const text of recent) {
      const hasCommit = COMMIT_MENTION_RE.test(text);
      if (hasCommit) {
        if (!inCluster) {
          clusters += 1;
          inCluster = true;
        }
      } else {
        inCluster = false;
      }
    }
    return clusters;
  } catch {
    return 0;
  }
}

/** Fire the historian pass when the context-pressure trigger fires. */
function maybeFireHistorian(
  historian: NonNullable<ContextPlaneDeps["historian"]>,
  db: Database,
  sessionId: string,
  agent: Agent,
  directory: string | undefined,
): void {
  try {
    const readPressure = historian.readPressure ?? (() => undefined);
    const sample = readPressure(agent);
    if (sample === undefined) return;
    const contextWindow = sample.contextWindow;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return;
    const percentage = Math.round(((sample.projectedTokens ?? 0) / contextWindow) * 100);
    const config = historian.config ?? {};
    const executeThresholdPercentage = config.executeThresholdPercentage ?? 65;
    // The shared trigger refuses to fire with a zero budget; the DSH adapter
    // derives it exactly like Pi does (deriveTriggerBudget over the context
    // window × threshold), instead of leaving triggerBudgetTokens at 0 (which
    // previously made the historian unreachable — it never fired on DSH).
    const contextLimit =
      typeof config.contextLimit === "number" && config.contextLimit > 0
        ? config.contextLimit
        : contextWindow;
    const forceFire = process.env.MAGIC_CONTEXT_FORCE_HISTORIAN === "1" && percentage >= 0;
    const commitCfg = config.commitClusterTrigger;
    const commitClusterFires =
      commitCfg !== undefined &&
      commitCfg.enabled !== false &&
      recentCommitClusterCount(agent) >= Math.max(1, commitCfg.min_clusters ?? 3) &&
      (config.triggerBudgetTokens ?? deriveTriggerBudget(contextLimit, executeThresholdPercentage)) > 0;
    const fires =
      forceFire ||
      commitClusterFires ||
      checkDshCompartmentTrigger(
        {
          executeThresholdPercentage,
          triggerBudget:
            config.triggerBudgetTokens ??
            deriveTriggerBudget(contextLimit, executeThresholdPercentage),
          contextLimit,
        },
        { lastContextPercentage: percentage },
      );
    if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN === "1") {
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[magic-context] historian trigger: pct=${percentage} threshold=${executeThresholdPercentage} budget=${config.triggerBudgetTokens ?? deriveTriggerBudget(contextLimit, executeThresholdPercentage)} window=${contextWindow} fires=${fires}`,
        );
      } catch {
        // Diagnostics must never break the pre-step chain.
      }
    }
    // 压力持久化（对齐 Pi persistPiPressureFromMessageEnd）：把最近一次的
    // 百分比写入 session_meta，供 /ctx-status 与共享状态读取。
    try {
      updateSessionMeta(db, sessionId, { lastContextPercentage: percentage });
    } catch {
      // 持久化失败不可破坏 pre-step 链（fail-open）。
    }
    if (fires) {
      historian.fire({
        db,
        sessionId,
        directory,
        provider: transcriptRawMessageProvider(agent as unknown as Agent, sessionId),
      });
    }
  } catch {
    // The trigger must never break the pre-step chain (fail-open).
  }
}

/**
 * First-call §N§ preview (Pi transform parity): the pre-step message list is
 * deep-frozen and the surface CAS replace only lands on the NEXT pass, so the
 * very first LLM call would otherwise see untagged messages. Assign tags via
 * the shared tagger (idempotent — later passes reuse the same tag numbers by
 * message id) and rebuild the frozen messages with the `§N§ ` prefix.
 * Never throws (fail-open); Magic-sourced messages (mc-kb / hints) are skipped.
 */
function previewTagPayloadMessages(
  db: Database,
  sessionId: string,
  messages: readonly unknown[],
  log?: (message: string) => void,
): void {
  try {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const out: unknown[] = [];
    for (const raw of messages) {
      const msg = raw as {
        id?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
        source?: { kind?: unknown };
      };
      const sourceKind = msg.source?.kind;
      if (sourceKind === "plugin" || sourceKind === "skill-catalog") {
        out.push(raw);
        continue;
      }
      const textPart = Array.isArray(msg.content)
        ? msg.content.find((part) => part !== null && typeof part === "object" && part.type === "text")
        : undefined;
      if (typeof msg.id !== "string" || msg.id.length === 0 || textPart === undefined) {
        out.push(raw);
        continue;
      }
      if (tagger.getTag(sessionId, msg.id, "message") !== undefined) {
        out.push(raw);
        continue;
      }
      const text = typeof textPart.text === "string" ? textPart.text : "";
      const tag = tagger.assignTag(sessionId, msg.id, "message", Buffer.byteLength(text), db);
      if (tag === undefined || tag <= 0) {
        out.push(raw);
        continue;
      }
      const newPart = { ...textPart, text: `\u00a7${tag}\u00a7 ${text}` };
      const newContent = (msg.content ?? []).map((part) => (part === textPart ? newPart : part));
      out.push({ ...msg, content: newContent });
    }
    (messages as unknown[]).length = 0;
    (messages as unknown[]).push(...out);
  } catch {
    // Preview must never break the pre-step chain (fail-open).
  }
}

/** The full pre-step body: reconcile → derive → apply → next. */
export async function runContextPlaneStep(
  state: ContextPlaneState,
  deps: ContextPlaneDeps,
  payload: Pick<PreStepPayload, "agent" | "messages">,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const agent = payload.agent as unknown as Agent;
  try {
    // Recursion isolation (PLAN §9): child sessions (subagents/workers) run
    // with official semantics — the Magic context plane never processes them.
    if (isMagicChildSession(agent)) return await next();
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind !== "ok") return await next();
    const db = bootstrap.db;
    const canonicalSessionId = deps.host.canonicalKey(agent.id);

    // Adapter tables (outbox saga) — the host bootstrap creates them, but a
    // direct user of this gate must not depend on the bootstrap having run.
    if (!state.tablesInitialized) {
      state.tablesInitialized = true;
      initializeDshAdapterTables(db);
    }

    // Startup/first-step reconciliation of the saga records.
    if (!state.reconciled.has(canonicalSessionId)) {
      state.reconciled.add(canonicalSessionId);
      reconcileSessionOutbox(db, canonicalSessionId, sessionLogView(db, canonicalSessionId, agent, canonicalSessionId));
    }

    // Plan derivation + application (gated by enabled; the historian trigger
    // below is independent of the plan gate).
    if (deps.config?.enabled !== false) {
      // 首轮 §N§ 预览：本次调用即可见（Pi transform 语义）；幂等。
      previewTagPayloadMessages(db, canonicalSessionId, payload.messages, deps.log);
      const view = readDshTranscript({
        session: {
          events: agent.session.events,
          surface: agent.session.surface,
          header: {},
        },
        canonicalSessionId,
      });
      const plan = deriveMutationPlan(view, {
        db,
        protectedTags: deps.config?.protectedTags ?? 20,
        heuristicCleanup: deps.heuristicCleanup,
      } satisfies PlanContext);
      if (plan !== null) {
        const hostView: CoordinatorHostView = {
          db,
          canonicalKey: (id: string) => deps.host.canonicalKey(id),
          log: deps.log,
        };
        await enqueuePlan(state.coordinator, hostView, agent.session, plan);
      }
    }

    // ctx_reduce 双通道 nudge（Pi parity）：inject `<system-reminder>`，
    // 决策/正文/状态持久化复用共享核心；fail-open。
    maybeNudgeChannels(db, canonicalSessionId, agent, {
      threshold: deps.historian?.config?.executeThresholdPercentage ?? 65,
      protectedTags: deps.config?.protectedTags ?? 20,
      log: deps.log,
    });

    // Historian plane: evaluate the context-pressure trigger and fire the
    // background compartment pass (fire-and-forget; never blocks the step).
    const historian = deps.historian;
    if (historian !== undefined && historian.config?.enabled !== false) {
      maybeFireHistorian(historian, db, canonicalSessionId, agent, deps.directory);
    }
  } catch (error) {    deps.log?.(
      `[magic-context] context plane failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return await next();
}

/**
 * Register the context plane as a pre-step gate. Registered BEFORE the
 * knowledge gate so the knowledge gate stays the outermost listener.
 */
export function registerContextPlane(ctx: Context, deps: ContextPlaneDeps): () => boolean {
  const state = createContextPlaneState();
  return registerPreStepGate(ctx, (payload, next) =>
    runContextPlaneStep(state, deps, payload, next),
  );
}
