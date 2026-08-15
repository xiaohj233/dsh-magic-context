/**
 * agent/dreamer — Phase 4 slice P1: Dreamer wiring (design docs/phase4-design.md §2.1).
 *
 * The Dreamer core owns the scheduler/lease/gate/telemetry chain; its ONLY
 * injection point is `TaskExecutor`, which drives a `DreamTimerClient`-shaped
 * session facade (`session.create/prompt/messages/list/delete`). This module
 * supplies the DSH half of that boundary:
 *
 *   1. `createDshDreamClient(ctx, deps)` — the client facade. `prompt` runs one
 *      direct `ctx.llm.stream` turn (system + user; `purpose` omitted — an
 *      ordinary auxiliary call). Dream agents whose prompts REQUIRE tools
 *      (curate / maintain-docs / refresh-primers / map-memories / verify /
 *      verify-broad) fail with an explicit "tool worker not wired" error
 *      instead of pretending a tool-less answer is valid. `messages` returns the
 *      synthetic OpenCode-shaped message list for the turn (text result +
 *      `toolCallCount = 0` synthetic tool parts — the Pi facade's trick).
 *
 *   2. `registerDshDreamer(ctx, deps)` — project discovery from
 *      `session_projects` (deduped, DSH-harness only) + one fiber-owned
 *      interval per project running the core scheduler pass
 *      (`runDueTasksForProject` with the shared facade). Call from the agent
 *      plane apply.
 *
 *   3. `dshDreamSeams(ctx, deps)` — the `CtxCommandSeams["dreamer"]` object
 *      `/ctx-dream` consumes (`tasks` / `executor` / `runnable` /
 *      `scheduleSummary`). Wire it into `registerCtxCommands`' options.
 *
 * Recorded deviations from the Phase 4 design:
 *
 *   - The design reuses core's process-wide `startDreamScheduleTimer`
 *     singleton. DSH self-builds ctx-owned intervals instead: the core
 *     singleton opens the DEFAULT shared DB path (unusable for per-test DBs and
 *     surprising when the bootstrap opened an overridden path), drags in
 *     OpenCode-only maintenance sweeps (opencode.db orphan sweeps), and its
 *     module-level timer state is not fiber-owned. Each DSH interval drives the
 *     exact same scheduler pass the singleton's tick runs for the dream
 *     portion (`runDueTasksForProject` → lease/gate/telemetry). The
 *     singleton's extra maintenance (message-history privacy sweep, compiled
 *     smart-note surfacing, embedding backfill) is deferred to a later slice.
 *   - Tool workers (`ctx.subagents.start` + `toolFilter` allowlist) are a
 *     Phase 4 follow-up / integrator decision; this slice is direct-LLM only.
 *   - `createDshDreamClient`'s `db` parameter is accepted per contract but
 *     reserved (the facade is in-memory, exactly like the Pi facade); `log` is
 *     used for diagnostics.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "../compat/dsh-0.1/session";
import { DSH_HARNESS } from "@xiao_hj909/magic-context-for-dsh-adapter";
import {
  DreamerConfigSchema,
  type DreamerConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
  buildDreamTaskRuntimeConfigs,
  summarizeDreamSchedule,
  userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "@magic-context/core/features/magic-context/dreamer/task-executor";
import { runDueTasksForProject } from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { describeError } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { DshStorageBootstrap } from "../host/bootstrap";
import type { CtxCommandSeams } from "./commands";

/** Default dream tick (mirrors core's DREAM_TIMER_INTERVAL_MS: 15 minutes). */
export const DEFAULT_DREAM_TICK_MS = 15 * 60 * 1000;

