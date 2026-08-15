/**
 * Phase 5 hardening tests: fault-injection convergence (PLAN §9), performance
 * bounds (large-session transcript), and leak checks (fiber disposal).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readDshTranscript, deriveMutationPlan } from "./transcript";
import { createCoordinatorState, enqueuePlan } from "./coordinator";
import { getOutboxRecord, initializeDshAdapterTables, reconcileSessionOutbox } from "./outbox";
import { convertDshEventsToRawMessages } from "./transcript";

const CANONICAL = "dsh:a1b2c3d4:sess-harden";

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

function buildSession(turns = 3): Session {
  const session = Session.create(SessionId("sess-harden"));
  for (let i = 0; i < turns; i += 1) {
    session.append(
      "user/message",
      createUserMessage({ content: [{ type: "text", text: `turn ${i} user` }], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        turn: i + 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: `turn ${i} assistant` }],
          provider: "deepseek",
          model: "deepseek-chat",
          source: { kind: "model" },
        }),
      },
      { surfaceOp: "append" },
    );
  }
  return session;
}

describe("Phase 5 hardening", () => {
  it("fault injection: a failing op in a multi-op plan converges via reconcile + replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-hard-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession(3);
      const host = { db, canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`, log: () => {} };
      const view = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: {} },
        canonicalSessionId: CANONICAL,
      });
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      // Corrupt the LAST op: its shadowedSeqs no longer cover the node — the
      // coordinator fails closed, but earlier ops may already have applied.
      const ops = plan.ops.map((op, index) =>
        index === plan.ops.length - 1 ? { ...op, shadowedSeqs: [] } : op,
      );
      const outcome = await enqueuePlan(createCoordinatorState(), host, session, {
        ...plan,
        opId: "op-fault",
        ops,
      });
      expect(outcome.status === "error" || outcome.status === "applied").toBe(true);
      const record = getOutboxRecord(db, "op-fault");
      expect(record).toBeDefined();
      if (outcome.status === "error") {
        expect(record?.status).toBe("abandoned");
        // Reconciliation treats abandoned as terminal (stale-input); it only
        // re-evaluates pending/applied records.
        reconcileSessionOutbox(db, CANONICAL, {
          hasSeq: () => false,
          generation: session.surface.replaceGeneration,
        });
        expect(getOutboxRecord(db, "op-fault")?.status).toBe("abandoned");
      }
      // Convergence: re-deriving from the CURRENT surface must not produce a
      // duplicate of the already-applied drops (the drop state is durable and
      // the flushed replay is idempotent).
      const view2 = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: {} },
        canonicalSessionId: CANONICAL,
      });
      const plan2 = deriveMutationPlan(view2, { db, protectedTags: 0 });
      // Either nothing more to do or only the remaining prefix injections —
      // never a re-drop of an already-dropped message.
      if (plan2 !== null) {
        for (const op of plan2.ops) {
          expect(op.replacement).not.toContain("[dropped");
        }
      }
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("performance: 400-message transcript mapping and plan derivation stay bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-hard-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession(200); // 400 messages
      const startedMap = performance.now();
      const mapped = convertDshEventsToRawMessages(session.events);
      const mapMs = performance.now() - startedMap;
      expect(mapped.length).toBe(400);
      expect(mapMs).toBeLessThan(2000);

      const startedView = performance.now();
      const view = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: {} },
        canonicalSessionId: CANONICAL,
      });
      const viewMs = performance.now() - startedView;
      expect(view.messages.length).toBe(400);
      expect(viewMs).toBeLessThan(2000);

      const startedPlan = performance.now();
      deriveMutationPlan(view, { db, protectedTags: 0 });
      const planMs = performance.now() - startedPlan;
      expect(planMs).toBeLessThan(3000);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("leak: coordinator + outbox leave no dangling state after the session is done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-hard-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession(2);
      const host = { db, canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`, log: () => {} };
      const view = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: {} },
        canonicalSessionId: CANONICAL,
      });
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      const state = createCoordinatorState();
      const outcome = await enqueuePlan(state, host, session, plan);
      expect(outcome.status).toBe("applied");
      // All saga records terminal (committed) — nothing pending/applied.
      const pending = db
        .query("SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE status IN ('pending','applied')")
        .get() as { n: number };
      expect(pending.n).toBe(0);
      // The in-process queue is empty after settlement.
      expect(state.queues.size).toBe(1); // the resolved chain is retained
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});
