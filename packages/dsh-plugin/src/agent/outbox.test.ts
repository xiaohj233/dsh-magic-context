import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import {
  ADAPTER_META_KEY,
  ADAPTER_SCHEMA_VERSION,
  classifyOutboxRecord,
  clearDshCompactionMarkerIf,
  getDshCompactionMarker,
  getOutboxRecord,
  initializeDshAdapterTables,
  insertOutboxPending,
  listOutboxBySession,
  markOutboxAbandoned,
  markOutboxApplied,
  markOutboxCommitted,
  reconcileSessionOutbox,
  stageDshCompactionMarker,
  type DshSessionLogView,
  type OutboxPendingInput,
  type OutboxRecord,
} from "./outbox";

async function cleanupDir(dir: string): Promise<void> {
  // Windows WAL: the DB handle's close is not immediately reflected in file
  // locks; retry like the doctor suite does.
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
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-outbox-"));
  return { dbPath: join(dir, "context.db"), cleanup: () => cleanupDir(dir) };
}

function pendingInput(overrides: Partial<OutboxPendingInput> = {}): OutboxPendingInput {
  return {
    opId: "op-1",
    sessionId: "dsh:abc123:s1",
    kind: "drops",
    sourceWatermark: 42,
    inputDigest: "d1234567890abcdef",
    generation: 3,
    ...overrides,
  };
}

