import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createUserMessage,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readDshTranscript, deriveMutationPlan, type MutationPlan } from "./transcript";
import {
  applyPlanOps,
  createCoordinatorState,
  enqueuePlan,
  type CoordinatorHostView,
} from "./coordinator";
import { getOutboxRecord, initializeDshAdapterTables } from "./outbox";

const CANONICAL = "dsh:a1b2c3d4:sess-coord";

function buildSession(): Session {
  const session = Session.create(SessionId("sess-coord"));
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
        content: [{ type: "text", text: "hi there" }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: "again" }], source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  return session;
}

function makeHost(db: Database): CoordinatorHostView {
  return {
    db,
    canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
    log: () => {},
  };
}

function viewOf(session: Session) {
  return readDshTranscript({
    session: { events: session.events, surface: session.surface, header: {} },
    canonicalSessionId: CANONICAL,
  });
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

describe("SurfaceMutationCoordinator (CAS + saga)", () => {
  it("applies a plan through the official surface transaction and commits the saga", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const view = viewOf(session);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      const nodesBefore = [...session.surface.nodes];

      const outcome = await enqueuePlan(createCoordinatorState(), host, session, plan);
      expect(outcome.status).toBe("applied");
      if (outcome.status === "applied") {
        expect(outcome.ackSeq).toBeGreaterThan(nodesBefore[nodesBefore.length - 1]!);
      }
      // The surface moved: a replacement per op landed (generation bumped).
      expect(session.surface.replaceGeneration).toBe(plan.ops.length);
      // The outbox record is committed with the ack seq.
      const record = getOutboxRecord(db, plan.opId);
      expect(record?.status).toBe("committed");
      expect(record?.ackSeq).not.toBeNull();
      expect(record?.sessionId).toBe(CANONICAL);
      expect(record?.inputDigest).toBe(plan.inputDigest);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("rejects a replayed plan as already-applied (opId CAS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const plan = deriveMutationPlan(viewOf(session), { db, protectedTags: 0 })!;

      const state = createCoordinatorState();
      const first = await enqueuePlan(state, host, session, plan);
      expect(first.status).toBe("applied");
      const second = await enqueuePlan(state, host, session, plan);
      expect(second.status).toBe("already-applied");

      // Restart simulation: a fresh state still sees the committed outbox row.
      const restarted = await enqueuePlan(createCoordinatorState(), host, session, plan);
      expect(restarted.status).toBe("already-applied");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("rejects a stale plan when the session moved on (input digest CAS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const plan = deriveMutationPlan(viewOf(session), { db, protectedTags: 0 })!;

      // The session grows before the plan lands → stale input.
      session.append(
        "user/message",
        createUserMessage({ content: [{ type: "text", text: "late arrival" }], source: { kind: "user" } }),
        { surfaceOp: "append" },
      );
      const outcome = await enqueuePlan(createCoordinatorState(), host, session, plan);
      expect(outcome.status).toBe("stale-input");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("rejects a plan whose surface generation moved on (generation CAS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const plan = deriveMutationPlan(viewOf(session), { db, protectedTags: 0 })!;

      // Manually land a replacement first: generation bumps, digest changes.
      const nodes = [...session.surface.nodes];
      const mid = nodes[1]!;
      session.append(
        "user/message",
        createUserMessage({ content: [{ type: "text", text: "replacement" }], source: { kind: "user" } }),
        { surfaceOp: { op: "replace", start: mid, end: mid }, sourceEventSeqs: [mid] },
      );
      expect(session.surface.replaceGeneration).toBe(1);
      const outcome = await enqueuePlan(createCoordinatorState(), host, session, plan);
      expect(outcome.status).toBe("generation-mismatch");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("fails closed on an invalid op (official validation) and abandons the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const view = viewOf(session);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      // Corrupt the plan: shadowedSeqs no longer covers the replaced node.
      const broken: MutationPlan = {
        ...plan,
        opId: "op-broken",
        ops: plan.ops.map((op) => ({ ...op, shadowedSeqs: [] })),
      };
      const outcome = await enqueuePlan(createCoordinatorState(), host, session, broken);
      expect(outcome.status).toBe("error");
      if (outcome.status === "error") {
        expect(outcome.detail.length).toBeGreaterThan(0);
      }
      const record = getOutboxRecord(db, "op-broken");
      expect(record?.status).toBe("abandoned");
      expect(record?.errorDetail).toBeTruthy();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("serializes concurrent plans per session (second sees the first's effects)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const planA = deriveMutationPlan(viewOf(session), { db, protectedTags: 0 })!;
      // A second plan derived from the same (pre-apply) view.
      const planB: MutationPlan = { ...planA, opId: "op-b" };

      const state = createCoordinatorState();
      const [outA, outB] = await Promise.all([
        enqueuePlan(state, host, session, planA),
        enqueuePlan(state, host, session, planB),
      ]);
      expect(outA.status).toBe("applied");
      // planB's digest was derived pre-apply → the serialized CAS rejects it.
      expect(outB.status === "stale-input" || outB.status === "generation-mismatch").toBe(true);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("applyPlanOps merges temporal insertion ops into the adjacent node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-coord-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const session = buildSession();
      const host = makeHost(db);
      const view = viewOf(session);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      // Craft an insertion op (empty shadowedSeqs) at node 0.
      const inserted: MutationPlan = {
        ...plan,
        opId: "op-temporal",
        ops: [
          {
            kind: "temporal",
            start: 0,
            end: 0,
            replacement: "<!-- +5m -->",
            cacheClass: "soft-plus",
            reason: "temporal gap",
            shadowedSeqs: [],
          },
        ],
      };
      const outcome = await enqueuePlan(createCoordinatorState(), host, session, inserted);
      expect(outcome.status).toBe("applied");
      const nodes = [...session.surface.nodes];
      // The merged node is a user message carrying the marker + the old text.
      const mergedSeq = nodes[0]!;
      const message = session.events[mergedSeq];
      expect(message.type).toBe("user/message");
      const text = JSON.stringify(message.data);
      expect(text).toContain("<!-- +5m -->");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("applyPlanOps rejects out-of-range ops before touching the surface", () => {
    const session = buildSession();
    const db = { prepare: () => ({ run: () => ({ changes: 0 }) }) } as unknown as Database;
    const plan: MutationPlan = {
      opId: "op-range",
      sessionId: CANONICAL,
      sourceWatermark: 0,
      inputDigest: "x",
      generation: 0,
      ops: [
        {
          kind: "drops",
          start: 99,
          end: 100,
          replacement: "x",
          cacheClass: "soft",
          reason: "test",
          shadowedSeqs: [1],
        },
      ],
    };
    expect(() => applyPlanOps({ db, canonicalKey: (id) => id }, session, plan)).toThrow(
      /outside the live surface/,
    );
  });
});
