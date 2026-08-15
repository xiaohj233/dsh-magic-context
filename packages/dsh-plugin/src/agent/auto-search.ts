/**
 * agent/auto-search — transform-time auto-search hinting for DSH (Phase 2
 * slice A).
 *
 * Runs the shared core `unifiedSearch()` over the latest genuine user prompt
 * claimed by a pre-step and, on a strong-enough hit, builds the shared vague
 * recall hint (`buildAutoSearchHint`, core hooks/magic-context/auto-search-hint)
 * and queues it as a Magic-owned injected user message.
 *
 * DSH difference vs Pi/OpenCode: the hint is delivered through `agent.inject()`
 * (a new UserMessage with a `magic-context` plugin source) instead of being
 * appended into the existing user message array — DSH surfaces are append-only
 * for this adapter. Because `agent.inject()` feeds the NEXT pre-step batch, the
 * hint becomes model-visible on the following request of the session (next step
 * of the same turn, or the next turn). The 3s timeout matches OpenCode's
 * auto-search runner so the pre-step path never hangs on embedding providers.
 *
 * Per-turn decisions are persisted through the core `auto_search_hint_decisions`
 * session-meta column (appendAutoSearchHintDecision) so a resumed process does
 * not re-evaluate a message that was already decided.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import {
  getVisibleMemoryIds,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { buildAutoSearchHint } from "@magic-context/core/hooks/magic-context/auto-search-hint";
import {
  embedTextForProject,
  getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import {
  unifiedSearch,
  type UnifiedSearchOptions,
  type UnifiedSearchResult,
} from "@magic-context/core/features/magic-context/search";
import {
  appendAutoSearchHintDecision,
  getAutoSearchHintDecisions,
  type AutoSearchHintNoHintReason,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { Database } from "@magic-context/core/shared/sqlite";
import { magicUserMessage } from "../compat/dsh-0.1/session";

/** Auto-search tuning surfaced in the agent plugin config. */
export interface AutoSearchConfig {
  enabled?: boolean;
  scoreThreshold?: number;
  minPromptChars?: number;
}

export const AUTO_SEARCH_TIMEOUT_MS = 3_000;
export const DEFAULT_SCORE_THRESHOLD = 0.55;
export const DEFAULT_MIN_PROMPT_CHARS = 20;

export type AutoSearchOutcome =
  | { ok: true }
  | { ok: false; kind: "disabled" | "no-user-message" | "timeout" | "search-failure" };

/** Source marker for the injected hint (messageId = per-user-message id). */
export function autoSearchHintSource(userMessageId: string): {
  kind: "plugin";
  plugin: "magic-context";
  messageId: string;
} {
  return { kind: "plugin", plugin: "magic-context", messageId: `mc-auto-search:${userMessageId}` };
}

/** Concatenate the text blocks of a DSH user message. */
export function collectUserText(message: UserMessage): string {
  let collected = "";
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      collected += (collected.length > 0 ? "\n" : "") + part.text;
    }
  }
  return collected;
}

/**
 * Find the latest genuine human prompt in a pre-step message batch. Skips
 * plugin/model/tool-sourced user-role messages and empty text.
 */
export function extractLatestUserPrompt(
  messages: readonly UserMessage[],
): { message: UserMessage; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.source?.kind !== "user") continue;
    const text = collectUserText(message).trim();
    if (text.length === 0) continue;
    return { message, text };
  }
  return null;
}

function hasStackedAugmentation(rawText: string): boolean {
  return (
    rawText.includes("<sidekick-augmentation>") ||
    rawText.includes("<ctx-search-hint>") ||
    rawText.includes("<ctx-search-auto>")
  );
}

