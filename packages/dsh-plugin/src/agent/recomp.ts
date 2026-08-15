/**
 * agent/recomp — Phase 4 slice P3: recomp / wrapup / session-upgrade wiring.
 *
 * Design: docs/phase4-design.md decision 3. The managed orchestrators'
 * (`runManagedRecomp` / `runManagedWrapup` / `runManagedUpgrade`) ONLY harness
 * injection point is `ManagedRecompContext.client` — an OpenCode-shaped
 * `client.session.{get,create,prompt,promptAsync,messages,delete}` facade.
 * This module provides:
 *
 *   1. {@link createDshSessionClient} — the DSH facade backed by
 *      `ctx.llm.stream(GenerateOptions)` (no subprocess, no tools):
 *        - `create`   — opaque child-session id (parentID tracked for abort);
 *        - `prompt`   — one LLM call: user = parts text, system = the prompt
 *          body's `system` or the registered Magic historian agent prompt
 *          (`historian` / `historian-recomp` / `historian-editor`), model =
 *          per-attempt `body.model` override (the shared fallback layer drives
 *          fallbacks by rewriting `body.model`), timeout/abort via
 *          AbortSignal + Promise.race, `purpose: "compaction"`;
 *        - `messages` — the synthetic assistant message for the shared
 *          output-extraction / validation-retry layer
 *          (`extractLatestAssistantText`); `delete`/`abort` no-op; `noReply`
 *          prompts surface their text through `log` and never call the LLM.
 *   2. {@link createRecompSeams} — the `CtxCommandSeams` runners
 *      (`runRecomp` / `runWrapup` / `runUpgrade`): build the managed contexts
 *      and delegate to the shared core orchestrators, with the transcript-
 *      backed raw-message provider registered for the WHOLE run
 *      (`withRawMessageProvider`) so `readSessionChunk` has a source. Every
 *      failure returns an error TEXT — the command layer expects a string,
 *      nothing throws out of the seams.
 *
 * DSH adjustments over the OpenCode/Pi wiring (documented deviations):
 *   - no config file: `fallbackModels` is empty by default and
 *     `runMigration` defaults to `memoryEnabled` (the once-per-project memory
 *     migration runs with the session's live model as its primary, which DSH
 *     always resolves from the agent's options — OpenCode gates on
 *     `historian.model` being configured, DSH has no historian model config);
 *   - `liveSessionState` is a fresh per-instance state (DSH has no TUI
 *     sidebar; the orchestrator's progress maps are still populated so
 *     future surfaces can read them);
 *   - the seam-level `signal` is linked to the client's in-flight prompt
 *     (abort cancels the LLM call; the shared retry converts it to a
 *     recognized "prompt aborted by external signal" error).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  COMPARTMENT_AGENT_SYSTEM_PROMPT,
  COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
  HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { createLiveSessionState } from "@magic-context/core/hooks/magic-context/live-session-state";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
  runManagedRecomp,
  runManagedUpgrade,
  type ManagedRecompContext,
} from "@magic-context/core/hooks/magic-context/recomp-orchestrator";
import {
  runManagedWrapup,
  type ManagedWrapupContext,
} from "@magic-context/core/hooks/magic-context/wrapup-orchestrator";
import { describeError } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createUserMessage } from "../compat/dsh-0.1/session";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { parseRecompArgs, type CtxCommandSeams } from "./commands";
import { transcriptRawMessageProvider } from "./historian-wiring";

/* ─────────────────────────── defaults & constants ─────────────────────────── */

/** Default chunk token budget for recomp/wrapup historian passes. */
export const DEFAULT_RECOMP_CHUNK_TOKENS = 16_000;

/** Default per-attempt historian timeout (ms). */
export const DEFAULT_RECOMP_TIMEOUT_MS = 120_000;

/** Default client-level per-prompt wall-clock timeout (ms) — the shared retry
 *  already enforces the per-attempt timeout via its own AbortController; this
 *  is the backstop for prompt calls made without a signal. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 300_000;

/** Default main-model context window for wrapup boundary planning. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

/** Default execute-threshold percentage for wrapup boundary planning. */
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;

/**
 * Magic historian agent ids → their registered system prompts. OpenCode loads
 * these from its agent registry; DSH has no agent registry, so the client
 * injects the registered prompt itself when the prompt body does not carry an
 * explicit `system` (memory-migration passes `system` explicitly and wins).
 */
