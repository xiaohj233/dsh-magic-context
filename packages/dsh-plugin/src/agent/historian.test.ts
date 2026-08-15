/**
 * agent/historian — slice H tests (bun test).
 *
 * Pattern mirrors transcript.test.ts / outbox.test.ts: real DSH session
 * (Session.create + append), core test DB via createTestDb (harness locked to
 * dsh), and WAL-EBUSY-safe cleanup with retry. All LLM calls are injected
 * stubs — no network.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  createAssistantMessage,
  createUserMessage,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { getDshCompactionMarker, initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";
import {
  applyDshCompactionMarkerIfCovered,
  checkDshCompartmentTrigger,
  consumeDshDeferredSignals,
  createMagicSummarizeHook,
  runDshHistorian,
  signalDshDeferredHistoryRefresh,
  signalDshDeferredMaterialization,
  stageDshCompactionMarker,
  type DshSummarizeCall,
  type HistorianDeps,
  type MagicSummarizeDeps,
} from "./historian";

const SESSION_ID = "dsh:a1b2c3d4:sess-historian";
const DSH_SESSION_ID = "sess-historian";

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
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-historian-"));
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
        message: createAssistantMessage({
          content: [{ type: "text", text: `answer ${turn}` }],
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

/** Transcript-backed RawMessageProvider for the session. */
function providerOf(session: Session): RawMessageProvider {
  const view = readDshTranscript({
    session: {
      events: session.events,
      surface: session.surface,
      header: {},
    },
    canonicalSessionId: SESSION_ID,
  });
  return { readMessages: () => view.messages };
}

/** A fingerprint-less boundary (skips staleness validation) that makes the
 *  whole session eligible: protectedTailStart = count + 1. */
function makeBoundary(
  messages: readonly { ordinal: number; id: string }[],
  extra?: Partial<ProtectedTailBoundarySnapshot>,
): ProtectedTailBoundarySnapshot {
  const count = messages.length;
  const idAt = (ordinal: number): string | null =>
    messages.find((m) => m.ordinal === ordinal)?.id ?? null;
  return {
    sessionId: SESSION_ID,
    mode: "incremental-runner",
    offset: 1,
    offsetMessageId: idAt(1),
    protectedTailStart: count + 1,
    protectedTailStartMessageId: null,
    eligibleEndOrdinal: count + 1,
    eligibleEndMessageId: idAt(count),
    rawMessageCountAtTrigger: count,
    rawLastMessageIdAtTrigger: idAt(count),
    N: 0,
    usagePercentage: 0,
    usageInputTokens: 0,
    usageSource: "provisional-zero",
    contextLimit: 128_000,
    executeThresholdPercentage: 65,
    triggerBudget: 10_000,
    priorBoundaryOrdinal: count + 1,
    migrationFloorActive: false,
    providerShapeVersion: "opencode-v1",
    cacheNamespace: `test:${SESSION_ID}`,
    createdAt: Date.now(),
    rawRangeFingerprint: "",
    trueRawEligibleTokens: 0,
    oversizeAtomicUnit: false,
    boundaryReason: "test",
    ...extra,
  };
}

/** Valid v2 historian XML (tiered compartments + promotable fact). */
function validHistorianXml(
  compartments: Array<{ start: number; end: number; title: string }>,
  unprocessedFrom: number,
): string {
  const body = compartments
    .map(
      (c) => `
<compartment start="${c.start}" end="${c.end}" title="${c.title}" episode_type="design" importance="50">
<p1>Narrative summary of ${c.start}-${c.end}.</p1>
<p2>Condensed ${c.start}-${c.end}.</p2>
<p3>Outcome ${c.start}-${c.end}.</p3>
<p4>Anchor ${c.start}-${c.end}.</p4>
</compartment>`,
    )
    .join("\n");
  return `<output>
<compartments>
${body}
</compartments>
<facts>
<ARCHITECTURE>
* Use the magic pattern.
</ARCHITECTURE>
</facts>
<meta>
<messages_processed>${compartments[0]!.start}-${compartments[compartments.length - 1]!.end}</messages_processed>
<unprocessed_from>${unprocessedFrom}</unprocessed_from>
</meta>
</output>`;
}

