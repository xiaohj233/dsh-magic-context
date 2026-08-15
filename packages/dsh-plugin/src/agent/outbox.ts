/**
 * agent/outbox — the DSH adapter's saga records + recovery (Phase 3).
 *
 * PLAN §3.2 outbox/saga: every surface mutation crosses two stores —
 *
 *   SQLite pending ──> DSH 事务 (session.append surfaceOp replace) ──> SQLite committed
 *
 * Each record carries: opId, source seq watermark, input digest, surface
 * generation, and the DSH acknowledgement (the seq of the surface-replace
 * event). Startup reconciliation classifies every pending/applied record into
 * four deterministic outcomes (committed / retryable / stale-input /
 * conflict-recompute) from the DSH log alone.
 *
 * The tables are ADAPTER-OWNED: the core's schema fence checks
 * `schema_migrations` only, so these `dsh_*` tables never touch core
 * migrations. The compaction marker table lives here too (the Pi adapter
 * keeps its marker in a session_meta column; DSH must not occupy core
 * columns, so the marker state is adapter-owned).
 */
import type { Database } from "@magic-context/core/shared/sqlite";

/** The plan kinds that can produce outbox records (MutationPlan.ops[].kind). */
export type OutboxKind =
  | "tags"
  | "drops"
  | "reasoning"
  | "temporal"
  | "nudge"
  | "decay"
  | "caveman"
  | "historian"
  | "recomp"
  | "wrapup"
  | "emergency";

/** One saga record (row of dsh_context_outbox). */
export interface OutboxRecord {
  readonly opId: string;
  readonly sessionId: string;
  readonly kind: OutboxKind;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly status: "pending" | "applied" | "committed" | "abandoned";
  readonly ackSeq: number | null;
  readonly errorDetail: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Row shape as stored (snake_case). */
interface OutboxRow {
  op_id: string;
  session_id: string;
  kind: string;
  source_watermark: number;
  input_digest: string;
  generation: number;
  status: string;
  dsh_ack_seq: number | null;
  error_detail: string | null;
  created_at: number;
  updated_at: number;
}

/** Adapter table schema version (dsh_adapter_meta key). */
export const ADAPTER_META_KEY = "adapter_schema";
export const ADAPTER_SCHEMA_VERSION = "1";

const OUTBOX_COLUMNS =
  "op_id, session_id, kind, source_watermark, input_digest, generation, status, dsh_ack_seq, error_detail, created_at, updated_at";

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    opId: row.op_id,
    sessionId: row.session_id,
    kind: row.kind as OutboxKind,
    sourceWatermark: row.source_watermark,
    inputDigest: row.input_digest,
    generation: row.generation,
    status: row.status as OutboxRecord["status"],
    ackSeq: row.dsh_ack_seq,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the adapter-owned tables (idempotent). Called by the host bootstrap
 * right after a successful core `openDatabaseAsync` — core migrations never
 * see these tables, and the adapter never alters core tables.
 */
export function initializeDshAdapterTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_context_outbox (
      op_id            TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      harness          TEXT NOT NULL DEFAULT 'dsh',
      kind             TEXT NOT NULL,
      source_watermark INTEGER NOT NULL,
      input_digest     TEXT NOT NULL,
      generation       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      dsh_ack_seq      INTEGER,
      error_detail     TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dsh_outbox_session
      ON dsh_context_outbox(session_id, status);

    CREATE TABLE IF NOT EXISTS dsh_adapter_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dsh_context_compaction_marker (
      session_id     TEXT PRIMARY KEY,
      ordinal        INTEGER NOT NULL,
      end_message_id TEXT NOT NULL,
      tokens_before  INTEGER NOT NULL,
      summary        TEXT NOT NULL,
      published_at   INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS dsh_feedback_signals (
      session_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      rated_at    INTEGER NOT NULL,
      rating      TEXT NOT NULL DEFAULT 'negative',
      PRIMARY KEY (session_id, message_id)
    );
  `);
  db.prepare(
    `INSERT INTO dsh_adapter_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ADAPTER_META_KEY, ADAPTER_SCHEMA_VERSION);
}

export interface OutboxPendingInput {
  readonly opId: string;
  readonly sessionId: string;
  readonly kind: OutboxKind;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
}

/**
 * Record the pending leg of the saga (BEGIN IMMEDIATE, INSERT OR IGNORE).
 * Idempotent per opId — a replay of the same plan must not double-insert.
 */
export function insertOutboxPending(db: Database, input: OutboxPendingInput): void {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO dsh_context_outbox
         (op_id, session_id, kind, source_watermark, input_digest, generation, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      input.opId,
      input.sessionId,
      input.kind,
      input.sourceWatermark,
      input.inputDigest,
      input.generation,
      now,
      now,
    );
  })();
}