const HISTORIAN_SYSTEM_PROMPTS: ReadonlyMap<string, string> = new Map([
  ["historian", COMPARTMENT_AGENT_SYSTEM_PROMPT],
  ["historian-recomp", COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT],
  ["historian-editor", HISTORIAN_EDITOR_SYSTEM_PROMPT],
]);

/* ──────────────────────────── session client ──────────────────────────────── */

/** Deps for {@link createDshSessionClient}. */
export interface DshSessionClientDeps {
  /** Cordis context — source of the optional `llm` service (read via ctx.get). */
  ctx: Context;
  /** Shared Magic SQLite (reserved for the orchestrator contract; unused by
   *  the facade today). */
  db: Database;
  /** Logger sink (also the minimal `noReply`/notify channel). */
  log?: (message: string) => void;
  /** Injectable LLM runtime (tests). Defaults to `ctx.get("llm")`. */
  llm?: LlmRuntime;
  /** Directory reported by `session.get` / treated as the prompt's cwd. */
  directory?: string;
  /** Per-prompt wall-clock timeout (ms); 0 disables. Default 300_000. */
  timeoutMs?: number;
  /** Default provider/model route when the prompt body has no model override. */
  defaultRoute?: () => { provider: string; model: string };
}

/** One synthetic assistant message returned by `session.messages` (the shared
 *  extractor reads `info.role` / `info.time.created` / `parts[].text`). */
export interface DshClientMessage {
  info: { role: "assistant"; time: { created: number } };
  parts: Array<{ type: "text"; text: string }>;
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
}

/** The OpenCode-shaped session facade (structural subset of the SDK client). */
export interface DshSessionClient {
  session: {
    get(input?: unknown): Promise<{ data: { directory?: string } }>;
    create(input?: unknown): Promise<{ id: string }>;
    prompt(input: unknown): Promise<Record<string, never>>;
    promptAsync(input: unknown): Promise<Record<string, never>>;
    messages(input?: unknown): Promise<{ data: readonly DshClientMessage[] }>;
    delete(input?: unknown): Promise<Record<string, never>>;
    abort(input?: unknown): Promise<Record<string, never>>;
  };
  /** Non-contract helper: cancel the in-flight LLM prompt of the child
   *  session(s) created under `parentSessionId` (the seam links the
   *  invocation's AbortSignal to this). */
  abortFor(parentSessionId: string): void;
}

interface PromptInput {
  path?: { id?: unknown };
  query?: { directory?: unknown };
  body?: {
    agent?: unknown;
    system?: unknown;
    model?: unknown;
    parts?: unknown;
    noReply?: unknown;
  };
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPromptInput(input: unknown): PromptInput {
  if (!isRecord(input)) return {};
  const path = isRecord(input.path) ? input.path : undefined;
  const body = isRecord(input.body) ? input.body : undefined;
  const query = isRecord(input.query) ? input.query : undefined;
  const signal = input.signal instanceof AbortSignal ? input.signal : undefined;
  return { path, query, body, signal };
}

/** Text parts → one user string (Pi `extractPromptText` mirror). */
function extractPromptText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (isRecord(part) ? part.text : undefined))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
}

/** Per-attempt model override from the prompt body (`{providerID, modelID}`). */
function readBodyModel(model: unknown): { provider: string; model: string } | undefined {
  if (!isRecord(model)) return undefined;
  const { providerID, modelID } = model;
  if (typeof providerID === "string" && providerID.length > 0 && typeof modelID === "string" && modelID.length > 0) {
    return { provider: providerID, model: modelID };
  }
  return undefined;
}

/** Resolve the system prompt: explicit body.system wins, else the registered
 *  Magic historian agent prompt for body.agent (OpenCode registry emulation). */
function resolveSystemPrompt(body: PromptInput["body"]): string | undefined {
  if (typeof body?.system === "string" && body.system.length > 0) return body.system;
  if (typeof body?.agent === "string") return HISTORIAN_SYSTEM_PROMPTS.get(body.agent);
  return undefined;
}

/** Resolve the current provider/model route (fresh per call; mirrors the
 *  historian wiring's `currentRoute`). Tolerates a ctx without `get` so the
 *  client stays unit-testable with an injected `defaultRoute`/`llm`. */