/**
 * Dream agents whose prompts REQUIRE tools — a direct single-turn LLM call
 * cannot produce a valid result for them. Mirrors the tool profiles in core
 * `agents/dreamer.ts` + `agents/hidden-agent-registrations.ts`:
 *   - `dreamer`                    (curate)              → ctx_memory only
 *   - `dreamer-docs`               (maintain-docs)       → read/grep/glob/bash/write/edit/aft
 *   - `dreamer-primer-investigator`(refresh-primers)     → read-only code investigation
 *   - `dreamer-memory-mapper`      (map-memories/verify/verify-broad) → read-only source reader
 * The remaining dream agents are zero-tool single-shot transforms and work
 * through the direct LLM path: `dreamer-classifier` (classify-memories +
 * compress-cues), `smart-note-compiler` (evaluate-smart-notes),
 * `dreamer-reviewer` (review-user-memories), `dreamer-retrospective` (friction
 * gate + deepen turns). Tool workers are a Phase 4 follow-up / integrator
 * decision (ctx.subagents.start + toolFilter allowlist).
 */
const TOOL_REQUIRING_DREAM_AGENTS = new Set([
  "dreamer",
  "dreamer-docs",
  "dreamer-primer-investigator",
  "dreamer-memory-mapper",
]);

/** Magic-owned message source marker for dreamer LLM turns. */
const DREAM_SOURCE = { kind: "plugin", plugin: "magic-context" } as const;

/** Wiring deps for {@link registerDshDreamer}. */
export interface DreamerWiringDeps {
  /** The host service (ready + canonical session-key derivation). */
  readonly host: {
    readonly ready: Promise<DshStorageBootstrap>;
    canonicalKey(id: string): string;
  };
  /** Agent-plane workspace directory (the executor's `sessionDirectory`). */
  readonly directory?: string;
  /** DSH dreamer config. `enabled` gates both the timer and the /ctx-dream
   *  seam (`runnable`); `tickMs` defaults to 15 minutes. */
  readonly config?: { enabled?: boolean; tickMs?: number };
  readonly log?: (message: string) => void;
}

/** Deps for {@link createDshDreamClient}. */
export interface DshDreamClientDeps {
  /** Reserved (per contract): the facade is in-memory like the Pi facade;
   *  `db` is accepted for signature stability / future persistence. */
  readonly db: Database;
  readonly log?: (message: string) => void;
}

/* ─────────────────────────── client facade ────────────────────────────── */

/** `session.prompt` args as the core executor builds them. */
export interface DreamFacadePromptArgs {
  path: { id: string };
  query?: { directory?: string };
  body?: {
    agent?: string;
    system?: string;
    model?: { providerID: string; modelID: string };
    parts?: Array<{ type?: string; text?: string }>;
  };
  signal?: AbortSignal | null;
}

/**
 * The DSH mirror of core's `DreamTimerClient` (the surface the dreamer
 * executor consumes). Structural — the core types the facade against the
 * OpenCode SDK client; DSH casts at the boundary exactly like the Pi facade.
 */
export interface DshDreamSessionFacade {
  session: {
    create(args: {
      body?: { parentID?: string; title?: string };
      query?: { directory?: string };
    }): Promise<{ id: string }>;
    list(args: { query?: { directory?: string } }): Promise<{ data: Array<{ id: string }> }>;
    prompt(args: DreamFacadePromptArgs): Promise<unknown>;
    messages(args: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data: unknown[] }>;
    delete(args: { path: { id: string } }): Promise<Record<string, never>>;
    abort(args: { path: { id: string } }): Promise<Record<string, never>>;
  };
}

/** In-memory synthetic dream session (mirror of the Pi facade's sessionsById). */
interface DreamSessionRecord {
  id: string;
  directory: string;
  title?: string;
  messages: unknown[];
}

type SyntheticPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: { input: { description: string } } };

/**
 * Build `toolCallCount` synthetic tool parts so the shared
 * `investigationToolCallCount` / `extractToolCallSummaries` consumers see the
 * agent's investigation. P1 is direct-LLM only, so the count is always 0 (the
 * parts list is empty) — kept to mirror the Pi facade and document intent.
 */
