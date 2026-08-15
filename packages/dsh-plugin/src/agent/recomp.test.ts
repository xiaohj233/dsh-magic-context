/**
 * agent/recomp — Phase 4 slice P3 tests (bun test).
 *
 * Pattern mirrors historian.test.ts / outbox.test.ts: real DSH session
 * (Session.create + append), core test DB via createTestDb (harness locked to
 * dsh), WAL-EBUSY-safe cleanup with retry. All LLM calls are injected stubs —
 * no network.
 *
 * Coverage:
 *   - client unit tests: session.get/create, prompt (stub LLM), messages
 *     shape, per-attempt model override, agent-id system-prompt resolution,
 *     noReply notify, timeout (AbortSignal + race), external abort;
 *   - seam unit tests: runRecomp / runWrapup / runUpgrade with INJECTED fake
 *     runners (assert the ManagedRecompContext/ManagedWrapupContext shape,
 *     the partial-range parsing, the raw-message provider registration, and
 *     message passthrough);
 *   - one true-core integration test: runWrapup through the REAL
 *     runManagedWrapup with the compartment-agent runner stubbed (the shared
 *     core's own test seam — no LLM/XML needed) over the transcript-backed
 *     provider + real DB.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  appendCompartments,
  getCompartments,
  getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
  COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { readRawSessionMessages } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { ManagedRecompContext } from "@magic-context/core/hooks/magic-context/recomp-orchestrator";
import type { ManagedWrapupContext } from "@magic-context/core/hooks/magic-context/wrapup-orchestrator";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createUserMessage } from "../compat/dsh-0.1/session";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { createTestDb } from "../test-utils";
import { readDshTranscript } from "./transcript";
import {
  createDshSessionClient,
  createRecompSeams,
  type DshClientMessage,
  type DshSessionClient,
} from "./recomp";

const SESSION_ID = "dsh:a1b2c3d4:sess-recomp";
const DSH_SESSION_ID = "sess-recomp";

async function cleanupDir(dir: string): Promise<void> {
  // Windows WAL: the DB handle's close is not immediately reflected in file
  // locks; retry like outbox.test.ts does.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function makeEnv(): { dbPath: string; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-recomp-"));
  return { dbPath: join(dir, "context.db"), cleanup: () => cleanupDir(dir) };
}

/** A real DSH session: 5 user/assistant turns → raw ordinals 1..10. */
function buildSession(): Session {
  const session = Session.create(SessionId(DSH_SESSION_ID));
  for (let turn = 1; turn <= 5; turn += 1) {
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: `question ${turn}` }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        turn,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `answer ${turn}` }],
          provider: "deepseek",
          model: "deepseek-chat",
          source: { kind: "model" },
        },
      },
      { surfaceOp: "append" },
    );
  }
  return session;
}

/** Transcript view over the session (message ids for compartment rows). */
function viewOf(session: Session) {
  return readDshTranscript({
    session: { events: session.events, surface: session.surface, header: {} },
    canonicalSessionId: SESSION_ID,
  });
}

/** A minimal Agent carrying the session + live model route. */
function fakeAgent(session: Session, cwd = "C:/proj"): Agent {
  return {
    id: DSH_SESSION_ID,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { events: session.events, surface: session.surface, header: { cwd, id: DSH_SESSION_ID } },
    followup: () => {},
  } as unknown as Agent;
}