describe("dsh outbox (saga records + recovery)", () => {
  it("initializes the adapter tables idempotently and records the schema version", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      initializeDshAdapterTables(db); // idempotent
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dsh_%' ORDER BY name")
        .all()
        .map((r) => r.name as string);
      expect(tables).toEqual([
        "dsh_adapter_meta",
        "dsh_context_compaction_marker",
        "dsh_context_outbox",
        "dsh_feedback_signals",
      ]);
      const meta = db.query("SELECT value FROM dsh_adapter_meta WHERE key = ?").get(ADAPTER_META_KEY) as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(ADAPTER_SCHEMA_VERSION);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("inserts pending records idempotently and walks the status machine", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const input = pendingInput();
      insertOutboxPending(db, input);
      insertOutboxPending(db, input); // INSERT OR IGNORE — same opId is a no-op
      let record = getOutboxRecord(db, input.opId);
      expect(record).toBeDefined();
      expect(record?.status).toBe("pending");
      expect(record?.ackSeq).toBeNull();
      expect(record?.sourceWatermark).toBe(42);

      markOutboxApplied(db, input.opId, 100);
      record = getOutboxRecord(db, input.opId);
      expect(record?.status).toBe("applied");
      expect(record?.ackSeq).toBe(100);

      markOutboxCommitted(db, input.opId);
      record = getOutboxRecord(db, input.opId);
      expect(record?.status).toBe("committed");

      const listed = listOutboxBySession(db, input.sessionId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.opId).toBe(input.opId);
      expect(listOutboxBySession(db, input.sessionId, ["pending"])).toHaveLength(0);
      expect(listOutboxBySession(db, input.sessionId, ["committed"])).toHaveLength(1);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("marks abandoned with an error detail", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const input = pendingInput();
      insertOutboxPending(db, input);
      markOutboxAbandoned(db, input.opId, "surface replace rejected: range invalid");
      const record = getOutboxRecord(db, input.opId);
      expect(record?.status).toBe("abandoned");
      expect(record?.errorDetail).toContain("range invalid");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  describe("classifyOutboxRecord (four-way deterministic reconciliation)", () => {
    const record: OutboxRecord = {
      opId: "op-1",
      sessionId: "dsh:abc123:s1",
      kind: "drops",
      sourceWatermark: 10,
      inputDigest: "digest",
      generation: 3,
      status: "pending",
      ackSeq: null,
      errorDetail: null,
      createdAt: 0,
      updatedAt: 0,
    };

    it("committed records stay committed", () => {
      const log: DshSessionLogView = { hasSeq: () => false, generation: 0 };
      expect(classifyOutboxRecord({ ...record, status: "committed" }, log)).toBe("committed");
    });

    it("abandoned records classify as stale-input", () => {
      const log: DshSessionLogView = { hasSeq: () => false, generation: 0 };
      expect(classifyOutboxRecord({ ...record, status: "abandoned" }, log)).toBe("stale-input");
    });

    it("ack seq present in the log → committed (crash after DSH append, before SQLite commit)", () => {
      const log: DshSessionLogView = { hasSeq: (seq) => seq === 100, generation: 3 };
      expect(
        classifyOutboxRecord({ ...record, status: "applied", ackSeq: 100 }, log),
      ).toBe("committed");
    });

    it("no ack + generation unchanged → retryable (crash before the DSH append)", () => {
      const log: DshSessionLogView = { hasSeq: () => false, generation: 3 };
      expect(classifyOutboxRecord(record, log)).toBe("retryable");
    });

    it("no ack + generation advanced → stale-input", () => {
      const log: DshSessionLogView = { hasSeq: () => false, generation: 4 };
      expect(classifyOutboxRecord(record, log)).toBe("stale-input");
    });

    it("digest mismatch flagged by the caller → conflict-recompute", () => {
      const log: DshSessionLogView = { hasSeq: () => false, generation: 3 };
      expect(classifyOutboxRecord(record, log, { digestMismatch: true })).toBe(
        "conflict-recompute",
      );
    });

    it("crash-set convergence: every intermediate state settles to the uninterrupted outcome", () => {
      // Uninterrupted: pending → (DSH append, ack=100) → applied → committed.
      // Crash points: before insert (no record), after insert (pending), after
      // append (applied), after commit (committed). Each must classify to the
      // same final outcome when reconciled against the log that actually ran.
      const fullLog: DshSessionLogView = { hasSeq: (seq) => seq === 100, generation: 3 };
      expect(classifyOutboxRecord({ ...record, status: "pending" }, fullLog)).toBe("retryable");
      expect(
        classifyOutboxRecord({ ...record, status: "applied", ackSeq: 100 }, fullLog),
      ).toBe("committed");
      expect(
        classifyOutboxRecord({ ...record, status: "committed", ackSeq: 100 }, fullLog),
      ).toBe("committed");
      // The other crash direction: the append never happened.
      const noAppendLog: DshSessionLogView = { hasSeq: () => false, generation: 3 };
      expect(classifyOutboxRecord({ ...record, status: "pending" }, noAppendLog)).toBe(
        "retryable",
      );
    });
  });

  it("reconcileSessionOutbox commits/applies terminal classifications", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const sessionId = "dsh:abc123:s1";
      insertOutboxPending(db, pendingInput({ opId: "op-ack", sessionId, generation: 3 }));
      insertOutboxPending(db, pendingInput({ opId: "op-stale", sessionId, generation: 3 }));
      insertOutboxPending(db, pendingInput({ opId: "op-retry", sessionId, generation: 3 }));
      markOutboxApplied(db, "op-ack", 100);

      const log: DshSessionLogView = { hasSeq: (seq) => seq === 100, generation: 4 };
      const outcomes = reconcileSessionOutbox(db, sessionId, log);
      expect(outcomes["op-ack"]).toBe("committed");
      expect(outcomes["op-stale"]).toBe("stale-input");
      expect(outcomes["op-retry"]).toBe("stale-input"); // generation advanced
      expect(getOutboxRecord(db, "op-ack")?.status).toBe("committed");
      expect(getOutboxRecord(db, "op-stale")?.status).toBe("abandoned");

      // Generation unchanged → retryable stays pending for a later retry.
      insertOutboxPending(db, pendingInput({ opId: "op-retry2", sessionId, generation: 4 }));
      const outcomes2 = reconcileSessionOutbox(
        db,
        sessionId,
        { hasSeq: () => false, generation: 4 },
      );
      expect(outcomes2["op-retry2"]).toBe("retryable");
      expect(getOutboxRecord(db, "op-retry2")?.status).toBe("pending");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("compaction marker: stage → read → CAS clear", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      stageDshCompactionMarker(db, "s1", {
        ordinal: 40,
        endMessageId: "seq-40",
        tokensBefore: 1234,
        summary: "compartment digest",
      });
      const marker = getDshCompactionMarker(db, "s1");
      expect(marker?.ordinal).toBe(40);
      expect(marker?.status).toBe("pending");
      // CAS mismatch: nothing cleared.
      expect(clearDshCompactionMarkerIf(db, "s1", { ordinal: 41, endMessageId: "seq-40" })).toBe(false);
      expect(getDshCompactionMarker(db, "s1")).not.toBeNull();
      // Exact match clears.
      expect(clearDshCompactionMarkerIf(db, "s1", { ordinal: 40, endMessageId: "seq-40" })).toBe(true);
      expect(getDshCompactionMarker(db, "s1")).toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });
});