function syntheticToolParts(count: number): SyntheticPart[] {
  const safe = Math.max(0, Math.floor(count));
  return Array.from({ length: safe }, () => ({
    type: "tool" as const,
    tool: "investigation",
    state: { input: { description: "investigation step" } },
  }));
}

/** OpenCode-shaped synthetic message (mirror of the Pi facade's makeMessage). */
function makeMessage(role: "user" | "assistant", parts: SyntheticPart[]): unknown {
  return {
    info: { role, time: { created: Date.now() } },
    parts,
  };
}

function extractUserMessage(args: DreamFacadePromptArgs): string {
  const parts = args.body?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => part?.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
}

function extractSystemPrompt(args: DreamFacadePromptArgs): string | undefined {
  const system = args.body?.system;
  return typeof system === "string" && system.length > 0 ? system : undefined;
}

function extractBodyAgent(args: DreamFacadePromptArgs): string | undefined {
  const agent = args.body?.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

function extractBodyModel(
  args: DreamFacadePromptArgs,
): { providerID: string; modelID: string } | undefined {
  const model = args.body?.model;
  if (!model || typeof model !== "object") return undefined;
  const { providerID, modelID } = model;
  return typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : undefined;
}

/** Read the LLM runtime without declaring a hard inject (optional service). */
function readLlm(ctx: Context): LlmRuntime | undefined {
  return ctx.get("llm") as LlmRuntime | undefined;
}

/** Resolve the current provider/model route (fresh per call; same as the
 *  historian wiring). */
function currentRoute(ctx: Context): { provider: string; model: string } {
  const defaultModel = ctx.get("agentDefaultModel") as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined;
  const selection = defaultModel?.currentSelection?.();
  return {
    provider: selection?.provider ?? "deepseek",
    model: selection?.model ?? "deepseek-chat",
  };
}

/** Per-attempt model: body.model (the executor's per-task override) wins,
 *  else the current session route. */
function resolveDreamModel(
  ctx: Context,
  bodyModel: { providerID: string; modelID: string } | undefined,
): { provider: string; model: string } {
  if (bodyModel) return { provider: bodyModel.providerID, model: bodyModel.modelID };
  return currentRoute(ctx);
}

/** One direct `ctx.llm.stream` turn; returns the assembled assistant text.
 *  `purpose` is intentionally omitted — an ordinary auxiliary call, not a
 *  compaction/session-title classified one. */
async function streamDreamTurn(
  ctx: Context,
  opts: { system?: string; userText: string; model: { provider: string; model: string }; signal?: AbortSignal },
): Promise<string> {
  const llm = readLlm(ctx);
  if (llm === undefined) {
    throw new Error("magic-context: llm service unavailable (dreamer wiring)");
  }
  const user = createUserMessage({
    content: [{ type: "text", text: opts.userText }],
    source: DREAM_SOURCE,
  });
  let text = "";
  let failed: string | undefined;
  for await (const chunk of llm.stream({
    provider: opts.model.provider,
    model: opts.model.model,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [user],
    signal: opts.signal,
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish") {
      if (chunk.reason.kind === "error") {
        failed = chunk.reason.failure?.message ?? "error finish";
      } else if (chunk.reason.kind === "aborted") {
        failed = "aborted";
      }
    }
  }
  if (failed !== undefined) {
    throw new Error(`magic-context: dreamer LLM stream failed (${failed})`);
  }
  if (text.trim().length === 0) {
    throw new Error("magic-context: dreamer LLM stream returned no text");
  }
  return text;
}

/**
 * Create the DSH DreamTimerClient facade. One instance is shared by the
 * schedule timer AND the /ctx-dream seam (same synthetic session table), like
 * the Pi facade. Direct-LLM only in P1; tool-requiring dream agents throw an
 * explicit "tool worker not wired" error (classified by the core executor as a
 * PERMANENT failure — the message intentionally avoids the transient-failure
 * vocabulary so the task advances to its next cron slot instead of hot-retrying).
 */
export function createDshDreamClient(ctx: Context, deps: DshDreamClientDeps): DshDreamSessionFacade {
  const log = deps.log ?? (() => {});
  const sessions = new Map<string, DreamSessionRecord>();
  let sessionCounter = 0;

  const session: DshDreamSessionFacade["session"] = {
    create: async (args) => {
      const sessionId = `magic-context-dsh-dream-${++sessionCounter}`;
      sessions.set(sessionId, {
        id: sessionId,
        directory: args.query?.directory ?? "",
        title: args.body?.title,
        messages: [],
      });
      return { id: sessionId };
    },
    // The executor uses session.list only to resolve a parent session for
    // child-invocation telemetry (OpenCode-specific). DSH dream children stay
    // top-level in P1 — an empty list mirrors the Pi facade.
    list: async () => ({ data: [] }),
    prompt: async (args: DreamFacadePromptArgs) => {
      const dreamSession = sessions.get(args.path.id);
      if (!dreamSession) {
        throw new Error(`dsh dreamer session not found: ${args.path.id}`);
      }
      if (args.signal?.aborted) {
        throw new Error("prompt aborted by external signal");
      }
      const agent = extractBodyAgent(args);
      if (agent !== undefined && TOOL_REQUIRING_DREAM_AGENTS.has(agent)) {
        // Explicit, non-transient failure: tool worker wiring (ctx.subagents.start
        // + toolFilter allowlist) is a Phase 4 follow-up / integrator decision.
        throw new Error(
          `dreamer tool worker not wired for agent "${agent}": this task requires tools ` +
            `(ctx_memory / read / grep / write / edit), which the direct-LLM facade cannot provide. ` +
            `Wire ctx.subagents.start workers in a later Phase 4 slice or disable this task.`,
        );
      }
      const userText = extractUserMessage(args);
      const model = resolveDreamModel(ctx, extractBodyModel(args));
      try {
        const text = await streamDreamTurn(ctx, {
          system: extractSystemPrompt(args),
          userText,
          model,
          signal: args.signal ?? undefined,
        });
        dreamSession.messages = [
          makeMessage("user", [{ type: "text", text: userText }]),
          makeMessage("assistant", [...syntheticToolParts(0), { type: "text", text }]),
        ];
        return {};
      } catch (error) {
        log(`[dreamer] prompt failed for ${dreamSession.id} (${agent ?? "default"}): ${describeError(error).brief}`);
        throw error;
      }
    },
    messages: async (args) => {
      return { data: sessions.get(args.path.id)?.messages ?? [] };
    },
    delete: async (args) => {
      sessions.delete(args.path.id);
      return {};
    },
    // Best-effort server-side abort hook (model-suggestion-retry calls it on
    // timeout/abort). The DSH stream is already cancelled via the signal; a
    // no-op is correct here.
    abort: async () => ({}),
  };

  return { session };
}

/* ─────────────────────────── scheduler wiring ─────────────────────────── */

/** Module state shared between registerDshDreamer and dshDreamSeams. */
interface DreamerRuntimeState {
  enabled: boolean;
  tickMs: number;
  coreConfig: DreamerConfig;
  directory: string;
  /** Lazily created once; both the timer and the seam share one facade. */
  facade: DshDreamSessionFacade | null;
}

const dreamerRuntime = new WeakMap<object, DreamerRuntimeState>();

/** Synthesize the core DreamerConfig from the minimal DSH config: enabled →
 *  the core's default per-task schedules (v1-preserving); DSH has no
 *  per-task config surface in P1. */
function synthesizeDreamerConfig(): DreamerConfig {
  return DreamerConfigSchema.parse({});
}

function defaultState(): DreamerRuntimeState {
  return {
    enabled: true,
    tickMs: DEFAULT_DREAM_TICK_MS,
    coreConfig: synthesizeDreamerConfig(),
    directory: process.cwd(),
    facade: null,
  };
}

/** Deduped DSH project list from session_projects (discovery source; the
 *  session-track slice records these rows). DSH-harness only — the shared DB
 *  may also carry OpenCode/Pi rows whose projects this process must not sweep. */
export function discoverDreamProjects(db: Database): string[] {
  const rows = db
    .prepare<[string], { project_path: string }>(
      `SELECT DISTINCT project_path
         FROM session_projects
        WHERE harness = ?
          AND project_path IS NOT NULL
          AND TRIM(project_path) <> ''
        ORDER BY project_path`,
    )
    .all(DSH_HARNESS);
  return rows.map((row) => row.project_path);
}

/** The TaskExecutor the scheduler drives: core `createDreamTaskExecutor`
 *  closed over the DSH facade. `openOpenCodeDb` → null (no OpenCode store);
 *  no retrospective raw provider (retrospective becomes a clean no-op until a
 *  DSH raw-source provider lands); no mural (compress-cues no-ops). */
function buildDreamExecutor(
  facade: DshDreamSessionFacade,
  state: DreamerRuntimeState,
): ReturnType<typeof createDreamTaskExecutor> {
  return createDreamTaskExecutor({
    client: facade as never,
    sessionDirectory: state.directory,
    openOpenCodeDb: () => null,
    userMemoryCollectionEnabled: userMemoryCollectionEnabled(state.coreConfig),
  });
}

/** One per-project scheduler pass (the timer tick body). */
async function runDreamTick(
  db: Database,
  projectIdentity: string,
  executor: ReturnType<typeof createDreamTaskExecutor>,
  state: DreamerRuntimeState,
  log: (message: string) => void,
): Promise<void> {
  try {
    const ran = await runDueTasksForProject({
      db,
      projectIdentity,
      // Full canonical set (disabled tasks get their rows reconciled to
      // next_due_at NULL by the scheduler, so config stays authoritative).
      tasks: buildDreamTaskRuntimeConfigs(state.coreConfig),
      executor,
    });
    if (ran > 0) log(`[dreamer] timer tick ${projectIdentity} — ran ${ran} task(s)`);
  } catch (error) {
    log(`[dreamer] timer tick failed for ${projectIdentity}: ${describeError(error).brief}`);
  }
}

type IntervalFactory = (fn: () => void, ms: number) => () => void;

/** Default interval factory: a Node setInterval, unref'd (the timer must not
 *  hold the process open), disposed by clearInterval. */
function defaultIntervalFactory(fn: () => void, ms: number): () => void {
  const handle = setInterval(fn, ms);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref(): void }).unref();
  }
  return () => clearInterval(handle);
}

