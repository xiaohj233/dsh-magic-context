import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionKey } from "dsh-magic-context-adapter";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
  createKnowledgeGateState,
  isMagicWatermarkOnSurface,
  materializeKnowledgeBlocks,
  maybeInjectKnowledge,
  resolveKnowledgeProjectPath,
  runKnowledgeGateStep,
  type KnowledgeAgentView,
  type KnowledgeGateDeps,
  type KnowledgeGateState,
} from "./knowledge-gate";
import type { PreStepDecision } from "../compat/dsh-0.1/prestep";
import type { UserMessage } from "../compat/dsh-0.1/session";

const HOME_HASH = "a1b2c3d4";

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

interface FakeAgentHarness {
  agent: KnowledgeAgentView;
  injected: UserMessage[];
  events: Array<Record<string, unknown>>;
  nodes: number[];
  replaceGeneration: number;
}

function makeFakeAgent(directory: string): FakeAgentHarness {
  const injected: UserMessage[] = [];
  const events: Array<Record<string, unknown>> = [];
  const nodes: number[] = [];
  const harness: FakeAgentHarness = {
    injected,
    events,
    nodes,
    replaceGeneration: 0,
    agent: {
      id: "sess-1" as SessionId,
      options: { provider: "deepseek", model: "deepseek-chat" },
      session: {
        surface: {
          get nodes() {
            return nodes;
          },
          get replaceGeneration() {
            return harness.replaceGeneration;
          },
        },
        events,
        header: { cwd: directory },
      },
      inject(message: UserMessage) {
        injected.push(message);
        events.push({
          type: "user/message",
          seq: events.length,
          time: Date.now(),
          data: message,
          surfaceOp: "append",
        });
        nodes.push(events.length - 1);
      },
    },
  };
  return harness;
}

function fakeHost(db: Database, directory: string): KnowledgeGateDeps["host"] {
  return {
    ready: Promise.resolve({
      kind: "ok" as const,
      db,
      storageDir: directory,
      livenessPath: "",
    }),
    canonicalKey: (dshSessionId: string) => canonicalSessionKey(HOME_HASH, dshSessionId),
  };
}

function fakeDeps(db: Database, directory: string): KnowledgeGateDeps {
  return {
    host: fakeHost(db, directory),
    config: { injectDocs: false, compactionOff: true },
    autoSearch: { enabled: false },
    log: () => {},
  };
}

function passThroughNext(): () => Promise<PreStepDecision> {
  return async () => ({ kind: "enter", messages: [] });
}