function historianDeps(
  db: Database,
  session: Session,
  overrides: Partial<HistorianDeps> = {},
): HistorianDeps {
  const messages = providerOf(session).readMessages();
  return {
    db,
    sessionId: SESSION_ID,
    directory: "C:/work/project",
    provider: providerOf(session),
    summarize: async () => "",
    boundarySnapshot: makeBoundary(messages),
    leaseHolderId: "lease-test",
    ...overrides,
  };
}

describe("checkDshCompartmentTrigger (pure percentage gate)", () => {
  it("fires at/above the proactive floor (threshold - 2)", () => {
    const inputs = { executeThresholdPercentage: 65, triggerBudget: 5000, contextLimit: 128_000 };
    expect(checkDshCompartmentTrigger(inputs, { lastContextPercentage: 63 })).toBe(true);
    expect(checkDshCompartmentTrigger(inputs, { lastContextPercentage: 80 })).toBe(true);
    expect(checkDshCompartmentTrigger(inputs, { lastContextPercentage: 62.9 })).toBe(false);
  });

  it("never fires without a percentage, a budget, or a finite threshold", () => {
    const inputs = { executeThresholdPercentage: 65, triggerBudget: 5000, contextLimit: 128_000 };
    expect(checkDshCompartmentTrigger(inputs, {})).toBe(false);
    expect(
      checkDshCompartmentTrigger({ ...inputs, triggerBudget: 0 }, { lastContextPercentage: 90 }),
    ).toBe(false);
    expect(
      checkDshCompartmentTrigger(
        { ...inputs, executeThresholdPercentage: Number.NaN },
        { lastContextPercentage: 62 },
      ),
    ).toBe(false); // NaN → default 65 → floor 63
    expect(
      checkDshCompartmentTrigger(
        { ...inputs, executeThresholdPercentage: Number.NaN },
        { lastContextPercentage: 64 },
      ),
    ).toBe(true);
    expect(
      checkDshCompartmentTrigger(inputs, { lastContextPercentage: Number.NaN }),
    ).toBe(false);
  });
});

describe("deferred signals (process-local)", () => {
  it("consumes once and clears", () => {
    expect(consumeDshDeferredSignals("sess-signals")).toEqual({
      historyRefresh: false,
      materialization: false,
    });
    signalDshDeferredHistoryRefresh("sess-signals");
    expect(consumeDshDeferredSignals("sess-signals")).toEqual({
      historyRefresh: true,
      materialization: false,
    });
    expect(consumeDshDeferredSignals("sess-signals")).toEqual({
      historyRefresh: false,
      materialization: false,
    });
    signalDshDeferredMaterialization("sess-signals");
    signalDshDeferredHistoryRefresh("sess-signals");
    expect(consumeDshDeferredSignals("sess-signals")).toEqual({
      historyRefresh: true,
      materialization: true,
    });
    expect(consumeDshDeferredSignals("sess-signals")).toEqual({
      historyRefresh: false,
      materialization: false,
    });
  });
});

