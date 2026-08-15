/**
 * agent/historian-wiring — production wiring of the historian plane (Phase 3):
 *
 *   1. the Magic compaction summarize hook, registered ON the host service
 *      (cross-bundle singleton — the compaction entry bundle reads it there).
 *      The wrapper resolves the canonical session from the compacting agent at
 *      call time and lazily builds one per-session hook (transcript-backed
 *      raw-message provider + the production LLM SummarizeCall).
 *   2. the production `DshSummarizeCall` over `ctx.llm.stream()` with the
 *      shared compartment-agent system prompt (PLAN §5.13/D7: historian calls
 *      the LLM directly — no subagent, no tools).
 *
 * The background historian pass itself is triggered from the context plane /
 * pre-step by the integrator via `runDshHistorian`; this module owns only the
 * hook + LLM call production paths.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "../compat/dsh-0.1/session";
import type { SummarizeHook } from "../compat/dsh-0.1/compaction";
import type { MagicContextHostService, MagicSummarizeHook } from "../index";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
  COMPARTMENT_AGENT_SYSTEM_PROMPT,
  buildCompartmentAgentPrompt,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { readDshTranscript } from "./transcript";
import {
  createMagicSummarizeHook,
  type DshSummarizeCall,
  type MagicSummarizeDeps,
} from "./historian";

export interface MagicHistorianWiringDeps {
  /** The host service (ready + canonicalKey + registerSummarizeHook). */
  readonly host: MagicContextHostService;
  /** Project working directory (memory promotion scope). */
  readonly directory?: string;
  readonly log?: (message: string) => void;
}

/** Read the LLM runtime without declaring a hard inject (optional service). */
function readLlm(ctx: Context): LlmRuntime | undefined {
  return ctx.get("llm") as LlmRuntime | undefined;
}

/** Current provider/model route (fresh per call). */
export function currentModel(ctx: Context): string {
  const route = currentRoute(ctx);
  return `${route.provider}/${route.model}`;
}

/**
 * Read the current context pressure for the historian trigger (Phase 4):
 * `ctx.sessionProjections.snapshot(session).values.contextPressure` — the
 * tokenMeter fold units the host composes (last-wins per commit).
 */
export function readContextPressure(ctx: Context): (agent: Agent) => { projectedTokens?: number; contextWindow?: number } | undefined {
  return (agent: Agent) => {
    const projections = ctx.get("sessionProjections") as
      | { snapshot?: (session: unknown) => { values?: Record<string, unknown> } }
      | undefined;
    const pressure = projections?.snapshot?.(agent.session)?.values?.contextPressure as
      | { projectedTokens?: number; contextWindow?: number }
      | undefined;
    return pressure;
  };
}

/** Resolve the current provider/model route (fresh per call). */
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

/**
 * The production historian LLM call: one `ctx.llm.stream()` request with the
 * shared compartment-agent system prompt and the chunk text as the user turn.
 * Returns the raw historian XML the runner validates and publishes.
 */
export function createLlmSummarizeCall(ctx: Context): DshSummarizeCall {
  const llm = readLlm(ctx);
  if (llm === undefined) {
    throw new Error("magic-context: llm service unavailable (historian wiring)");
  }
  return async (chunk, _priorCompartments, signal) => {
    const { provider, model } = currentRoute(ctx);
    const prompt = buildCompartmentAgentPrompt({
      seedExamples: "",
      sessionReferences: "",
      projectMemory: "",
      inputSource: chunk.text,
      memoryEnabled: true,
    });
    const user = createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "plugin", plugin: "magic-context" },
    });
    let text = "";
    let failed: string | undefined;
    for await (const streamChunk of llm.stream({
      provider,
      model,
      system: COMPARTMENT_AGENT_SYSTEM_PROMPT,
      messages: [user],
      purpose: "compaction",
      signal,
    })) {
      if (streamChunk.type === "text-delta") text += streamChunk.text;
      if (streamChunk.type === "finish") {
        if (streamChunk.reason.kind === "error") {
          const failure = (streamChunk.reason as { failure?: { message?: string } }).failure;
          failed = failure?.message ?? "error finish";
        } else if (streamChunk.reason.kind === "aborted") {
          failed = "aborted";
        }
      }
    }
    if (failed !== undefined) {
      throw new Error(`magic-context: historian LLM stream failed (${failed})`);
    }
    if (text.trim().length === 0) {
      throw new Error("magic-context: historian LLM stream returned no text");
    }
    return text;
  };
}

/** Transcript-backed RawMessageProvider for one live session (read-only). */
export function transcriptRawMessageProvider(
  agent: Agent,
  canonicalSessionId: string,
): RawMessageProvider {
  const view = readDshTranscript({
    session: {
      events: agent.session.events,
      surface: agent.session.surface,
      header: { cwd: agent.session.header.cwd },
    },
    canonicalSessionId,
  });
  const byId = new Map(view.messages.map((message) => [message.id, message]));
  const ordinalById = new Map(view.messages.map((message, index) => [message.id, index + 1]));
  return {
    readMessages: () => [...view.messages],
    readMessageById: (messageId: string) => byId.get(messageId) ?? null,
    readMessageOrdinalById: (messageId: string) => ordinalById.get(messageId) ?? null,
    getMessageCount: () => view.messages.length,
  };
}

/**
 * Register the summarize hook on the host service. Per-session hooks are
 * created lazily (the compacting agent carries the session identity) and
 * cached for the process lifetime.
 */
export function registerMagicHistorianPlane(
  ctx: Context,
  deps: MagicHistorianWiringDeps,
): void {
  const hooksBySession = new Map<string, SummarizeHook>();
  const summarize = createLlmSummarizeCall(ctx);
  const log = deps.log ?? (() => {});

  const wrapper: MagicSummarizeHook = async (input, agent, signal) => {
    const a = agent as Agent;
    const sessionId = deps.host.canonicalKey(a.id);
    let hook = hooksBySession.get(sessionId);
    if (hook === undefined) {
      const bootstrap = await deps.host.ready;
      if (bootstrap.kind !== "ok") {
        throw new Error(
          `magic-context: compaction summarize unavailable — host bootstrap ${bootstrap.kind}`,
        );
      }
      hook = createMagicSummarizeHook({
        db: bootstrap.db,
        sessionId,
        ctx,
        provider: transcriptRawMessageProvider(a, sessionId),
        summarize,
        directory: deps.directory,
        log,
      } satisfies MagicSummarizeDeps);
      hooksBySession.set(sessionId, hook);
    }
    return hook(input as Parameters<SummarizeHook>[0], a, signal);
  };
  deps.host.registerSummarizeHook(wrapper);
  log("[magic-context] historian plane wired: summarize hook registered on the host service");
}