let intervalFactory: IntervalFactory = defaultIntervalFactory;

/**
 * Register the DSH dreamer plane: await host.ready → discover projects from
 * session_projects → one ctx-owned interval per project (default 15 min)
 * running the core scheduler pass, plus an immediate initial pass per project
 * (mirrors the core timer's startup sweep). Every side effect is fiber-owned
 * via one ctx.effect; disposal stops the timers.
 *
 * Also publishes the shared runtime state (config + facade) that
 * {@link dshDreamSeams} reads, so the timer and /ctx-dream share one facade.
 *
 * Deviation: the design's core process-wide `startDreamScheduleTimer`
 * singleton is NOT reused — see the module header for the rationale.
 */
export function registerDshDreamer(ctx: Context, deps: DreamerWiringDeps): void {
  const log = deps.log ?? (() => {});
  const enabled = deps.config?.enabled !== false;
  const rawTick = deps.config?.tickMs;
  const tickMs =
    typeof rawTick === "number" && Number.isFinite(rawTick) && rawTick > 0
      ? rawTick
      : DEFAULT_DREAM_TICK_MS;
  const state: DreamerRuntimeState = {
    enabled,
    tickMs,
    coreConfig: synthesizeDreamerConfig(),
    directory: deps.directory ?? process.cwd(),
    facade: null,
  };
  dreamerRuntime.set(ctx, state);

  const disposers: Array<() => void> = [];
  let stopped = false;
  ctx.effect(
    () => () => {
      stopped = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Best-effort disposal.
        }
      }
    },
    "dreamer-timer",
  );

  if (!enabled) {
    log("[dreamer] disabled (config.enabled=false) — no schedule timer; /ctx-dream will report runnable=false");
    return;
  }

  void (async () => {
    let boot: DshStorageBootstrap;
    try {
      boot = await deps.host.ready;
    } catch (error) {
      log(`[dreamer] host bootstrap failed — timer not started: ${describeError(error).brief}`);
      return;
    }
    if (stopped) return;
    if (boot.kind !== "ok") {
      log(`[dreamer] host bootstrap ${boot.kind} (${boot.reason}) — timer not started`);
      return;
    }
    try {
      const db = boot.db;
      const projects = discoverDreamProjects(db);
      if (projects.length === 0) {
        log("[dreamer] no projects discovered from session_projects — timer idle");
        return;
      }
      const facade = (state.facade ??= createDshDreamClient(ctx, { db, log }));
      const executor = buildDreamExecutor(facade, state);
      for (const projectIdentity of projects) {
        disposers.push(
          intervalFactory(() => {
            void runDreamTick(db, projectIdentity, executor, state, log);
          }, tickMs),
        );
        log(
          `[dreamer] registered schedule timer for ${projectIdentity} (every ${Math.round(tickMs / 60_000)}m; projects=${projects.length})`,
        );
      }
      // Initial pass per project (the core timer's startup sweep equivalent) so
      // a fresh install does not wait a full tick for seeding.
      for (const projectIdentity of projects) {
        void runDreamTick(db, projectIdentity, executor, state, log);
      }
    } catch (error) {
      log(`[dreamer] registration failed: ${describeError(error).brief}`);
    }
  })();
}