function extractUserPromptText(text: string): string {
  return (
    text
      // HTML comments (temporal markers, internal initiators).
      .replace(/<!--[\s\S]*?-->/g, "")
      // Plugin-owned injected blocks.
      .replace(/<ctx-search-hint>[\s\S]*?<\/ctx-search-hint>/g, "")
      .replace(/<ctx-search-auto>[\s\S]*?<\/ctx-search-auto>/g, "")
      .replace(/<instruction[^>]*>[\s\S]*?<\/instruction>/g, "")
      .replace(/<sidekick-augmentation>[\s\S]*?<\/sidekick-augmentation>/g, "")
      // Generic XML/HTML tags (keep text between paired tags).
      .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
      // Magic tag prefix: "§123§ ".
      .replace(/§\d+§\s*/g, "")
      // Collapse whitespace runs left by the strippings.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function unifiedSearchWithTimeout(
  db: Database,
  sessionId: string,
  projectPath: string,
  prompt: string,
  options: UnifiedSearchOptions,
  timeoutMs: number,
): Promise<UnifiedSearchResult[] | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      unifiedSearch(db, sessionId, projectPath, prompt, {
        ...options,
        signal: controller.signal,
        // Plugin-internal surfacing must not inflate retrieval-count promotions.
        countRetrievals: false,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RunAutoSearchHintArgs {
  db: Database;
  /** Canonical Magic session key (the session_meta key). */
  sessionId: string;
  /** Resolved project identity (`git:`/`dir:`), or "" for no project. */
  projectPath: string;
  /** The pre-step message batch (claimed inbox messages). */
  messages: readonly UserMessage[];
  agent: Pick<Agent, "inject">;
  config: AutoSearchConfig;
  log?: (message: string) => void;
}

/**
 * Evaluate the latest user prompt in the batch and, when the top unified-search
 * hit clears the threshold, queue the `<ctx-search-hint>` block through
 * `agent.inject()`. Failures are retryable (nothing persisted) except the
 * explicit no-hint decisions, matching OpenCode's runner.
 */
export async function maybeRunAutoSearchHint(
  args: RunAutoSearchHintArgs,
): Promise<AutoSearchOutcome> {
  const { db, sessionId, projectPath, messages, agent, config, log } = args;
  if (config.enabled === false) return { ok: false, kind: "disabled" };

  const found = extractLatestUserPrompt(messages);
  if (found === null) return { ok: false, kind: "no-user-message" };
  const { message: userMessage, text: rawText } = found;
  const userMessageId = userMessage.id;

  // Persisted decision for this exact message id (resume replay / re-fire).
  const existing = getAutoSearchHintDecisions(db, sessionId).find(
    (decision) => decision.messageId === userMessageId,
  );
  if (existing) {
    // The hint (or the no-hint decision) was already delivered for this message;
    // the injected message is part of the durable log, so nothing to redo.
    return { ok: true };
  }

  const writeNoHint = (reason: AutoSearchHintNoHintReason): void => {
    appendAutoSearchHintDecision(db, sessionId, {
      messageId: userMessageId,
      decision: "no-hint",
      reason,
    });
  };

  // Suppression check runs on RAW text before stripping (stripping removes the
  // very tags we look for).
  if (hasStackedAugmentation(rawText)) {
    writeNoHint("stacked");
    return { ok: true };
  }

  const prompt = extractUserPromptText(rawText);
  const minPromptChars = config.minPromptChars ?? DEFAULT_MIN_PROMPT_CHARS;
  if (prompt.length < minPromptChars) {
    writeNoHint("too-short");
    return { ok: true };
  }

  let results: UnifiedSearchResult[] | null;
  try {
    const snapshot = getProjectEmbeddingSnapshot(projectPath);
    const memoryEnabled = snapshot?.features.memoryEnabled ?? true;
    const embeddingEnabled = snapshot ? snapshot.enabled || snapshot.gitCommitEnabled : true;
    const gitCommitsEnabled = snapshot?.gitCommitEnabled ?? false;
    results = await unifiedSearchWithTimeout(
      db,
      sessionId,
      projectPath,
      prompt,
      {
        limit: 10,
        memoryEnabled,
        embeddingEnabled,
        gitCommitsEnabled,
        embedQuery: async (text, signal) => {
          const result = await embedTextForProject(projectPath, text, signal, "query");
          return result?.vector ?? null;
        },
        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
        visibleMemoryIds: getVisibleMemoryIds(db, sessionId),
        sources: ["memory", "message", "git_commit"],
      },
      AUTO_SEARCH_TIMEOUT_MS,
    );
  } catch (error) {
    // Retryable failure — do NOT persist a permanent no-hint decision.
    log?.(
      `[magic-context] auto-search failed for session ${sessionId} (retry next pass): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, kind: "search-failure" };
  }

  if (results === null) {
    log?.(`[magic-context] auto-search timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms (retry next pass)`);
    return { ok: false, kind: "timeout" };
  }

  if (results.length === 0) {
    writeNoHint("empty");
    return { ok: true };
  }

  const scoreThreshold = config.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  if (results[0].score < scoreThreshold) {
    writeNoHint("below-threshold");
    return { ok: true };
  }

  const hintText = buildAutoSearchHint(results);
  if (!hintText) {
    writeNoHint("empty");
    return { ok: true };
  }

  // Separate block, matching OpenCode's runner (double newline prefix).
  const payload = `\n\n${hintText}`;
  const outcome = appendAutoSearchHintDecision(db, sessionId, {
    messageId: userMessageId,
    decision: "hint",
    text: payload,
  });
  if (!outcome.ok) return { ok: true }; // CAS exhausted — do not double-inject
  agent.inject(magicUserMessage(payload, autoSearchHintSource(userMessageId)));
  log?.(
    `[magic-context] auto-search: queued hint for ${userMessageId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
  );
  return { ok: true };
}
