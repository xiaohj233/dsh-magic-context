/**
 * Phase 2 slice B — ctx_* tool tests.
 *
 * Harness: `createTestDb` (harness locked to "dsh" first) + a fake tools
 * runtime + a fake DSH agent. Tool executions call the registered
 * `ToolDefinition.execute(args, exec)` directly with a minimal exec carrying
 * the fake agent, so the whole session-resolution → core-business-function →
 * DB-write path is exercised without a live DSH loop.
 *
 * ctx_search uses the no-embedding stub lane (`embeddingEnabled: false`) so no
 * embedding provider or network is touched (documented test seam).
 */
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { canonicalSessionKey } from "dsh-magic-context-adapter";
import type { Database } from "@magic-context/core/shared/sqlite";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { createTestDb, createTestStorageDir } from "../test-utils";
import { registerCtxTools, type CtxToolsOptions } from "./tools";

const HOME_HASH = "a1b2c3d4";
const PROJECT = "git:/tmp/dsh-proj";
const SESSION_ID = "session-1";
const CANONICAL = canonicalSessionKey(HOME_HASH, SESSION_ID);

/** Windows may hold SQLite WAL handles briefly after close; best-effort retry. */
async function removeTestDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
}

interface FakeToolsRuntime {
  registered: ToolDefinition[];
  ctx: Context;
}

function makeFakeCtx(): FakeToolsRuntime {
  const registered: ToolDefinition[] = [];
  const ctx = {
    get(name: string): unknown {
      if (name === "tools") {
        return {
          register: (definition: ToolDefinition): (() => void) => {
            registered.push(definition);
            return () => {
              const index = registered.indexOf(definition);
              if (index >= 0) registered.splice(index, 1);
            };
          },
        };
      }
      return undefined;
    },
  };
  return { registered, ctx: ctx as unknown as Context };
}

function makeFakeAgent(id: string, cwd: string): Agent {
  return {
    id,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { id, cwd }, deriveMessages: () => [] },
  } as unknown as Agent;
}

function toolExec(agent: Agent): ToolRunContext {
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
}

function baseOpts(db: Database): CtxToolsOptions {
  return {
    db,
    canonicalKey: (id: string) => canonicalSessionKey(HOME_HASH, id),
    resolveProjectIdentity: () => PROJECT,
    embeddingEnabled: false,
    memoryEnabled: true,
    dreamerEnabled: true,
    // No protected tail in tests → ctx_reduce drops are immediate.
    protectedTags: 0,
  };
}

async function openDb(): Promise<{ db: Database; dir: string }> {
  const dir = createTestStorageDir();
  const db = await createTestDb(join(dir, "context.db"));
  return { db, dir };
}

