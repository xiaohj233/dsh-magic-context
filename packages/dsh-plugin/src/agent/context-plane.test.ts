import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createUserMessage,
} from "../compat/dsh-0.1/session";
import type { PreStepDecision } from "../compat/dsh-0.1/prestep";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  createContextPlaneState,
  runContextPlaneStep,
  type ContextPlaneDeps,
} from "./context-plane";
import { listOutboxBySession } from "./outbox";

function buildSession(): Session {
  const session = Session.create(SessionId("sess-plane"));
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: "text", text: "hi" }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      }),
    },
    { surfaceOp: "append" },
  );
  return session;
}

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

describe("context plane (pre-step wiring of transcript + coordinator)", () => {
  it("reconciles the outbox and applies the derived plan on the first step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-plane-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const agent = {
        id: session.id,
        session,
      };
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: { protectedTags: 0 },
        log: () => {},
      };

      const state = createContextPlaneState();
      let downstream = 0;
      const decision: PreStepDecision = { reject: false, messages: [] };
      const result = await runContextPlaneStep(
        state,
        deps,
        { agent: agent as never },
        async () => {
          downstream += 1;
          return decision;
        },
      );
      expect(result).toBe(decision);
      expect(downstream).toBe(1);
      // The first pass tagged the messages: ops applied to the surface.
      expect(session.surface.replaceGeneration).toBeGreaterThan(0);
      // The saga records committed.
      const records = listOutboxBySession(db, "dsh:a1b2c3d4:sess-plane");
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.status === "committed")).toBe(true);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("is fail-open: a broken host bootstrap still passes the step through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-plane-"));
    try {
      const session = buildSession();
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({
            kind: "refused",
            reason: "schema-fence",
            detail: "newer schema",
          }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: { enabled: true },
        log: () => {},
      };
      const state = createContextPlaneState();
      let downstream = 0;
      const result = await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session } as never },
        async () => {
          downstream += 1;
          return { reject: false, messages: [] };
        },
      );
      expect(result).toEqual({ reject: false, messages: [] });
      expect(downstream).toBe(1);
      expect(session.surface.replaceGeneration).toBe(0);
    } finally {
      await cleanupDir(dir);
    }
  });

  it("does not derive plans when disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-plane-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: { enabled: false },
        log: () => {},
      };
      await runContextPlaneStep(
        createContextPlaneState(),
        deps,
        { agent: { id: session.id, session } as never },
        async () => ({ reject: false, messages: [] }),
      );
      expect(session.surface.replaceGeneration).toBe(0);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("fires the historian pass when the context pressure crosses the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-plane-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const fired: Array<{ sessionId: string; provider: boolean }> = [];
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: { enabled: false }, // no plan derivation — trigger only
        directory: dir,
        historian: {
          config: { enabled: true, executeThresholdPercentage: 65, triggerBudgetTokens: 1000 },
          readPressure: () => ({ projectedTokens: 90_000, contextWindow: 128_000 }), // 70% ≥ 63% floor
          fire: ({ sessionId, provider }) => {
            fired.push({ sessionId, provider: provider !== undefined });
          },
        },
        log: () => {},
      };
      await runContextPlaneStep(
        createContextPlaneState(),
        deps,
        { agent: { id: session.id, session } as never },
        async () => ({ reject: false, messages: [] }),
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]?.sessionId).toBe("dsh:a1b2c3d4:sess-plane");
      expect(fired[0]?.provider).toBe(true);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("does not fire the historian pass below the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-plane-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      let fired = 0;
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: { enabled: false },
        historian: {
          config: { enabled: true, executeThresholdPercentage: 65, triggerBudgetTokens: 1000 },
          readPressure: () => ({ projectedTokens: 30_000, contextWindow: 128_000 }), // 23% < floor
          fire: () => {
            fired += 1;
          },
        },
        log: () => {},
      };
      await runContextPlaneStep(
        createContextPlaneState(),
        deps,
        { agent: { id: session.id, session } as never },
        async () => ({ reject: false, messages: [] }),
      );
      expect(fired).toBe(0);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});