/** DSH transaction succeeded: record the acknowledgement seq (BEGIN IMMEDIATE). */
export function markOutboxApplied(db: Database, opId: string, ackSeq: number): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE dsh_context_outbox
         SET status = 'applied', dsh_ack_seq = ?, updated_at = ?
       WHERE op_id = ?`,
    ).run(ackSeq, Date.now(), opId);
  })();
}

/** The surface replace is durable in the DSH log (and the DB state is final). */
export function markOutboxCommitted(db: Database, opId: string): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE dsh_context_outbox
         SET status = 'committed', updated_at = ?
       WHERE op_id = ?`,
    ).run(Date.now(), opId);
  })();
}

/** The DSH transaction failed or the plan was superseded: record why. */
export function markOutboxAbandoned(
  db: Database,
  opId: string,
  errorDetail?: string,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE dsh_context_outbox
         SET status = 'abandoned', error_detail = ?, updated_at = ?
       WHERE op_id = ?`,
    ).run(errorDetail ?? null, Date.now(), opId);
  })();
}

export function getOutboxRecord(db: Database, opId: string): OutboxRecord | undefined {
  const row = db
    .prepare(`SELECT ${OUTBOX_COLUMNS} FROM dsh_context_outbox WHERE op_id = ?`)
    .get(opId) as OutboxRow | null | undefined;
  return row === undefined || row === null ? undefined : toRecord(row);
}

export function listOutboxBySession(
  db: Database,
  sessionId: string,
  statuses?: readonly string[],
): OutboxRecord[] {
  if (statuses === undefined || statuses.length === 0) {
    const rows = db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM dsh_context_outbox
         WHERE session_id = ? ORDER BY created_at ASC, op_id ASC`,
      )
      .all(sessionId) as unknown as OutboxRow[];
    return rows.map(toRecord);
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${OUTBOX_COLUMNS} FROM dsh_context_outbox
       WHERE session_id = ? AND status IN (${placeholders})
       ORDER BY created_at ASC, op_id ASC`,
    )
    .all(sessionId, ...statuses) as unknown as OutboxRow[];
  return rows.map(toRecord);
}

/** The DSH-log facts a reconciliation can rely on (structural view). */
export interface DshSessionLogView {
  /** Whether the log contains an event with this seq (the ack). */
  hasSeq(seq: number): boolean;
  /** Current surface generation of the live session (0 when unknown). */
  generation: number;
}

/**
 * Deterministic four-way classification (PLAN §3.2). Pure — the crash-set
 * convergence property (any crash point between SQLite stage/commit and the
 * DSH append settles to the same outcome as an uninterrupted run) is a direct
 * consequence of the ordering:
 *
 *   pending ──(DSH append)──> applied(ackSeq) ──(SQLite commit)──> committed
 *
 * - ackSeq present in the log → the DSH leg happened → committed.
 * - no ack, generation unchanged → the DSH leg never happened (crash before
 *   append, or append failed) → retryable.
 * - no ack, generation advanced → the surface moved on (e.g. a later plan or
 *   compaction landed) → the plan's input is stale → stale-input.
 * - conflict-recompute: reserved for plans whose generation matches but whose
 *   inputDigest can no longer be derived from the current surface (detected by
 *   the caller re-deriving the transcript) — classification helper for that
 *   caller-provided flag.
 */
export type ReconcileOutcome =
  | "committed"
  | "retryable"
  | "stale-input"
  | "conflict-recompute";

export function classifyOutboxRecord(
  record: OutboxRecord,
  sessionLog: DshSessionLogView,
  options: { digestMismatch?: boolean } = {},
): ReconcileOutcome {
  if (record.status === "committed") return "committed";
  if (record.status === "abandoned") return "stale-input";
  if (record.ackSeq !== null && sessionLog.hasSeq(record.ackSeq)) return "committed";
  if (options.digestMismatch === true) return "conflict-recompute";
  if (sessionLog.generation !== record.generation) return "stale-input";
  return "retryable";
}

/** Reconcile every non-terminal record of one session (startup + first step). */
export function reconcileSessionOutbox(
  db: Database,
  sessionId: string,
  sessionLog: DshSessionLogView,
): Record<string, ReconcileOutcome> {
  const outcomes: Record<string, ReconcileOutcome> = {};
  const records = listOutboxBySession(db, sessionId, ["pending", "applied"]);
  for (const record of records) {
    const outcome = classifyOutboxRecord(record, sessionLog);
    outcomes[record.opId] = outcome;
    if (outcome === "committed") {
      markOutboxCommitted(db, record.opId);
    } else if (outcome === "stale-input" || outcome === "conflict-recompute") {
      markOutboxAbandoned(db, record.opId, `reconcile: ${outcome}`);
    }
  }
  return outcomes;
}

// ── compaction marker (adapter-owned; DSH counterpart of the Pi marker) ──────

export interface CompactionMarker {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly endMessageId: string;
  readonly tokensBefore: number;
  readonly summary: string;
  readonly publishedAt: number;
  readonly status: "pending" | "applied";
}

interface MarkerRow {
  session_id: string;
  ordinal: number;
  end_message_id: string;
  tokens_before: number;
  summary: string;
  published_at: number;
  status: string;
}

export function stageDshCompactionMarker(
  db: Database,
  sessionId: string,
  marker: {
    readonly ordinal: number;
    readonly endMessageId: string;
    readonly tokensBefore: number;
    readonly summary: string;
  },
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO dsh_context_compaction_marker
         (session_id, ordinal, end_message_id, tokens_before, summary, published_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(sessionId, marker.ordinal, marker.endMessageId, marker.tokensBefore, marker.summary, Date.now());
  })();
}

export function getDshCompactionMarker(
  db: Database,
  sessionId: string,
): CompactionMarker | null {
  const row = db
    .prepare(
      `SELECT session_id, ordinal, end_message_id, tokens_before, summary, published_at, status
       FROM dsh_context_compaction_marker WHERE session_id = ?`,
    )
    .get(sessionId) as MarkerRow | null | undefined;
  if (row === undefined || row === null) return null;
  return {
    sessionId: row.session_id,
    ordinal: row.ordinal,
    endMessageId: row.end_message_id,
    tokensBefore: row.tokens_before,
    summary: row.summary,
    publishedAt: row.published_at,
    status: row.status as CompactionMarker["status"],
  };
}

/** CAS clear: only clears when the stored marker still matches `expected`. */
export function clearDshCompactionMarkerIf(
  db: Database,
  sessionId: string,
  expected: { readonly ordinal: number; readonly endMessageId: string },
): boolean {
  const changed = db.transaction(() => {
    const result = db
      .prepare(
        `DELETE FROM dsh_context_compaction_marker
         WHERE session_id = ? AND ordinal = ? AND end_message_id = ?`,
      )
      .run(sessionId, expected.ordinal, expected.endMessageId);
    return result.changes > 0;
  })();
  return changed;
}
