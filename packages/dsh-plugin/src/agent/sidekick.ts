/**
 * agent/sidekick — the Sidekick /ctx-aug runner (Phase 4, PLAN §6/§5.13).
 *
 * The shared core (`features/magic-context/sidekick/core.ts`) defines the
 * system prompt and result helpers; the Pi adapter executes Sidekick through a
 * subagent runner, OpenCode through a child session. The DSH adaptation runs
 * ONE direct `ctx.llm.stream()` call (PLAN §5.13/D7: tool-less LLM work goes
 * straight to the model — no subagent, no spawn) with the project-memory
 * search results injected into the prompt (the shared prompt instructs the
 * model to search `ctx_search`; the DSH runner performs that search itself and
 * hands the model the results, keeping the single-round call tool-free).
 *
 * Failure semantics mirror the Pi adapter: any failure or empty result returns
 * null — the caller falls back to the raw prompt (never throws).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Database } from "@magic-context/core/shared/sqlite";
import { unifiedSearch } from "@magic-context/core/features/magic-context/search";
import {
  SIDEKICK_SYSTEM_PROMPT,
  stripThinkingBlocks,
  isEmptySidekickResult,
} from "@magic-context/core/features/magic-context/sidekick/core";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { createUserMessage } from "../compat/dsh-0.1/session";
import type { CtxCommandSeams } from "./commands";
import { resolveDb } from "./tools";

export interface SidekickWiringDeps {
  /** Resolve the shared DB (defaults to the host bootstrap). */
  readonly db?: Database | (() => Database | Promise<Database>);
  /** Resolve the canonical session key for an agent. */
  readonly canonicalKey?: (dshSessionId: string) => string;
  /** Optional search overrides (timeout ms, result caps). */
  readonly searchOptions?: { readonly timeoutMs?: number; readonly limit?: number };
  readonly log?: (message: string) => void;
}

/** Render the top unified-search results into a compact prompt block. */
export function renderSearchResults(results: readonly { readonly snippet?: string; readonly score?: number }[] | null): string {
  if (results === null || results.length === 0) return "";
  const lines = results
    .slice(0, 8)
    .map((result, index) => `[${index + 1}] ${result.snippet ?? ""}`.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? "" : lines.join("\n");
}

/** Run one sidekick augmentation turn; null on failure/empty (never throws). */
export async function runDshSidekick(
  ctx: Context,
  deps: SidekickWiringDeps,
  args: {
    readonly agent: Agent;
    readonly prompt: string;
    readonly cwd?: string;
    readonly projectIdentity?: string;
    readonly signal: AbortSignal;
  },
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  try {
    const db = await resolveDb(ctx, deps);
    const sessionId = deps.canonicalKey !== undefined
      ? deps.canonicalKey(String(args.agent.id))
      : undefined;
    const projectIdentity = args.projectIdentity ??
      (args.cwd !== undefined && args.cwd.length > 0
        ? resolveProjectIdentityForSession(args.cwd) || undefined
        : undefined);

    // The shared prompt tells the model to search ctx_search; the DSH runner
    // performs the search itself and injects the results (single-round call).
    let memoryBlock = "";
    if (sessionId !== undefined && projectIdentity !== undefined && args.cwd !== undefined) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.searchOptions?.timeoutMs ?? 3000);
      try {
        const results = await unifiedSearch(db, sessionId, projectIdentity, args.prompt, {
          limit: deps.searchOptions?.limit ?? 8,
          signal: controller.signal,
          countRetrievals: false,
        });
        const rendered = renderSearchResults(results as { snippet?: string; score?: number }[]);
        if (rendered.length > 0) {
          memoryBlock = `\n\n<memories>\n${rendered}\n</memories>`;
        }
      } catch {
        // Search is best-effort — the model can still answer from the prompt.
      } finally {
        clearTimeout(timer);
      }
    }

    const llm = ctx.get("llm") as { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined;
    if (llm?.stream === undefined) {
      log("[magic-context] sidekick skipped: llm service unavailable");
      return null;
    }
    const route = (() => {
      const defaultModel = ctx.get("agentDefaultModel") as
        | { currentSelection?: () => { provider?: string; model?: string } }
        | undefined;
      const selection = defaultModel?.currentSelection?.();
      return {
        provider: selection?.provider ?? "deepseek",
        model: selection?.model ?? "deepseek-chat",
      };
    })();
    const user = createUserMessage({
      content: [{ type: "text", text: `${args.prompt}${memoryBlock}` }],
      source: { kind: "plugin", plugin: "magic-context" },
    });

    let text = "";
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: SIDEKICK_SYSTEM_PROMPT,
      messages: [user],
      signal: args.signal,
    }) as AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { message?: string } } }>) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
        log(`[magic-context] sidekick LLM finished ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? ""}`);
        return null;
      }
    }

    const stripped = stripThinkingBlocks(text).trim();
    if (isEmptySidekickResult(stripped)) return null;
    return stripped;
  } catch (error) {
    log(`[magic-context] sidekick failed (returns null): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Wire the /ctx-aug seam (commands.ts expects `runSidekick`). */
export function createSidekickSeam(
  ctx: Context,
  deps: SidekickWiringDeps,
): CtxCommandSeams["runSidekick"] {
  return (call) => runDshSidekick(ctx, deps, {
    agent: call.agent,
    prompt: call.prompt,
    cwd: call.cwd,
    projectIdentity: call.projectIdentity,
    signal: call.signal,
  });
}
