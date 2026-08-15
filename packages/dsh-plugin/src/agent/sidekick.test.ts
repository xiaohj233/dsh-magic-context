import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { renderSearchResults, runDshSidekick, createSidekickSeam } from "./sidekick";

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

/** Fake ctx: llm stream + agentDefaultModel + no messageFeedback. */
function fakeCtx(stream: AsyncIterable<unknown> | (() => AsyncIterable<unknown>)) {
  const llmStream = typeof stream === "function" ? stream : () => stream;
  return {
    get: (name: string) => {
      if (name === "llm") {
        return { stream: (options: unknown) => llmStream(options) };
      }
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) };
      }
      return undefined;
    },
  };
}

function textDelta(text: string): { type: "text-delta"; text: string } {
  return { type: "text-delta", text };
}

function finishStop(): { type: "finish"; reason: { kind: "stop" } } {
  return { type: "finish", reason: { kind: "stop" } };
}

describe("sidekick runner (DSH direct-LLM adaptation)", () => {
  it("runs one LLM turn and strips thinking blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-sidekick-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const seen: { system?: string; messages?: unknown[] }[] = [];
      const ctx = fakeCtx(async function* () {
        // capture options via the returned generator's closure
        yield textDelta("part1 ");
        yield textDelta("part2");
        yield finishStop();
      });
      // Rebuild a capturing ctx: the generator needs the options.
      const capturingCtx = {
        get: (name: string) => {
          if (name === "llm") {
            return {
              stream: (options: unknown) => {
                seen.push(options as { system?: string; messages?: unknown[] });
                return (async function* () {
                  yield textDelta("<think>internal</think> ");
                  yield textDelta("the answer");
                  yield finishStop();
                })();
              },
            };
          }
          if (name === "agentDefaultModel") {
            return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) };
          }
          return undefined;
        },
      };
      const result = await runDshSidekick(capturingCtx as never, { db, log: () => {} }, {
        agent: { id: "s1" } as never,
        prompt: "augment this",
        cwd: undefined,
        signal: new AbortController().signal,
      });
      expect(result).toBe("the answer");
      const options = seen[0] as { system?: string; messages?: { content: { text: string }[] }[] };
      expect(options.system).toContain("ctx_search");
      expect(options.messages?.[0]?.content?.[0]?.text).toContain("augment this");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("returns null on empty/fallback output and on LLM failure (never throws)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-sidekick-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      // Empty result.
      const emptyCtx = fakeCtx((async function* () {
        yield finishStop();
      })());
      const empty = await runDshSidekick(emptyCtx as never, { db, log: () => {} }, {
        agent: { id: "s1" } as never,
        prompt: "x",
        signal: new AbortController().signal,
      });
      expect(empty).toBeNull();
      // LLM error finish.
      const errorCtx = fakeCtx((async function* () {
        yield { type: "finish", reason: { kind: "error", failure: { message: "boom" } } };
      })());
      const failed = await runDshSidekick(errorCtx as never, { db, log: () => {} }, {
        agent: { id: "s1" } as never,
        prompt: "x",
        signal: new AbortController().signal,
      });
      expect(failed).toBeNull();
      // No llm service at all.
      const noLlmCtx = { get: () => undefined };
      const noLlm = await runDshSidekick(noLlmCtx as never, { db, log: () => {} }, {
        agent: { id: "s1" } as never,
        prompt: "x",
        signal: new AbortController().signal,
      });
      expect(noLlm).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("renders search results into a bounded block and the seam passes through", async () => {
    expect(renderSearchResults(null)).toBe("");
    expect(renderSearchResults([])).toBe("");
    const rendered = renderSearchResults([
      { snippet: "memory one", score: 0.9 },
      { snippet: "memory two", score: 0.8 },
    ]);
    expect(rendered).toContain("memory one");
    expect(rendered).toContain("[2] memory two");
    const seam = createSidekickSeam({ get: () => undefined } as never, { log: () => {} });
    expect(typeof seam).toBe("function");
  });
});