/** Injected LLM stream stub: fixed reply, hang-until-abort, or call recorder. */
function stubLlm(opts: {
  reply?: string;
  hang?: boolean;
  onCall?: (options: GenerateOptions) => void;
}): LlmRuntime {
  const runtime = {
    stream(options: GenerateOptions) {
      opts.onCall?.(options);
      return (async function* () {
        if (opts.hang) {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "finish", reason: { kind: "aborted" } };
          return;
        }
        if (opts.reply) yield { type: "text-delta", index: 0, text: opts.reply };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  } as unknown as LlmRuntime;
  return runtime;
}

const noopDb = {} as Database;

/* ─────────────────────────── client unit tests ────────────────────────────── */

describe("createDshSessionClient", () => {
  it("session.get reports the configured directory (or an empty data object)", async () => {
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      directory: "C:/proj",
    });
    expect(await client.session.get({ path: { id: "x" } })).toEqual({ data: { directory: "C:/proj" } });

    const clientNoDir = createDshSessionClient({ ctx: {} as Context, db: noopDb });
    expect(await clientNoDir.session.get()).toEqual({ data: {} });
  });

  it("session.create returns distinct opaque ids", async () => {
    const client = createDshSessionClient({ ctx: {} as Context, db: noopDb });
    const first = await client.session.create({ body: { title: "t1" }, query: { directory: "C:/proj" } });
    const second = await client.session.create({ body: { title: "t2" } });
    expect(typeof first.id).toBe("string");
    expect(first.id.length).toBeGreaterThan(0);
    expect(second.id).not.toBe(first.id);
  });

  it("prompt runs the LLM with parts text, body.system, the model override, and purpose compaction", async () => {
    const calls: GenerateOptions[] = [];
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ reply: "<magic-context>…</magic-context>", onCall: (o) => calls.push(o) }),
    });
    const result = await client.session.prompt({
      path: { id: "child-1" },
      query: { directory: "C:/proj" },
      body: {
        agent: "historian",
        system: "SYS",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        parts: [{ type: "text", text: "chunk text", synthetic: true }],
      },
    });
    expect(result).toEqual({});
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.system).toBe("SYS");
    expect(call.purpose).toBe("compaction");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    const user = call.messages[0] as { content?: Array<{ type?: string; text?: string }> };
    expect(user?.content?.[0]).toEqual({ type: "text", text: "chunk text" });
  });

  it("resolves the registered Magic historian agent prompt when body.system is absent", async () => {
    const calls: GenerateOptions[] = [];
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ onCall: (o) => calls.push(o) }),
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    await client.session.prompt({
      path: { id: "c" },
      body: { agent: "historian-recomp", parts: [{ type: "text", text: "x" }] },
    });
    expect(calls[0]?.system).toBe(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT);
    // Explicit system wins over the agent mapping.
    const explicit: GenerateOptions[] = [];
    const client2 = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ onCall: (o) => explicit.push(o) }),
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    await client2.session.prompt({
      path: { id: "c2" },
      body: { agent: "historian", system: "EXPLICIT", parts: [{ type: "text", text: "x" }] },
    });
    expect(explicit[0]?.system).toBe("EXPLICIT");
  });

  it("falls back to the default route when the body has no model override", async () => {
    const calls: GenerateOptions[] = [];
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ onCall: (o) => calls.push(o) }),
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    await client.session.prompt({
      path: { id: "c" },
      body: { agent: "historian", parts: [{ type: "text", text: "x" }] },
    });
    expect(calls[0]?.provider).toBe("deepseek");
    expect(calls[0]?.model).toBe("deepseek-chat");
  });

  it("messages returns the synthetic assistant message for the prompted child", async () => {
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ reply: "the historian output" }),
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    await client.session.prompt({
      path: { id: "child-1" },
      body: { parts: [{ type: "text", text: "x" }] },
    });
    const { data } = await client.session.messages({ path: { id: "child-1" }, query: { directory: "C:/proj", limit: 50 } });
    expect(data).toHaveLength(1);
    const message = data[0] as DshClientMessage;
    expect(message.info.role).toBe("assistant");
    expect(typeof message.info.time.created).toBe("number");
    expect(message.parts).toEqual([{ type: "text", text: "the historian output" }]);
    expect(message.role).toBe("assistant");
    expect(message.content).toEqual([{ type: "text", text: "the historian output" }]);
    // Unknown child → no messages.
    expect((await client.session.messages({ path: { id: "never-prompted" } })).data).toEqual([]);
  });

  it("noReply prompts surface the text through log and never call the LLM", async () => {
    let llmCalled = false;
    const logged: string[] = [];
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ onCall: () => (llmCalled = true) }),
      log: (m) => logged.push(m),
    });
    const result = await client.session.prompt({
      path: { id: SESSION_ID },
      body: { noReply: true, parts: [{ type: "text", text: "wrapup started", ignored: true }] },
    });
    expect(result).toEqual({});
    expect(llmCalled).toBe(false);
    expect(logged.some((m) => m.includes("wrapup started"))).toBe(true);
  });

  it("times out through AbortSignal + race when the stream hangs", async () => {
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ hang: true }),
      timeoutMs: 20,
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    const promise = client.session.prompt({
      path: { id: "c" },
      body: { parts: [{ type: "text", text: "x" }] },
    });
    await expect(promise).rejects.toThrow("prompt timed out after 20ms");
  });

  it("propagates an external abort as 'prompt aborted by external signal'", async () => {
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ hang: true }),
      defaultRoute: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    });
    const controller = new AbortController();
    const promise = client.session.prompt({
      path: { id: "c" },
      body: { parts: [{ type: "text", text: "x" }] },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow("prompt aborted by external signal");
  });

  it("empty parts prompts are skipped without an LLM call", async () => {
    let llmCalled = false;
    const client = createDshSessionClient({
      ctx: {} as Context,
      db: noopDb,
      llm: stubLlm({ onCall: () => (llmCalled = true) }),
    });
    await expect(client.session.prompt({ path: { id: "c" }, body: { parts: [] } })).resolves.toEqual({});
    expect(llmCalled).toBe(false);
  });
});