describe("runDshHistorian", () => {
  it("publishes atomically: compartments + marker + onPublished + lease released + telemetry", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      let summarizeCalls = 0;
      let published = 0;
      const deps = historianDeps(db, session, {
        summarize: async () => {
          summarizeCalls += 1;
          return validHistorianXml(
            [
              { start: 1, end: 3, title: "intro" },
              { start: 4, end: 7, title: "work" },
            ],
            8,
          );
        },
        onPublished: () => {
          published += 1;
        },
      });

      const ok = await runDshHistorian(deps);
      expect(ok).toBe(true);
      expect(summarizeCalls).toBe(1);
      expect(published).toBe(1);

      // Compartments in the formal table (atomic publish, no staged state).
      const compartments = getCompartments(db, SESSION_ID);
      expect(compartments.map((c) => [c.startMessage, c.endMessage, c.sequence])).toEqual([
        [1, 3, 0],
        [4, 7, 1],
      ]);

      // Marker staged in the SAME transaction (adapter-owned table).
      const marker = getDshCompactionMarker(db, SESSION_ID);
      expect(marker).not.toBeNull();
      expect(marker?.ordinal).toBe(7);
      expect(marker?.tokensBefore).toBeGreaterThan(0);
      expect(marker?.summary).toContain("Magic Context compacted");
      expect(marker?.status).toBe("pending");

      // Facts promoted to project memory (directory provided).
      const memoryRows = db
        .query("SELECT COUNT(*) AS n FROM memories WHERE source_session_id = ?")
        .get(SESSION_ID) as { n: number };
      expect(memoryRows.n).toBe(1);

      // Lease released (a fresh probe acquisition succeeds immediately).
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();

      // Telemetry row recorded with success.
      const run = db
        .query(
          "SELECT status, compartments_produced, discarded_last FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(SESSION_ID) as { status: string; compartments_produced: number; discarded_last: number };
      expect(run.status).toBe("success");
      expect(run.compartments_produced).toBe(2);
      expect(run.discarded_last).toBe(0);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("validation failure: nothing published, nothing staged, no exception, lease released", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      const notified: string[] = [];
      const ok = await runDshHistorian(
        historianDeps(db, session, {
          summarize: async () => "<output><compartments></compartments></output>",
          notifyIssue: (message) => notified.push(message),
        }),
      );
      expect(ok).toBe(false);
      expect(getCompartments(db, SESSION_ID)).toHaveLength(0);
      expect(getDshCompactionMarker(db, SESSION_ID)).toBeNull();
      expect(notified.length).toBe(1); // transient failure notice
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();
      const run = db
        .query(
          "SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(SESSION_ID) as { status: string; failure_reason: string | null };
      expect(run.status).toBe("failed");
      expect(run.failure_reason).toContain("no usable compartments");
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("LLM failure: no throw, no publish, no marker", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      const ok = await runDshHistorian(
        historianDeps(db, session, {
          summarize: async () => {
            throw new Error("provider timeout");
          },
        }),
      );
      expect(ok).toBe(false);
      expect(getCompartments(db, SESSION_ID)).toHaveLength(0);
      expect(getDshCompactionMarker(db, SESSION_ID)).toBeNull();
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("lease busy: returns false without calling the LLM", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      acquireCompartmentLease(db, SESSION_ID, "other-runner");
      let summarizeCalls = 0;
      const ok = await runDshHistorian(
        historianDeps(db, session, {
          summarize: async () => {
            summarizeCalls += 1;
            return validHistorianXml([{ start: 1, end: 3, title: "intro" }], 4);
          },
        }),
      );
      expect(ok).toBe(false);
      expect(summarizeCalls).toBe(0);
      expect(getCompartments(db, SESSION_ID)).toHaveLength(0);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("atomicity: a mid-publish failure rolls back the whole transaction", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      const view = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: {} },
        canonicalSessionId: SESSION_ID,
      });
      // Call 1 serves readSessionChunk; call 2 (inside queueDropsForCompartmentalizedMessages,
      // i.e. INSIDE the publish transaction) throws → everything must roll back.
      let reads = 0;
      const failingProvider: RawMessageProvider = {
        readMessages: () => {
          reads += 1;
          if (reads === 2) throw new Error("inject: provider read failed mid-publish");
          return view.messages;
        },
      };
      const ok = await runDshHistorian(
        historianDeps(db, session, {
          provider: failingProvider,
          summarize: async () =>
            validHistorianXml(
              [
                { start: 1, end: 3, title: "intro" },
                { start: 4, end: 7, title: "work" },
              ],
              8,
            ),
        }),
      );
      expect(ok).toBe(false);
      expect(getCompartments(db, SESSION_ID)).toHaveLength(0); // no half-commit
      expect(getDshCompactionMarker(db, SESSION_ID)).toBeNull();
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("discard-last boundary healing drops the provisional final compartment", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      // Greedy consume: the last compartment ends exactly at the chunk end
      // (lookaheadMargin 0 <= 2) → discarded; re-derived on the next run.
      const ok = await runDshHistorian(
        historianDeps(db, session, {
          summarize: async () =>
            validHistorianXml(
              [
                { start: 1, end: 5, title: "part-a" },
                { start: 6, end: 10, title: "part-b" },
              ],
              11,
            ),
        }),
      );
      expect(ok).toBe(true);
      const compartments = getCompartments(db, SESSION_ID);
      expect(compartments.map((c) => [c.startMessage, c.endMessage])).toEqual([[1, 5]]);
      expect(getDshCompactionMarker(db, SESSION_ID)?.ordinal).toBe(5);
      const run = db
        .query("SELECT discarded_last FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(SESSION_ID) as { discarded_last: number };
      expect(run.discarded_last).toBe(1);
      db.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe("applyDshCompactionMarkerIfCovered (rendered-coverage gate)", () => {
  it("is stale when no marker exists or it is already applied", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const appendCalls: unknown[] = [];
      expect(
        applyDshCompactionMarkerIfCovered({
          db,
          sessionId: SESSION_ID,
          readBoundary: () => true,
          appendCompaction: (...args) => appendCalls.push(args),
        }),
      ).toBe("stale");
      stageDshCompactionMarker(db, SESSION_ID, {
        ordinal: 7,
        endMessageId: "m7",
        tokensBefore: 123,
        summary: "s",
      });
      db.prepare(
        "UPDATE dsh_context_compaction_marker SET status = 'applied' WHERE session_id = ?",
      ).run(SESSION_ID);
      expect(
        applyDshCompactionMarkerIfCovered({
          db,
          sessionId: SESSION_ID,
          readBoundary: () => true,
          appendCompaction: (...args) => appendCalls.push(args),
        }),
      ).toBe("stale");
      expect(appendCalls).toHaveLength(0);
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("defers while the pass has not rendered through the marker ordinal", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      stageDshCompactionMarker(db, SESSION_ID, {
        ordinal: 7,
        endMessageId: "m7",
        tokensBefore: 123,
        summary: "s",
      });
      const appendCalls: unknown[] = [];
      const outcome = applyDshCompactionMarkerIfCovered({
        db,
        sessionId: SESSION_ID,
        readBoundary: (ordinal) => ordinal < 7,
        appendCompaction: (...args) => appendCalls.push(args),
      });
      expect(outcome).toBe("deferred");
      expect(appendCalls).toHaveLength(0);
      expect(getDshCompactionMarker(db, SESSION_ID)).not.toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("applies when covered: appendCompaction(summary, firstKeptOrdinal, tokensBefore) + CAS clear", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      stageDshCompactionMarker(db, SESSION_ID, {
        ordinal: 7,
        endMessageId: "m7",
        tokensBefore: 123,
        summary: "Magic Context compacted: intro",
      });
      const appendCalls: Array<[string, number, number]> = [];
      const outcome = applyDshCompactionMarkerIfCovered({
        db,
        sessionId: SESSION_ID,
        readBoundary: (ordinal) => ordinal >= 7,
        appendCompaction: (summary, firstKeptOrdinal, tokensBefore) => {
          appendCalls.push([summary, firstKeptOrdinal, tokensBefore]);
        },
      });
      expect(outcome).toBe("applied");
      expect(appendCalls).toEqual([["Magic Context compacted: intro", 8, 123]]);
      expect(getDshCompactionMarker(db, SESSION_ID)).toBeNull(); // CAS-cleared
      db.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe("createMagicSummarizeHook (Magic 压缩策略)", () => {
  function hookDeps(
    db: Database,
    session: Session,
    summarize: DshSummarizeCall,
  ): MagicSummarizeDeps {
    return {
      db,
      sessionId: SESSION_ID,
      ctx: {},
      provider: providerOf(session),
      summarize,
      directory: "C:/work/project",
      leaseHolderId: "lease-hook",
    };
  }

  function inputMessages(session: Session): unknown[] {
    const messages = providerOf(session).readMessages();
    return messages.map((m) => ({ id: m.id, role: m.role, content: [] }));
  }

  const fakeAgent = {
    options: { provider: "test-provider", model: "test-model" },
  } as unknown as Agent;

  it("fully covered: renders the compartment block without calling the LLM", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      const view = providerOf(session).readMessages();
      // Stage pre-existing compartments covering 1..10 directly.
      appendCompartments(db, SESSION_ID, [
        {
          sequence: 0,
          startMessage: 1,
          endMessage: 5,
          startMessageId: view[0]!.id,
          endMessageId: view[4]!.id,
          title: "intro",
          content: "Narrative summary of 1-5.",
          p1: "Narrative summary of 1-5.",
          p2: "Condensed 1-5.",
          p3: "Outcome 1-5.",
          p4: "Anchor 1-5.",
          importance: 50,
          episodeType: "design",
        },
        {
          sequence: 1,
          startMessage: 6,
          endMessage: 10,
          startMessageId: view[5]!.id,
          endMessageId: view[9]!.id,
          title: "work",
          content: "Narrative summary of 6-10.",
          p1: "Narrative summary of 6-10.",
          p2: "Condensed 6-10.",
          p3: "Outcome 6-10.",
          p4: "Anchor 6-10.",
          importance: 40,
          episodeType: "design",
        },
      ]);
      let summarizeCalls = 0;
      const hook = createMagicSummarizeHook(
        hookDeps(db, session, async () => {
          summarizeCalls += 1;
          return "";
        }),
      );
      const result = await hook(
        { messages: inputMessages(session) as never },
        fakeAgent,
      );
      expect(summarizeCalls).toBe(0);
      expect(result.provider).toBe("test-provider");
      expect(result.model).toBe("test-model");
      const text = result.summary[0]!.text;
      expect(text).toContain("Narrative summary of 1-5.");
      expect(text).toContain("Narrative summary of 6-10.");
      expect(text).toContain('start="1" end="5"');
      expect(result.rawOutput).toBeUndefined();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("incomplete coverage: runs one synchronous mini-historian then re-renders", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      let summarizeCalls = 0;
      const hook = createMagicSummarizeHook(
        hookDeps(db, session, async () => {
          summarizeCalls += 1;
          return validHistorianXml(
            [
              { start: 1, end: 3, title: "intro" },
              { start: 4, end: 7, title: "work" },
              { start: 8, end: 10, title: "wrap" },
            ],
            11,
          );
        }),
      );
      const result = await hook({ messages: inputMessages(session) as never }, fakeAgent);
      expect(summarizeCalls).toBe(1);
      // Mini-historian published atomically (keep-last: 3 compartments).
      const compartments = getCompartments(db, SESSION_ID);
      expect(compartments).toHaveLength(3);
      expect(compartments[2]!.endMessage).toBe(10);
      // Marker staged with the mini-publish.
      expect(getDshCompactionMarker(db, SESSION_ID)?.ordinal).toBe(10);
      // Summary now covers the full range.
      const text = result.summary[0]!.text;
      expect(text).toContain("Narrative summary of 1-3.");
      expect(text).toContain("Narrative summary of 8-10.");
      expect(result.rawOutput).toBeDefined();
      expect(result.rawOutput?.[0]?.text).toContain("<compartment");
      // Mini-historian released its lease.
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });

  it("LLM failure: the hook throws (fail-closed) and releases the lease", async () => {
    const env = makeEnv();
    try {
      const db = await createTestDb(env.dbPath);
      initializeDshAdapterTables(db);
      const session = buildSession();
      const hook = createMagicSummarizeHook(
        hookDeps(db, session, async () => {
          throw new Error("provider 429");
        }),
      );
      await expect(
        hook({ messages: inputMessages(session) as never }, fakeAgent),
      ).rejects.toThrow(/mini-historian failed: llm call failed/);
      expect(getCompartments(db, SESSION_ID)).toHaveLength(0);
      expect(acquireCompartmentLease(db, SESSION_ID, "lease-probe")).not.toBeNull();
      db.close();
    } finally {
      await env.cleanup();
    }
  });
});