function currentRoute(ctx: Context): { provider: string; model: string } {
  const get = typeof ctx.get === "function" ? ctx.get.bind(ctx) : undefined;
  const defaultModel = get?.("agentDefaultModel") as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined;
  const selection = defaultModel?.currentSelection?.();
  return {
    provider: selection?.provider ?? "deepseek",
    model: selection?.model ?? "deepseek-chat",
  };
}

function makeDshClientMessage(text: string): DshClientMessage {
  return {
    info: { role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text }],
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

/**
 * Build the OpenCode-shaped session client over `ctx.llm.stream()`.
 *
 * Prompt semantics (client contract):
 *   - `noReply: true` → the text is a status notification: surface it via
 *     `log` and return `{}` WITHOUT an LLM call (minimal notify semantics);
 *   - otherwise run ONE `ctx.llm.stream` call with `purpose: "compaction"`,
 *     the parts text as the single user message, the resolved system prompt,
 *     and the per-attempt model override (`body.model`) when present;
 *   - timeout/abort: the shared retry passes its own AbortController signal
 *     (linked to its per-attempt timeout); the client ALSO races its own
 *     `timeoutMs` timer against the stream so direct callers without a signal
 *     still time out. Recognizable messages ("prompt timed out after Nms" /
 *     "prompt aborted by external signal") keep the shared retry's
 *     non-retryable classification correct;
 *   - `messages` returns the synthetic assistant message for the just-finished
 *     prompt (the shared `fetchOutput`/validation-retry layer reads it);
 *   - `delete`/`abort` are no-ops (DSH child sessions are in-memory only).
 */
export function createDshSessionClient(deps: DshSessionClientDeps): DshSessionClient {
  const ctx = deps.ctx;
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const defaultRoute = deps.defaultRoute ?? (() => currentRoute(ctx));
  const outputBySession = new Map<string, string>();
  const activeBySession = new Map<string, { controller: AbortController; external: boolean }>();
  const parentByChild = new Map<string, string>();
  let counter = 0;

  async function runPrompt(input: unknown): Promise<Record<string, never>> {
    const { path, body, signal } = readPromptInput(input);
    const sessionId = typeof path?.id === "string" ? path.id : "";
    const text = extractPromptText(body?.parts);

    if (body?.noReply === true) {
      // Minimal noReply semantics: this is a status notification, not a model
      // prompt — surface the text and return without any LLM call.
      if (text.length > 0) log(`[magic-context] notify(${sessionId}): ${text}`);
      return {};
    }
    if (text.length === 0) {
      log(`[magic-context] prompt(${sessionId}): empty parts — skipped`);
      return {};
    }

    const llm = deps.llm ?? (ctx.get("llm") as LlmRuntime | undefined);
    if (llm === undefined) {
      throw new Error("magic-context: llm service unavailable (recomp client)");
    }
    const route = readBodyModel(body?.model) ?? defaultRoute();
    const system = resolveSystemPrompt(body);
    const user = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: "magic-context" },
    });

    const controller = new AbortController();
    const active: { controller: AbortController; external: boolean } = { controller, external: false };
    activeBySession.set(sessionId, active);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise =
      timeoutMs > 0
        ? new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              controller.abort(); // cancel the stream at the source
              resolve("timeout");
            }, timeoutMs);
          })
        : new Promise<"timeout">(() => {
            // never resolves — timeout disabled
          });

    let output = "";
    let failed: string | undefined;
    try {
      const collected = (async (): Promise<"done"> => {
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          system,
          messages: [user],
          purpose: "compaction",
          signal: controller.signal,
        } satisfies GenerateOptions)) {
          if (chunk.type === "text-delta") {
            output += chunk.text;
          } else if (chunk.type === "finish") {
            if (chunk.reason.kind === "error") {
              const failure = (chunk.reason as { failure?: { message?: string } }).failure;
              failed = failure?.message ?? "error finish";
            } else if (chunk.reason.kind === "aborted") {
              failed = "aborted";
            }
          }
        }
        return "done";
      })();
      const winner = await Promise.race([collected, timeoutPromise]);
      if (winner === "timeout") {
        throw new Error(`prompt timed out after ${timeoutMs}ms`);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      activeBySession.delete(sessionId);
    }

    if (failed === "aborted") {
      // Aborted finish without our timeout having fired: either an external
      // abort — the prompt's own signal (the shared retry converts this back
      // to its own "timed out" error when ITS timeout fired) or the seam's
      // invocation signal via abortFor — or the adapter aborted.
      if (active.external || signal?.aborted === true) {
        throw new Error("prompt aborted by external signal");
      }
      throw new Error("magic-context: historian LLM stream aborted");
    }
    if (failed !== undefined) {
      throw new Error(`magic-context: historian LLM stream failed (${failed})`);
    }
    outputBySession.set(sessionId, output);
    return {};
  }

  return {
    session: {
      get: async () => {
        const directory = deps.directory;
        return { data: directory ? { directory } : {} };
      },
      create: async (input) => {
        const record = isRecord(input) ? input : {};
        const body = isRecord(record.body) ? record.body : {};
        const id = `dsh-magic-context-recomp-${++counter}`;
        const parentID = typeof body.parentID === "string" ? body.parentID : "";
        if (parentID.length > 0) parentByChild.set(id, parentID);
        return { id };
      },
      prompt: runPrompt,
      promptAsync: runPrompt,
      messages: async (input) => {
        const pathId = readPromptInput(input).path?.id;
        const sessionId = typeof pathId === "string" ? pathId : "";
        const output = outputBySession.get(sessionId);
        // Unknown child → no messages (never prompted); a stored empty output
        // still yields a message so the shared extractor returns null and the
        // validation/fallback layer escalates (ok-but-empty semantics).
        return { data: output !== undefined ? [makeDshClientMessage(output)] : [] };
      },
      delete: async () => ({}),
      abort: async () => ({}),
    },
    abortFor(parentSessionId: string): void {
      for (const [childId, active] of activeBySession) {
        if (parentByChild.get(childId) === parentSessionId) {
          active.external = true;
          active.controller.abort();
        }
      }
    },
  };
}