/* ──────────────────────────── seam unit tests ─────────────────────────────── */

function okHost(db: Database): RecompHost {
  return {
    ready: Promise.resolve({ kind: "ok", db } as DshStorageBootstrap),
    canonicalKey: (id: string) => `dsh:test:${id}`,
  };
}

type RecompHost = { ready: Promise<DshStorageBootstrap>; canonicalKey(id: string): string };

interface CapturedRecomp {
  ctx: ManagedRecompContext;
  sessionId: string;
  options: { range?: { start: number; end: number } } | undefined;
}

describe("createRecompSeams", () => {
  it("runRecomp builds the managed context, registers the raw provider, and passes the message through", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      const session = buildSession();
      const agent = fakeAgent(session);
      let captured: CapturedRecomp | null = null;
      let rawCountInsideRun = -1;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runners: {
          recomp: async (ctx, sessionId, options) => {
            captured = { ctx, sessionId, options };
            rawCountInsideRun = readRawSessionMessages(sessionId).length;
            return "## Magic Recomp — Complete\n\nRebuilt from raw history.";
          },
        },
      });

      const result = await seams.runRecomp?.({
        agent,
        sessionId: SESSION_ID,
        cwd: "C:/proj",
        rawInput: "",
        signal: new AbortController().signal,
        db,
      });

      expect(result).toBe("## Magic Recomp — Complete\n\nRebuilt from raw history.");
      expect(captured).not.toBeNull();
      expect(captured?.sessionId).toBe(SESSION_ID);
      expect(captured?.options).toBeUndefined();
      expect(rawCountInsideRun).toBe(10); // the transcript provider was active
      const ctx = captured!.ctx;
      expect(ctx.db).toBe(db);
      expect(ctx.directory).toBe("C:/proj");
      expect(ctx.historianChunkTokens).toBe(16_000);
      expect(ctx.historianTimeoutMs).toBe(120_000);
      expect(ctx.memoryEnabled).toBe(true);
      expect(ctx.autoPromote).toBe(true);
      expect(ctx.fallbackModels).toEqual([]);
      expect(ctx.runMigration).toBe(true);
      expect(ctx.userMemoriesEnabled).toBe(false);
      expect(ctx.language).toBeUndefined();
      expect(ctx.historianTwoPass).toBeUndefined();
      expect(ctx.fallbackModelId).toBe("deepseek/deepseek-chat");
      const client = ctx.client as unknown as DshSessionClient;
      expect(typeof client.session.get).toBe("function");
      expect(typeof client.session.create).toBe("function");
      expect(typeof client.session.prompt).toBe("function");
      expect(typeof client.session.promptAsync).toBe("function");
      expect(typeof client.session.messages).toBe("function");
      expect(typeof client.session.delete).toBe("function");
      expect(typeof client.session.abort).toBe("function");
      expect(ctx.getNotificationParams(SESSION_ID)).toMatchObject({
        agent: DSH_SESSION_ID,
        providerId: "deepseek",
        modelId: "deepseek-chat",
      });
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runRecomp honors config overrides and forwards a partial range from rawInput", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      const session = buildSession();
      let captured: CapturedRecomp | null = null;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        historianChunkTokens: 8_000,
        historianTimeoutMs: 60_000,
        memoryEnabled: false,
        autoPromote: false,
        fallbackModels: ["anthropic/claude-sonnet-4-6"],
        language: "zh-CN",
        runMigration: false,
        userMemoriesEnabled: true,
        historianTwoPass: true,
        runners: {
          recomp: async (ctx, sessionId, options) => {
            captured = { ctx, sessionId, options };
            return "## Magic Recomp — Complete\n\nok";
          },
        },
      });

      const result = await seams.runRecomp?.({
        agent: fakeAgent(session),
        sessionId: SESSION_ID,
        rawInput: "3-7",
        signal: new AbortController().signal,
        db,
      });

      expect(result).toBe("## Magic Recomp — Complete\n\nok");
      expect(captured?.options?.range).toEqual({ start: 3, end: 7 });
      const ctx = captured!.ctx;
      expect(ctx.historianChunkTokens).toBe(8_000);
      expect(ctx.historianTimeoutMs).toBe(60_000);
      expect(ctx.memoryEnabled).toBe(false);
      expect(ctx.autoPromote).toBe(false);
      expect(ctx.fallbackModels).toEqual(["anthropic/claude-sonnet-4-6"]);
      expect(ctx.language).toBe("zh-CN");
      expect(ctx.runMigration).toBe(false);
      expect(ctx.userMemoriesEnabled).toBe(true);
      expect(ctx.historianTwoPass).toBe(true);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runRecomp returns error text for invalid args without calling the runner", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      let called = false;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runners: { recomp: async () => ((called = true), "unreachable") },
      });
      const result = await seams.runRecomp?.({
        agent: fakeAgent(buildSession()),
        sessionId: SESSION_ID,
        rawInput: "abc",
        signal: new AbortController().signal,
        db,
      });
      expect(result).toContain("## Magic Recomp — Failed");
      expect(result).toContain("Invalid /ctx-recomp arguments");
      expect(called).toBe(false);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runRecomp skips fast on an already-aborted signal and gates on the bootstrap", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      const agent = fakeAgent(buildSession());

      const aborted = new AbortController();
      aborted.abort();
      const seamsAborted = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runners: { recomp: async () => "unreachable" },
      });
      expect(
        await seamsAborted.runRecomp?.({
          agent,
          sessionId: SESSION_ID,
          rawInput: "",
          signal: aborted.signal,
          db,
        }),
      ).toContain("## Magic Recomp — Skipped");

      const seamsRefused = createRecompSeams({
        ctx: {} as Context,
        host: { ready: Promise.resolve({ kind: "refused", reason: "schema-fence", detail: "x" } as DshStorageBootstrap), canonicalKey: okHost(db).canonicalKey },
        db,
        runners: { recomp: async () => "unreachable" },
      });
      const refused = await seamsRefused.runRecomp?.({
        agent,
        sessionId: SESSION_ID,
        rawInput: "",
        signal: new AbortController().signal,
        db,
      });
      expect(refused).toContain("## Magic Recomp — Failed");
      expect(refused).toContain("schema-fence");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runWrapup forwards messagesToKeep and the wrapup context defaults", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      let captured: { ctx: ManagedWrapupContext; sessionId: string; messagesToKeep: number } | null = null;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runners: {
          wrapup: async (ctx, sessionId, options) => {
            captured = { ctx, sessionId, messagesToKeep: options.messagesToKeep };
            return "## Magic Wrapup — Complete\n\nwrapped";
          },
        },
      });
      const result = await seams.runWrapup?.({
        agent: fakeAgent(buildSession()),
        sessionId: SESSION_ID,
        cwd: "C:/proj",
        messagesToKeep: 12,
        signal: new AbortController().signal,
        db,
      });
      expect(result).toBe("## Magic Wrapup — Complete\n\nwrapped");
      expect(captured?.sessionId).toBe(SESSION_ID);
      expect(captured?.messagesToKeep).toBe(12);
      expect(captured?.ctx.contextLimit).toBe(128_000);
      expect(captured?.ctx.executeThresholdPercentage).toBe(65);
      expect(captured?.ctx.runCompartmentAgentForWrapup).toBeUndefined();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runUpgrade forwards the session and the managed context", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      let captured: { ctx: ManagedRecompContext; sessionId: string } | null = null;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runners: {
          upgrade: async (ctx, sessionId) => {
            captured = { ctx, sessionId };
            return "## Session Upgrade — Complete\n\nupgraded";
          },
        },
      });
      const result = await seams.runUpgrade?.({
        agent: fakeAgent(buildSession()),
        sessionId: SESSION_ID,
        cwd: "C:/proj",
        signal: new AbortController().signal,
        db,
      });
      expect(result).toBe("## Session Upgrade — Complete\n\nupgraded");
      expect(captured?.sessionId).toBe(SESSION_ID);
      expect(captured?.ctx.runMigration).toBe(true);
      expect(captured?.ctx.directory).toBe("C:/proj");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("links the invocation signal to the in-flight client prompt (abortFor)", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      const session = buildSession();
      const controller = new AbortController();
      let promptError: string | undefined;
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        llm: stubLlm({ hang: true }),
        runners: {
          recomp: async (ctx) => {
            const client = ctx.client as unknown as DshSessionClient;
            const created = await client.session.create({ body: { parentID: SESSION_ID, title: "t" } });
            try {
              await client.session.prompt({
                path: { id: created.id },
                body: { parts: [{ type: "text", text: "x" }] },
              });
            } catch (error) {
              promptError = error instanceof Error ? error.message : String(error);
            }
            return "done";
          },
        },
      });
      // Schedule the abort BEFORE awaiting the run (the run blocks on the
      // hanging prompt until the linked signal fires).
      setTimeout(() => controller.abort(), 20);
      const result = await seams.runRecomp?.({
        agent: fakeAgent(session),
        sessionId: SESSION_ID,
        cwd: "C:/proj",
        rawInput: "",
        signal: controller.signal,
        db,
      });
      expect(result).toBe("done");
      expect(promptError).toContain("prompt aborted by external signal");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("true-core wrapup: real runManagedWrapup with the compartment-agent runner stubbed", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      const session = buildSession();
      const view = viewOf(session);
      const idAt = new Map(view.messages.map((message) => [message.ordinal, String(message.id)]));
      const seams = createRecompSeams({
        ctx: {} as Context,
        host: okHost(db),
        db,
        runCompartmentAgentForWrapup: async (runnerDeps) => {
          const before = Math.max(1, getLastCompartmentEndMessage(db, SESSION_ID) + 1);
          const end = Math.min(
            (runnerDeps.boundarySnapshot?.eligibleEndOrdinal ?? before + 1) - 1,
            before + 10,
          );
          appendCompartments(db, SESSION_ID, [
            {
              sequence: getCompartments(db, SESSION_ID).length,
              startMessage: before,
              endMessage: end,
              startMessageId: idAt.get(before) ?? `m-${before}`,
              endMessageId: idAt.get(end) ?? `m-${end}`,
              title: `Wrapped ${before}-${end}`,
              content: `Wrapped ${before}-${end}`,
            },
          ]);
          runnerDeps.onCompartmentStatePublished?.(SESSION_ID);
        },
      });

      const result = await seams.runWrapup?.({
        agent: fakeAgent(session),
        sessionId: SESSION_ID,
        cwd: "C:/proj",
        messagesToKeep: 2,
        signal: new AbortController().signal,
        db,
      });

      // 10 raw messages, keep 2 → protected tail starts at 9 → wrap 1..8.
      expect(result).toContain("Wrapped up 8 messages into 1 compartment");
      expect(result).not.toContain("Failed");
      expect(result).not.toContain("Skipped");
      expect(getLastCompartmentEndMessage(db, SESSION_ID)).toBe(8);
      db.close();
    } finally {
      await env.cleanup();
    }
  });
});