function userMessage(text: string): UserMessage {
  return {
    id: `user-msg-${Math.random().toString(36).slice(2)}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  } as unknown as UserMessage;
}

describe("agent knowledge gate (m0/m1 first-step injection)", () => {
  it("injects the knowledge baseline once on the first pre-step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const identity = resolveKnowledgeProjectPath(dir);
      expect(identity).toBeDefined();
      insertMemory(db, {
        projectPath: identity as string,
        category: "PROJECT_RULES",
        content: "unique knowledge content alpha",
        sourceType: "user",
      });

      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);

      const decision = await runKnowledgeGateStep(
        state,
        deps,
        { agent: harness.agent, messages: [userMessage("hello world this is my first question about the project")] },
        passThroughNext(),
      );

      expect(decision.kind).toBe("enter");
      // Pi 语义：m0 与 m1 是两条独立合成消息。
      expect(harness.injected.length).toBe(2);
      const message = harness.injected[0];
      expect(message.role).toBe("user");
      expect(message.content[0].type).toBe("text");
      const text = message.content[0].type === "text" ? message.content[0].text : "";
      expect(text).toContain("unique knowledge content alpha");
      const m1Text = harness.injected[1].content[0].type === "text" ? harness.injected[1].content[0].text : "";
      expect(m1Text).toContain("<session-history-since>");
      const source = message.source as {
        kind: string;
        plugin: string;
        messageId?: string;
        revision?: string;
        digest?: string;
      };
      expect(source.kind).toBe("plugin");
      expect(source.plugin).toBe("magic-context");
      expect(source.messageId).toMatch(/^mc-kb:\d+:[0-9a-f]{16}$/);
      expect(source.revision).toBeDefined();
      expect(source.digest).toMatch(/^[0-9a-f]{16}$/);

      // The core pipeline persisted the cached baseline (materializeM0 →
      // persistCachedM0) under the canonical session key.
      const meta = getOrCreateSessionMeta(db, canonicalSessionKey(HOME_HASH, "sess-1"));
      expect(meta.cachedM0Bytes).not.toBeNull();
      expect(meta.cachedM1Bytes).not.toBeNull();

      // session_projects attribution row exists for the canonical session key.
      const row = db
        .prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'dsh'")
        .get(canonicalSessionKey(HOME_HASH, "sess-1")) as { project_path: string } | undefined;
      expect(row?.project_path).toBe(identity);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("does not re-inject within the same surface generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);

      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("first message about the project setup")] }, passThroughNext());
      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("second message about the build pipeline")] }, passThroughNext());
      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("third message about the release process")] }, passThroughNext());

      expect(harness.injected.length).toBe(2);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("re-injects on a new surface generation, reusing the cache watermark", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const identity = resolveKnowledgeProjectPath(dir);
      insertMemory(db, {
        projectPath: identity as string,
        category: "PROJECT_RULES",
        content: "stable project fact for generation reuse",
        sourceType: "user",
      });
      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);

      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("first turn question")] }, passThroughNext());
      expect(harness.injected.length).toBe(2);
      const firstWatermark = (harness.injected[0].source as { messageId?: string }).messageId;

      // Compact/clear: surface replaced → new generation, old nodes shadowed.
      harness.replaceGeneration = 1;
      harness.nodes.length = 0;
      harness.events.length = 0;

      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("second turn after compaction")] }, passThroughNext());

      // 新 generation 重新注入两条（m0+m1）→ 累计 4 条。
      expect(harness.injected.length).toBe(4);
      const secondWatermark = (harness.injected[2].source as { messageId?: string }).messageId;
      // Cache was valid: same persisted bytes → same content watermark.
      expect(secondWatermark).toBe(firstWatermark);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("watermark de-dup skips injection when the surface already carries the baseline (resume)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const harness = makeFakeAgent(dir);

      // First process: inject once.
      const firstState = createKnowledgeGateState();
      await runKnowledgeGateStep(firstState, deps, { agent: harness.agent, messages: [userMessage("resume scenario first message")] }, passThroughNext());
      expect(harness.injected.length).toBe(2);
      const watermark = (harness.injected[0].source as { messageId?: string }).messageId as string;
      expect(isMagicWatermarkOnSurface(harness.agent.session, watermark)).toBe(true);

      // Restart: fresh state (empty Maps) but the same durable log is replayed —
      // the visible surface still carries the watermark → no re-injection.
      const resumedState = createKnowledgeGateState();
      await runKnowledgeGateStep(resumedState, deps, { agent: harness.agent, messages: [userMessage("post-restart message")] }, passThroughNext());
      expect(harness.injected.length).toBe(2);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("passes the pre-step through when the storage bootstrap is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps: KnowledgeGateDeps = {
        host: {
          ready: Promise.resolve({ kind: "refused", reason: "schema-fence", detail: null }),
          canonicalKey: (id: string) => canonicalSessionKey(HOME_HASH, id),
        },
        config: {},
        autoSearch: { enabled: false },
        log: () => {},
      };
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      const decision = await runKnowledgeGateStep(
        state,
        deps,
        { agent: harness.agent, messages: [userMessage("hello")] },
        passThroughNext(),
      );
      expect(decision.kind).toBe("enter");
      expect(harness.injected.length).toBe(0);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("materializeKnowledgeBlocks returns a stable watermark across cache-valid passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const harness = makeFakeAgent(dir);
      const first = materializeKnowledgeBlocks(deps, db, canonicalSessionKey(HOME_HASH, "sess-1"), resolveKnowledgeProjectPath(dir), dir, harness.agent);
      const second = materializeKnowledgeBlocks(deps, db, canonicalSessionKey(HOME_HASH, "sess-1"), resolveKnowledgeProjectPath(dir), dir, harness.agent);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second?.watermark).toBe(first?.watermark);
      expect(first?.text.length).toBeGreaterThan(0);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("maybeInjectKnowledge is a no-op when knowledge is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps: KnowledgeGateDeps = {
        host: fakeHost(db, dir),
        config: { enabled: false },
        autoSearch: { enabled: false },
      };
      const state: KnowledgeGateState = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      maybeInjectKnowledge(state, deps, harness.agent, db, canonicalSessionKey(HOME_HASH, "sess-1"), resolveKnowledgeProjectPath(dir), dir);
      expect(harness.injected.length).toBe(0);
    } finally {
      await cleanupDir(dir, db);
    }
  });

  it("rides the mural image block on the baseline when enabled + vision + data URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      const magicSessionId = canonicalSessionKey(HOME_HASH, "sess-1");
      // Prime the m0 cache with mural ENABLED from the start (flipping
      // muralEnabled between passes re-materializes and wipes the URL), then
      // seed the mural data URL as a later fold would.
      const depsMuralConfig: KnowledgeGateDeps = {
        ...deps,
        config: { ...deps.config, muralEnabled: true },
        mural: {
          enabled: true,
          supportsVision: () => true,
          resolveImage: async (dataUrl: string) => {
            expect(dataUrl.startsWith("data:image/png")).toBe(true);
            return { type: "image", attachment: { attachmentId: "att-1" } };
          },
        },
      };
      await maybeInjectKnowledge(state, depsMuralConfig, harness.agent, db, magicSessionId, resolveKnowledgeProjectPath(dir), dir);
      db.prepare(
        "UPDATE session_meta SET cached_m0_mural_data_url = ? WHERE session_id = ?",
      ).run("data:image/png;base64,iVBORw0KGgo=", magicSessionId);

      const state2 = createKnowledgeGateState();
      const harness2 = makeFakeAgent(dir);
      await maybeInjectKnowledge(state2, depsMuralConfig, harness2.agent, db, magicSessionId, resolveKnowledgeProjectPath(dir), dir);
      expect(harness2.injected.length).toBe(2);
      const content = harness2.injected[0]?.content ?? [];
      expect(content.some((block) => block.type === "image")).toBe(true);
      expect(content.some((block) => block.type === "text")).toBe(true);
    } finally {
      await cleanupDir(dir, db);
    }
  });
});

describe("synthetic todowrite replay (Magic todo-view parity)", () => {
  it("injects a mc-todo replay message on materialization when last_todo_state exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-todo-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      // 预置 todo 快照（含非终态任务）。
      const todos = [
        { content: "write report", status: "in_progress" },
        { content: "fix bug", status: "pending" },
      ];
      const todoState = JSON.stringify(todos);
      // 先建完整行（getOrCreateSessionMeta 语义），再写 last_todo_state。
      const sid = canonicalSessionKey(HOME_HASH, harness.agent.id);
      const { getOrCreateSessionMeta } = await import("@magic-context/core/features/magic-context/storage");
      getOrCreateSessionMeta(db, sid);
      db.prepare("UPDATE session_meta SET last_todo_state = ? WHERE session_id = ?").run(todoState, sid);

      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("first message")] }, passThroughNext());

      const todoMessages = harness.injected.filter((m) => {
        const src = m.source as { messageId?: string };
        return typeof src.messageId === "string" && src.messageId.startsWith("mc-todo:");
      });
      expect(todoMessages.length).toBe(1);
      const text = todoMessages[0].content[0].type === "text" ? todoMessages[0].content[0].text : "";
      expect(text).toContain("[tool: todowrite #mc_synthetic_todo_");
      expect(text).toContain("write report");
      expect(text).toContain("fix bug");
    } finally {
      db?.close();
      await cleanupDir(dir, db);
    }
  });

  it("skips the todo replay when the snapshot is all-terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-todo-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = fakeDeps(db, dir);
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      const todoState = JSON.stringify([{ content: "done", status: "completed" }]);
      const sid2 = canonicalSessionKey(HOME_HASH, harness.agent.id);
      const { getOrCreateSessionMeta } = await import("@magic-context/core/features/magic-context/storage");
      getOrCreateSessionMeta(db, sid2);
      db.prepare("UPDATE session_meta SET last_todo_state = ? WHERE session_id = ?").run(todoState, sid2);

      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("first")] }, passThroughNext());
      const todoMessages = harness.injected.filter((m) => {
        const src = m.source as { messageId?: string };
        return typeof src.messageId === "string" && src.messageId.startsWith("mc-todo:");
      });
      expect(todoMessages.length).toBe(0);
    } finally {
      db?.close();
      await cleanupDir(dir, db);
    }
  });
});

describe("deferred materialization after historian publish (Pi parity)", () => {
  it("forces an m0 re-materialization that renders <session-history> compartments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-kg-deferred-"));
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const deps = { ...fakeDeps(db, dir), config: { injectDocs: false, compactionOff: false } };
      const state = createKnowledgeGateState();
      const harness = makeFakeAgent(dir);
      const sid = canonicalSessionKey(HOME_HASH, harness.agent.id);

      // 首轮物化：空 m0。
      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("first")] }, passThroughNext());
      let meta = db.prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id=?").get(sid) as { cached_m0_bytes: Buffer | null };
      let text = meta.cached_m0_bytes ? new TextDecoder().decode(meta.cached_m0_bytes) : "";
      expect(text).toContain("<session-history></session-history>");

      // 模拟 historian 发布：用共享 appendCompartments 写入 + 发 deferred 信号。
      const { appendCompartments } = await import("@magic-context/core/features/magic-context/compartment-storage");
      appendCompartments(db, sid, [
        {
          sequence: 0,
          title: "First compacted arc",
          importance: 10,
          startMessage: 1,
          endMessage: 3,
          content: "First compacted arc content",
          p1: "p1 text",
          p2: "p2",
          p3: "p3",
          p4: "p4",
          episodeType: "docs",
          firstKeptEntryId: "e1",
        },
      ]);
      const { signalDshDeferredMaterialization } = await import("./historian");
      signalDshDeferredMaterialization(sid);

      // 下一轮 pre-step：应强制 HARD 物化 → m0 渲染 <session-history> 含 compartment。
      state.injectedGenerations.delete(sid);
      harness.replaceGeneration = 1;
      await runKnowledgeGateStep(state, deps, { agent: harness.agent, messages: [userMessage("after publish")] }, passThroughNext());
      meta = db.prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id=?").get(sid) as { cached_m0_bytes: Buffer | null };
      text = meta.cached_m0_bytes ? new TextDecoder().decode(meta.cached_m0_bytes) : "";
      expect(text).toContain("<session-history>");
      expect(text).toContain("First compacted arc");
      expect(text).not.toContain("<session-history></session-history>");
    } finally {
      db?.close();
      await cleanupDir(dir, db);
    }
  });
});
