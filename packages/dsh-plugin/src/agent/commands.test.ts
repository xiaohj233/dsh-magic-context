/**
 * Phase 2 slice B — /ctx-* command tests.
 *
 * Harness: `createTestDb` + a fake commands runtime (the compat
 * `registerCommand` reads `ctx.commands` / the `commands` service lookup) + a
 * fake DSH agent. Handlers are invoked with a minimal CommandInvocation and
 * their `CommandResult` text is asserted.
 *
 * /ctx-status asserts the executeStatus output (canonical session key echo);
 * /ctx-flush asserts pending-op clearing + tag status flip. The LLM-dependent
 * commands are asserted on their guard / not-wired messages (their runners are
 * later-slice seams).
 */
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { canonicalSessionKey } from "@xiao_hj909/magic-context-for-dsh-adapter";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getPendingOps, queuePendingOp } from "@magic-context/core/features/magic-context/storage";
import { createTestDb, createTestStorageDir } from "../test-utils";
import {
  parseRecompArgs,
  parseWrapupArgs,
  registerCtxCommands,
  type CtxCommandsOptions,
} from "./commands";
import type { CommandResult } from "../compat/dsh-0.1/commands";

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

interface FakeCommandRecord {
  name: string;
  handler: (invocation: {
    agent: Agent;
    rawInput: string;
    signal: AbortSignal;
  }) => Promise<CommandResult> | CommandResult;
}

function makeFakeCtx() {
  const registered: FakeCommandRecord[] = [];
  const commands = {
    register: (definition: FakeCommandRecord): (() => void) => {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
  const ctx = { get: (name: string) => (name === "commands" ? commands : undefined) };
  return { registered, ctx: ctx as unknown as Context };
}

function makeFakeAgent(id: string, cwd: string): Agent {
  return {
    id,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { id, cwd }, deriveMessages: () => [] },
    followup: () => {},
  } as unknown as Agent;
}

function invocation(agent: Agent, rawInput = "") {
  return { agent, rawInput, signal: new AbortController().signal };
}

function baseOpts(db: Database): CtxCommandsOptions {
  return {
    db,
    canonicalKey: (id: string) => canonicalSessionKey(HOME_HASH, id),
    resolveProjectIdentity: () => PROJECT,
    protectedTags: 20,
  };
}

async function openDb(): Promise<{ db: Database; dir: string }> {
  const dir = createTestStorageDir();
  const db = await createTestDb(join(dir, "context.db"));
  return { db, dir };
}

function findCommand(registered: FakeCommandRecord[], name: string): FakeCommandRecord {
  const command = registered.find((record) => record.name === name);
  if (!command) throw new Error(`command ${name} not registered`);
  return command;
}

describe("registerCtxCommands (DSH /ctx-* commands)", () => {
  it("registers all eight commands and unregisters via the disposer", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      const dispose = registerCtxCommands(ctx, baseOpts(db));
      const names = registered.map((record) => record.name).sort();
      expect(names).toEqual([
        "ctx-aug",
        "ctx-dream",
        "ctx-embed",
        "ctx-flush",
        "ctx-recomp",
        "ctx-session-upgrade",
        "ctx-status",
        "ctx-wrapup",
      ]);
      dispose();
      expect(registered.length).toBe(0);
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("/ctx-status", () => {
  it("renders executeStatus output including the canonical session key", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxCommands(ctx, baseOpts(db));
      const command = findCommand(registered, "ctx-status");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const result = (await command.handler(invocation(agent))) as CommandResult;
      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      expect(result.text).toContain("## Magic Status");
      // The canonical key (dsh:<homeHash>:<session>) is the Magic session id.
      expect(result.text).toContain(`**Session:** ${CANONICAL}`);
      expect(result.text).toContain("### Tags");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("/ctx-flush", () => {
  it("flushes pending drops and marks tags dropped", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxCommands(ctx, baseOpts(db));
      const command = findCommand(registered, "ctx-flush");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, ?, 'message', 'active', 100, 1)",
      ).run(CANONICAL, "m1");
      queuePendingOp(db, CANONICAL, 1, "drop", Date.now());
      expect(getPendingOps(db, CANONICAL).length).toBe(1);

      const result = (await command.handler(invocation(agent))) as CommandResult;
      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      expect(result.text).toContain("Flushed 1 pending ops");
      expect(getPendingOps(db, CANONICAL).length).toBe(0);

      const tag = db
        .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = 1")
        .get(CANONICAL) as { status: string } | undefined;
      expect(tag?.status).toBe("dropped");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});

describe("LLM-dependent commands (guard / not-wired messages)", () => {
  it("/ctx-dream rejects unknown tasks and reports the not-wired runner", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxCommands(ctx, baseOpts(db));
      const command = findCommand(registered, "ctx-dream");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const unknown = (await command.handler(
        invocation(agent, "bogus-task"),
      )) as CommandResult;
      expect(unknown.kind).toBe("success");
      if (unknown.kind !== "success") return;
      expect(unknown.text).toContain('Unknown task "bogus-task"');

      const notWired = (await command.handler(invocation(agent))) as CommandResult;
      expect(notWired.kind).toBe("success");
      if (notWired.kind !== "success") return;
      expect(notWired.text).toContain("not wired");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("/ctx-aug reports usage and the not-wired sidekick runner", async () => {
    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxCommands(ctx, baseOpts(db));
      const command = findCommand(registered, "ctx-aug");
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const usage = (await command.handler(invocation(agent))) as CommandResult;
      expect(usage.kind).toBe("error");
      expect(usage.text).toContain("Usage `/ctx-aug <your prompt>`");

      const notWired = (await command.handler(
        invocation(agent, "why does the build fail"),
      )) as CommandResult;
      expect(notWired.kind).toBe("success");
      if (notWired.kind !== "success") return;
      expect(notWired.text).toContain("not wired");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });

  it("/ctx-recomp and /ctx-wrapup parse args and gate on compactionOff", async () => {
    expect(parseRecompArgs("")).toEqual({ kind: "full" });
    expect(parseRecompArgs("1-5")).toEqual({ kind: "partial", range: { start: 1, end: 5 } });
    expect(parseRecompArgs("--upgrade")).toEqual({ kind: "upgrade" });
    expect(parseRecompArgs("nonsense").kind).toBe("error");
    expect(parseWrapupArgs("")).toEqual({ ok: true, messagesToKeep: 20 });
    expect(parseWrapupArgs("10")).toEqual({ ok: true, messagesToKeep: 10 });
    expect(parseWrapupArgs("abc").ok).toBe(false);
    expect(parseWrapupArgs("0").ok).toBe(false);

    const { db, dir } = await openDb();
    try {
      const { ctx, registered } = makeFakeCtx();
      registerCtxCommands(ctx, { ...baseOpts(db), compactionOff: true });
      const agent = makeFakeAgent(SESSION_ID, "/tmp/dsh-proj");

      const recomp = (await findCommand(registered, "ctx-recomp").handler(
        invocation(agent),
      )) as CommandResult;
      expect(recomp.kind).toBe("error");
      expect(recomp.text).toContain("compaction-off");

      const wrapup = (await findCommand(registered, "ctx-wrapup").handler(
        invocation(agent),
      )) as CommandResult;
      expect(wrapup.kind).toBe("error");
      expect(wrapup.text).toContain("compaction-off");
    } finally {
      db.close();
      await removeTestDir(dir);
    }
  });
});