function findTool(registered: ToolDefinition[], name: string): ToolDefinition {
  const tool = registered.find((definition) => definition.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

const textOf = (value: unknown): string => (value as { text: string }).text;

describe("registerCtxTools (DSH ctx_* tools)", () => {
  it("registers all five tools and unregisters them via the disposer", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      const dispose = registerCtxTools(ctx, baseOpts(db));
      const names = registered.map((definition) => definition.name).sort();
      expect(names).toEqual([
        "ctx_expand",
        "ctx_memory",
        "ctx_note",
        "ctx_reduce",
        "ctx_search",
      ]);
      dispose();
      expect(registered.length).toBe(0);
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("omits ctx_reduce when compactionOff is set (Pi parity)", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, { ...baseOpts(db), compactionOff: true });
      const names = registered.map((definition) => definition.name);
      expect(names).toContain("ctx_search");
      expect(names).toContain("ctx_note");
      expect(names).not.toContain("ctx_reduce");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("omits session-scoped tools when sessionScopedToolsDisabled is set", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, { ...baseOpts(db), sessionScopedToolsDisabled: true });
      const names = registered.map((definition) => definition.name);
      expect(names).toContain("ctx_search");
      expect(names).toContain("ctx_memory");
      expect(names).not.toContain("ctx_note");
      expect(names).not.toContain("ctx_expand");
      expect(names).not.toContain("ctx_reduce");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("omits ctx_memory when memoryToolEnabled is false", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, { ...baseOpts(db), memoryToolEnabled: false });
      const names = registered.map((definition) => definition.name);
      expect(names).not.toContain("ctx_memory");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("ctx_search (no-embedding stub lane)", () => {
  it("searches and returns a formatted no-results text without touching embeddings", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db));
      const tool = findTool(registered, "ctx_search");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      // Defensive stub: other test files in this package spyOn the shared
      // `search` module (bun reuses one module namespace per process), so the
      // real unifiedSearch may already be replaced by a foreign mock. Own the
      // lane here and always restore it afterwards.
      const searchSpy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
      try {
        const value = await tool.execute(
          { query: "definitely-no-such-topic-xyz" },
          toolExec(agent),
        );
        expect(textOf(value)).toContain("No results found");
        expect(searchSpy).toHaveBeenCalledTimes(1);
        // The tool passes the canonical session key and project identity.
        const call = searchSpy.mock.calls[0];
        expect(call?.[1]).toBe(CANONICAL);
        expect(call?.[2]).toBe(PROJECT);

        // Canonical session key is the search scope; rows land under it.
        const meta = db
          .prepare("SELECT session_id FROM session_meta WHERE session_id = ?")
          .get(CANONICAL);
        expect(meta).toBeDefined();
      } finally {
        searchSpy.mockRestore();
      }
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("ctx_note write path", () => {
  it("writes a session note row under the canonical session key", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db));
      const tool = findTool(registered, "ctx_note");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const value = await tool.execute(
        { action: "write", content: "remember: use bun for builds" },
        toolExec(agent),
      );
      expect(textOf(value)).toContain("Saved session note #");

      const row = db
        .prepare("SELECT * FROM notes WHERE session_id = ?")
        .get(CANONICAL) as { content: string; type: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.content).toBe("remember: use bun for builds");
      expect(row?.type).toBe("session");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("ctx_memory write path", () => {
  it("inserts a memory row for the project and dedups identical content", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db));
      const tool = findTool(registered, "ctx_memory");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const first = await tool.execute(
        { action: "write", content: "The build uses bun", category: "ARCHITECTURE" },
        toolExec(agent),
      );
      expect(textOf(first)).toContain("Saved memory [ID:");

      const row = db
        .prepare("SELECT * FROM memories WHERE project_path = ? AND content = ?")
        .get(PROJECT, "The build uses bun") as { category: string; source_session_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.category).toBe("ARCHITECTURE");

      // Identical write → seen-count bump, no second row.
      const second = await tool.execute(
        { action: "write", content: "The build uses bun", category: "ARCHITECTURE" },
        toolExec(agent),
      );
      expect(textOf(second)).toContain("already exists");
      const count = (
        db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_path = ?").get(PROJECT) as {
          c: number;
        }
      ).c;
      expect(count).toBe(1);
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("rejects dreamer-only actions unless allowDreamerActions is set", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db)); // allowDreamerActions: false
      const tool = findTool(registered, "ctx_memory");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      await expect(
        tool.execute({ action: "list", limit: 5 }, toolExec(agent)),
      ).rejects.toThrow("not allowed in this context");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("ctx_reduce drop path", () => {
  it("queues a pending_ops drop row for an existing tag", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db));
      const tool = findTool(registered, "ctx_reduce");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, ?, 'message', 'active', 100, 1)",
      ).run(CANONICAL, "m1");

      const value = await tool.execute({ drop: "1" }, toolExec(agent));
      expect(textOf(value)).toContain("Queued: drop §1§");

      const pending = db
        .prepare("SELECT * FROM pending_ops WHERE session_id = ?")
        .all(CANONICAL) as Array<{ tag_id: number; operation: string }>;
      expect(pending.length).toBe(1);
      expect(pending[0]?.tag_id).toBe(1);
      expect(pending[0]?.operation).toBe("drop");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("rejects unknown tag ids", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxTools(ctx, baseOpts(db));
      const tool = findTool(registered, "ctx_reduce");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      await expect(tool.execute({ drop: "99" }, toolExec(agent))).rejects.toThrow(
        "Unknown tag(s) §99§",
      );
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});