/* ─────────────────────────────── seams ────────────────────────────────────── */

/** Deps for {@link createRecompSeams}. */
export interface RecompSeamDeps {
  /** Cordis context (the LLM service + optional agentDefaultModel route). */
  ctx: Context;
  /** The host service surface: `ready` gates runs on a successful storage
   *  bootstrap; `canonicalKey` is part of the service contract (the command
   *  layer resolves session ids before calling the seams). */
  host: {
    ready: Promise<DshStorageBootstrap>;
    canonicalKey(dshSessionId: string): string;
  };
  /** Project working directory — last-resort fallback for session-dir
   *  resolution (the per-call cwd wins). */
  directory?: string;
  /** Shared Magic SQLite (the seams' authoritative handle; the per-call db in
   *  the CtxCommandSeams deps is resolved by the command layer from the same
   *  source and ignored here). */
  db: Database;
  /** Logger sink. */
  log?: (message: string) => void;
  /** Injectable LLM runtime (tests; production falls back to `ctx.get("llm")`). */
  llm?: LlmRuntime;
  /** Chunk token budget for historian passes (default 16_000). */
  historianChunkTokens?: number;
  /** Per-attempt historian timeout (ms, default 120_000). */
  historianTimeoutMs?: number;
  /** Cross-session memory feature gate (default true). */
  memoryEnabled?: boolean;
  /** Automatic-promotion gate (default true). */
  autoPromote?: boolean;
  /** Historian fallback chain ("provider/modelID"); DSH has no config file —
   *  empty by default (the session's live model remains the last resort). */
  fallbackModels?: readonly string[];
  /** Language directive for historian/migration prompts. */
  language?: string;
  /** Gate the upgrade's once-per-project memory migration (default:
   *  `memoryEnabled` — DSH runs migration with the session's live model as
   *  the primary, see module doc). */
  runMigration?: boolean;
  /** User-memory collection gate for the migration (default false). */
  userMemoriesEnabled?: boolean;
  /** Two-pass historian (editor cleanup) (default false). */
  historianTwoPass?: boolean;
  /** Main-model context window for wrapup boundary planning (default 128_000). */
  contextLimit?: number;
  /** Execute-threshold percentage for wrapup boundary planning (default 65). */
  executeThresholdPercentage?: number;
  /** Test seam: replace the shared core entry points (assert arg shape
   *  without running the LLM-dependent runner). */
  runners?: {
    recomp?: typeof runManagedRecomp;
    wrapup?: typeof runManagedWrapup;
    upgrade?: typeof runManagedUpgrade;
  };
  /** Test seam: replace the compartment-agent runner used by wrapup
   *  iterations (the shared core's own test seam; production falls back to
   *  the real runCompartmentAgent). */
  runCompartmentAgentForWrapup?: ManagedWrapupContext["runCompartmentAgentForWrapup"];
}

