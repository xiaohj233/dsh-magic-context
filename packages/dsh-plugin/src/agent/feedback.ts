/**
 * agent/feedback — the DSH message-feedback bridge (Phase 4, PLAN §5.8).
 *
 * The core has NO consumer of harness feedback (research R6-B: zero read
 * points), so the "positive/negative feedback as a Dreamer retrospective
 * high-confidence signal" is a DSH-side bridge:
 *
 *   ctx.messageFeedback.list({sessionId})  →  negative items  →
 *   dsh_feedback_signals(session_id, message_id, rated_at)   →  consumed by
 *   the retrospective wiring (DSH raw provider / dreamer seam) later.
 *
 * The bridge is idempotent (per-message primary key) and watermarked
 * (adapter meta per session tracks the last consumed item time) so a restart
 * never re-ingests old feedback.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Database } from "@magic-context/core/shared/sqlite";
import { initializeDshAdapterTables } from "./outbox";

export interface FeedbackItem {
  readonly messageId: string;
  readonly rating: "positive" | "negative";
  readonly createdAt: number;
}

/** The feedback service surface we consume (structural view). */
export interface MessageFeedbackServiceView {
  list(request: { sessionId: string }): Promise<{ ok: true; value: { items: FeedbackItem[] } } | { ok: false; error: unknown }>;
}

function watermarkKey(sessionId: string): string {
  return `feedback_watermark:${sessionId}`;
}

/** Read the per-session feedback watermark (0 = never consumed). */
export function readFeedbackWatermark(db: Database, sessionId: string): number {
  const row = db
    .prepare("SELECT value FROM dsh_adapter_meta WHERE key = ?")
    .get(watermarkKey(sessionId)) as { value: string } | null | undefined;
  const parsed = row === undefined || row === null ? NaN : Number(row.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Record negative feedback items newer than the watermark (idempotent). */
export function ingestNegativeFeedback(
  db: Database,
  sessionId: string,
  items: readonly FeedbackItem[],
  now = Date.now(),
): number {
  initializeDshAdapterTables(db);
  const watermark = readFeedbackWatermark(db, sessionId);
  let ingested = 0;
  let maxSeen = watermark;
  db.transaction(() => {
    for (const item of items) {
      if (item.rating !== "negative") continue;
      if (item.createdAt <= watermark) continue;
      db.prepare(
        `INSERT OR IGNORE INTO dsh_feedback_signals (session_id, message_id, rated_at, rating)
         VALUES (?, ?, ?, 'negative')`,
      ).run(sessionId, item.messageId, item.createdAt);
      ingested += 1;
      if (item.createdAt > maxSeen) maxSeen = item.createdAt;
    }
    if (maxSeen > watermark) {
      db.prepare(
        `INSERT INTO dsh_adapter_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(watermarkKey(sessionId), String(maxSeen));
    }
  })();
  return ingested;
}

/** The session's negative-feedback signal message ids (newest first). */
export function recentNegativeFeedback(db: Database, sessionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT message_id FROM dsh_feedback_signals
        WHERE session_id = ? ORDER BY rated_at DESC, message_id ASC`,
    )
    .all(sessionId) as unknown as { message_id: string }[];
  return rows.map((row) => row.message_id);
}

/** Bridge result of one consumption pass. */
export interface FeedbackBridgeResult {
  readonly ingested: number;
  readonly signals: readonly string[];
}

/**
 * Consume the official message-feedback service for one session: read the
 * list, ingest negative items newer than the watermark, return the bridge
 * result. Fail-open: any service error yields an empty result.
 */
export async function consumeFeedbackSignals(
  ctx: Context,
  db: Database,
  sessionId: string,
): Promise<FeedbackBridgeResult> {
  const service = ctx.get("messageFeedback") as MessageFeedbackServiceView | undefined;
  if (service === undefined) return { ingested: 0, signals: recentNegativeFeedback(db, sessionId) };
  try {
    const result = await service.list({ sessionId });
    if (!result.ok) return { ingested: 0, signals: recentNegativeFeedback(db, sessionId) };
    const ingested = ingestNegativeFeedback(db, sessionId, result.value.items);
    return { ingested, signals: recentNegativeFeedback(db, sessionId) };
  } catch {
    return { ingested: 0, signals: recentNegativeFeedback(db, sessionId) };
  }
}
