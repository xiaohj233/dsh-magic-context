import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getAutoSearchHintDecisions } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
  collectUserText,
  DEFAULT_MIN_PROMPT_CHARS,
  DEFAULT_SCORE_THRESHOLD,
  extractLatestUserPrompt,
  maybeRunAutoSearchHint,
  type AutoSearchConfig,
} from "./auto-search";
import type { Agent } from "@deepseek-ai/dsh-agent";

const SESSION_ID = "dsh:a1b2c3d4:auto-search-session";

/** Close the test DB, then remove the temp dir (Windows may hold WAL handles). */
async function cleanupDir(dir: string, db?: Database): Promise<void> {
  try {
    db?.close();
  } catch {
    // already closed
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function userMessage(text: string, id = `user-${Math.random().toString(36).slice(2)}`): UserMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  } as unknown as UserMessage;
}

function memoryHit(score: number, content = "config cache primers live under src/config"): UnifiedSearchResult {
  return {
    source: "memory",
    content,
    score,
    memoryId: 1,
    category: "PROJECT_RULES",
    matchType: "fts",
  };
}

function fakeAgent(): { agent: Pick<Agent, "inject">; injected: UserMessage[] } {
  const injected: UserMessage[] = [];
  return {
    injected,
    agent: {
      inject: (message: UserMessage) => injected.push(message),
    },
  };
}

function makeConfig(overrides: Partial<AutoSearchConfig> = {}): AutoSearchConfig {
  return {
    enabled: true,
    scoreThreshold: DEFAULT_SCORE_THRESHOLD,
    minPromptChars: DEFAULT_MIN_PROMPT_CHARS,
    ...overrides,
  };
}

// The unifiedSearch spy must be restored after every test: bun may share the
// module registry across test files, so a leaked mock would intercept the REAL
// ctx_search tool path in sibling test files (observed: tools.test's ctx_search
// returned the auto-search fixture as a "real" memory hit).
let activeSearchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  activeSearchSpy?.mockRestore();
  activeSearchSpy = undefined;
});

/** Create (or re-enter) the unifiedSearch mock and reset its call history. */
function mockUnifiedSearch(results: UnifiedSearchResult[] | (() => UnifiedSearchResult[])): ReturnType<typeof spyOn> {
  const implementation =
    typeof results === "function" ? results : () => results;
  activeSearchSpy = spyOn(searchModule, "unifiedSearch").mockImplementation(implementation);
  activeSearchSpy.mockClear();
  return activeSearchSpy;
}

describe("agent auto-search (<ctx-search-hint> via agent.inject)", () => {
  it("queues a hint when the top hit clears the threshold and persists the decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-as-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const searchSpy = mockUnifiedSearch([memoryHit(0.9)]);
      const { agent, injected } = fakeAgent();
      const message = userMessage(
        "I need to remember how the embedding cache configuration is structured in this project",
      );

      const outcome = await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig(),
        log: () => {},
      });

      expect(outcome.ok).toBe(true);
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(injected.length).toBe(1);
      const hint = injected[0];
      expect(hint.content[0].type).toBe("text");
      const text = hint.content[0].type === "text" ? hint.content[0].text : "";
      expect(text).toContain("<ctx-search-hint>");
      expect(text).toContain("config cache primers");
      const source = hint.source as { kind: string; plugin: string; messageId: string };
      expect(source.kind).toBe("plugin");
      expect(source.plugin).toBe("magic-context");
      expect(source.messageId).toBe(`mc-auto-search:${message.id}`);

      // Decision persisted for replay/resume.
      const decisions = getAutoSearchHintDecisions(db, SESSION_ID);
      expect(decisions).toEqual([
        expect.objectContaining({ messageId: message.id, decision: "hint" }),
      ]);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("skips (too-short) without searching and records a no-hint decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-as-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const searchSpy = mockUnifiedSearch([]);
      const { agent, injected } = fakeAgent();
      const message = userMessage("hi");

      await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig(),
        log: () => {},
      });

      expect(searchSpy).not.toHaveBeenCalled();
      expect(injected.length).toBe(0);
      expect(getAutoSearchHintDecisions(db, SESSION_ID)).toEqual([
        expect.objectContaining({ messageId: message.id, decision: "no-hint", reason: "too-short" }),
      ]);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("skips stacked augmentations without searching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-as-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const searchSpy = mockUnifiedSearch([]);
      const { agent, injected } = fakeAgent();
      const message = userMessage(
        "some user text <ctx-search-hint>already augmented</ctx-search-hint> trailing",
      );

      await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig(),
        log: () => {},
      });

      expect(searchSpy).not.toHaveBeenCalled();
      expect(injected.length).toBe(0);
      expect(getAutoSearchHintDecisions(db, SESSION_ID)).toEqual([
        expect.objectContaining({ messageId: message.id, decision: "no-hint", reason: "stacked" }),
      ]);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("does not inject below the score threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-as-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      mockUnifiedSearch([memoryHit(0.3)]);
      const { agent, injected } = fakeAgent();
      const message = userMessage(
        "a long user prompt that exceeds the minimum character threshold comfortably",
      );

      await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig({ scoreThreshold: 0.5 }),
        log: () => {},
      });

      expect(injected.length).toBe(0);
      expect(getAutoSearchHintDecisions(db, SESSION_ID)).toEqual([
        expect.objectContaining({ messageId: message.id, decision: "no-hint", reason: "below-threshold" }),
      ]);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("does not double-inject when a decision for the message already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-as-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      mockUnifiedSearch([memoryHit(0.9)]);
      const { agent, injected } = fakeAgent();
      const message = userMessage(
        "a long user prompt about the configuration layout in this repository",
        "fixed-user-msg-1",
      );

      await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig(),
        log: () => {},
      });
      expect(injected.length).toBe(1);

      // Same message id re-evaluated (e.g. duplicate delivery): replay guard.
      await maybeRunAutoSearchHint({
        db,
        sessionId: SESSION_ID,
        projectPath: "",
        messages: [message],
        agent,
        config: makeConfig(),
        log: () => {},
      });
      expect(injected.length).toBe(1);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("extractLatestUserPrompt picks the latest genuine user-sourced message", () => {
    const injected = {
      id: "injected-1",
      role: "user" as const,
      content: [{ type: "text" as const, text: "magic context knowledge baseline" }],
      source: { kind: "plugin" as const, plugin: "magic-context" },
    } as unknown as UserMessage;
    const prompt = userMessage("the real user question", "real-1");
    const found = extractLatestUserPrompt([injected, prompt]);
    expect(found?.message.id).toBe("real-1");
    expect(found?.text).toBe("the real user question");
    expect(collectUserText(prompt)).toBe("the real user question");
  });
});