/** `provider/model` key of the agent's live model (last-resort fallback + the
 *  memory-migration primary). */
function modelKeyOf(agent: Agent): string | undefined {
  const { provider, model } = agent.options;
  return provider && model ? `${provider}/${model}` : undefined;
}

/** Notification params pinned to the invoking agent (keeps status lines on
 *  the session's model/agent). */
function notificationParamsOf(agent: Agent): {
  agent: string;
  providerId?: string;
  modelId?: string;
} {
  return {
    agent: String(agent.id),
    providerId: agent.options.provider,
    modelId: agent.options.model,
  };
}

/**
 * Build the recomp / wrapup / upgrade seams for the /ctx-* commands
 * (`CtxCommandSeams.runRecomp|runWrapup|runUpgrade`).
 *
 * Each run:
 *   1. fails fast on an already-aborted invocation signal (skip text);
 *   2. gates on the host bootstrap (`host.ready` must be `kind: "ok"`);
 *   3. builds the managed context (per-run client bound to the resolved
 *      directory, fresh `LiveSessionState` shared across the instance, the
 *      agent's live model as `fallbackModelId`, configurable defaults);
 *   4. registers the transcript-backed raw-message provider for the WHOLE
 *      run and delegates to the shared core orchestrator;
 *   5. never throws: every failure becomes an error-status text (the command
 *      layer renders it directly and infers success/error from the wording).
 *
 * `runRecomp` supports partial ranges: `rawInput` "start-end" parses through
 * the shared `parseRecompArgs` and is forwarded as `options.range` (the core
 * runner snaps to enclosing compartment boundaries); anything else (including
 * the unreachable `--upgrade` form, which the command handler intercepts)
 * runs a full recomp.
 */