/**
 * Build the `CtxCommandSeams["dreamer"]` object for `/ctx-dream`:
 *   - tasks      — runtime configs for ENABLED tasks (schedule != "") in
 *                  canonical order;
 *   - executor   — core createDreamTaskExecutor over the shared facade;
 *   - runnable   — config.enabled && !compaction-off (compaction-off is read
 *                  structurally off the agent-plane config's
 *                  `commands.compactionOff`, the same flag registerCtxCommands
 *                  gates on; absent → compaction is on);
 *   - scheduleSummary — simple text from the core summarizeDreamSchedule.
 */
export function dshDreamSeams(
  ctx: Context,
  deps: { db: Database; log?: (message: string) => void; compactionOff?: boolean },
): NonNullable<CtxCommandSeams["dreamer"]> {
  const state = dreamerRuntime.get(ctx) ?? defaultState();
  const facade = (state.facade ??= createDshDreamClient(ctx, deps));
  const executor = buildDreamExecutor(facade, state);
  const tasks = buildDreamTaskRuntimeConfigs(state.coreConfig).filter(
    (task) => task.schedule.trim() !== "",
  );
  const runnable = state.enabled && !readDreamerCompactionOff(deps);
  return {
    tasks,
    executor,
    runnable,
    scheduleSummary: summarizeDreamSchedule(state.coreConfig),
  };
}

/**
 * Compaction-off is agent-plane integrator config (`config.commands.compactionOff`,
 * the same flag /ctx-flush and /ctx-recomp gate on). The agent-plane apply
 * threads it through the deps — NEVER read `ctx.config` as a property (cordis
 * throws on undeclared property access).
 */
function readDreamerCompactionOff(deps: { compactionOff?: boolean }): boolean {
  return deps.compactionOff === true;
}

/* ────────────────────────────── test seam ─────────────────────────────── */

export const __test = {
  /** Replace the interval factory (fake timers in tests). */
  setIntervalFactory(factory: IntervalFactory | null): void {
    intervalFactory = factory ?? defaultIntervalFactory;
  },
  reset(): void {
    intervalFactory = defaultIntervalFactory;
    // Runtime state is keyed by ctx in a WeakMap and garbage-collected with
    // it, so only the factory needs restoring.
  },
};