export function createRecompSeams(
  deps: RecompSeamDeps,
): Pick<CtxCommandSeams, "runRecomp" | "runWrapup" | "runUpgrade"> {
  const log = deps.log ?? (() => {});
  const liveSessionState = createLiveSessionState();
  const memoryEnabled = deps.memoryEnabled ?? true;
  const autoPromote = deps.autoPromote ?? true;

  /** Bootstrap gate — returns an error TEXT when the host storage bootstrap
   *  did not settle ok, else null (fail-closed, never throws). */
  async function bootstrapGate(): Promise<string | null> {
    try {
      const boot = await deps.host.ready;
      if (boot.kind !== "ok") {
        return `magic-context host bootstrap ${boot.kind} (${boot.reason}) — recomp unavailable.`;
      }
      return null;
    } catch (error) {
      return `magic-context host bootstrap failed: ${describeError(error).brief}`;
    }
  }

  function baseRecompContext(
    client: DshSessionClient,
    agent: Agent,
    sessionId: string,
    directory: string,
  ): ManagedRecompContext {
    return {
      client: client as unknown as ManagedRecompContext["client"],
      db: deps.db,
      liveSessionState,
      directory,
      historianChunkTokens: deps.historianChunkTokens ?? DEFAULT_RECOMP_CHUNK_TOKENS,
      historianTimeoutMs: deps.historianTimeoutMs ?? DEFAULT_RECOMP_TIMEOUT_MS,
      memoryEnabled,
      autoPromote,
      fallbackModels: deps.fallbackModels ?? [],
      language: deps.language,
      fallbackModelId: modelKeyOf(agent),
      runMigration: deps.runMigration ?? memoryEnabled,
      userMemoriesEnabled: deps.userMemoriesEnabled ?? false,
      historianTwoPass: deps.historianTwoPass,
      getNotificationParams: () => notificationParamsOf(agent),
    };
  }

  /** Build the per-run client (fresh child-session namespace per run) and
   *  link the invocation signal to its in-flight prompt. Returns the client
   *  plus a `dispose()` that unlinks the signal listener (call in finally). */
  function buildClient(
    directory: string,
    sessionId: string,
    signal: AbortSignal,
  ): { client: DshSessionClient; dispose: () => void } {
    const client = createDshSessionClient({
      ctx: deps.ctx,
      db: deps.db,
      log,
      directory,
      ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
    });
    const onAbort = (): void => client.abortFor(sessionId);
    signal.addEventListener("abort", onAbort);
    return {
      client,
      dispose: () => signal.removeEventListener("abort", onAbort),
    };
  }

  return {
    async runRecomp(args) {
      try {
        if (args.signal.aborted) {
          return "## Magic Recomp — Skipped\n\nCommand was cancelled before it started.";
        }
        const gate = await bootstrapGate();
        if (gate !== null) return `## Magic Recomp — Failed\n\n${gate}`;

        const parsed = parseRecompArgs(args.rawInput);
        if (parsed.kind === "error") return `## Magic Recomp — Failed\n\n${parsed.message}`;
        if (parsed.kind === "upgrade") {
          // The /ctx-recomp command handler intercepts --upgrade before this
          // seam; kept for defense-in-depth.
          return "## Magic Recomp — Skipped\n\n`--upgrade` is deprecated — run `/ctx-session-upgrade` instead.";
        }

        const directory = args.cwd ?? deps.directory ?? process.cwd();
        const { client, dispose } = buildClient(directory, args.sessionId, args.signal);
        try {
          const ctx = baseRecompContext(client, args.agent, args.sessionId, directory);
          const run = deps.runners?.recomp ?? runManagedRecomp;
          const options = parsed.kind === "partial" ? { range: parsed.range } : undefined;
          const provider = transcriptRawMessageProvider(args.agent, args.sessionId);
          return await withRawMessageProvider(args.sessionId, provider, () =>
            run(ctx, args.sessionId, options),
          );
        } finally {
          dispose();
        }
      } catch (error) {
        log(`[magic-context] recomp seam failed: ${describeError(error).brief}`);
        return `## Magic Recomp — Failed\n\nRecomp crashed: ${describeError(error).brief}`;
      }
    },

    async runWrapup(args) {
      try {
        if (args.signal.aborted) {
          return "## Magic Wrapup — Skipped\n\nCommand was cancelled before it started.";
        }
        const gate = await bootstrapGate();
        if (gate !== null) return `## Magic Wrapup — Failed\n\n${gate}`;

        const directory = args.cwd ?? deps.directory ?? process.cwd();
        const { client, dispose } = buildClient(directory, args.sessionId, args.signal);
        try {
          const ctx: ManagedWrapupContext = {
            ...baseRecompContext(client, args.agent, args.sessionId, directory),
            contextLimit: deps.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
            executeThresholdPercentage:
              deps.executeThresholdPercentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            ...(deps.runCompartmentAgentForWrapup !== undefined
              ? { runCompartmentAgentForWrapup: deps.runCompartmentAgentForWrapup }
              : {}),
          };
          const run = deps.runners?.wrapup ?? runManagedWrapup;
          const provider = transcriptRawMessageProvider(args.agent, args.sessionId);
          return await withRawMessageProvider(args.sessionId, provider, () =>
            run(ctx, args.sessionId, { messagesToKeep: args.messagesToKeep }),
          );
        } finally {
          dispose();
        }
      } catch (error) {
        log(`[magic-context] wrapup seam failed: ${describeError(error).brief}`);
        return `## Magic Wrapup — Failed\n\nWrapup crashed: ${describeError(error).brief}`;
      }
    },

    async runUpgrade(args) {
      try {
        if (args.signal.aborted) {
          return "## Session Upgrade — Skipped\n\nCommand was cancelled before it started.";
        }
        const gate = await bootstrapGate();
        if (gate !== null) return `## Session Upgrade — Failed\n\n${gate}`;

        const directory = args.cwd ?? deps.directory ?? process.cwd();
        const { client, dispose } = buildClient(directory, args.sessionId, args.signal);
        try {
          const ctx = baseRecompContext(client, args.agent, args.sessionId, directory);
          const run = deps.runners?.upgrade ?? runManagedUpgrade;
          const provider = transcriptRawMessageProvider(args.agent, args.sessionId);
          return await withRawMessageProvider(args.sessionId, provider, () => run(ctx, args.sessionId));
        } finally {
          dispose();
        }
      } catch (error) {
        log(`[magic-context] upgrade seam failed: ${describeError(error).brief}`);
        return `## Session Upgrade — Failed\n\nUpgrade crashed: ${describeError(error).brief}`;
      }
    },
  };
}

// Re-export the managed context types for wiring consumers.
export type { ManagedRecompContext, ManagedWrapupContext };
