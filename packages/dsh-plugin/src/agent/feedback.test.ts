import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { initializeDshAdapterTables } from "./outbox";
import {
  consumeFeedbackSignals,
  ingestNegativeFeedback,
  readFeedbackWatermark,
  recentNegativeFeedback,
} from "./feedback";

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

describe("feedback bridge (message-feedback → dreamer signal)", () => {
  it("ingests negative feedback newer than the watermark (idempotent per message)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-feedback-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const sessionId = "dsh:a1b2c3d4:s1";
      const items = [
        { messageId: "m1", rating: "negative" as const, createdAt: 100 },
        { messageId: "m2", rating: "negative" as const, createdAt: 200 },
        { messageId: "m3", rating: "positive" as const, createdAt: 300 },
      ];
      expect(ingestNegativeFeedback(db, sessionId, items, 1000)).toBe(2);
      expect(recentNegativeFeedback(db, sessionId)).toEqual(["m2", "m1"]);
      expect(readFeedbackWatermark(db, sessionId)).toBe(200);
      // Re-ingesting the same items is a no-op (watermark advanced).
      expect(ingestNegativeFeedback(db, sessionId, items, 1001)).toBe(0);
      // A newer negative item passes the watermark.
      expect(
        ingestNegativeFeedback(db, sessionId, [{ messageId: "m4", rating: "negative", createdAt: 500 }], 1002),
      ).toBe(1);
      expect(recentNegativeFeedback(db, sessionId)).toEqual(["m4", "m2", "m1"]);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("consumes the official feedback service and is fail-open without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-feedback-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const sessionId = "dsh:a1b2c3d4:s2";
      const ctx = {
        get: (name: string) =>
          name === "messageFeedback"
            ? {
                list: async () => ({
                  ok: true as const,
                  value: {
                    items: [
                      { messageId: "n1", rating: "negative" as const, createdAt: 10 },
                      { messageId: "p1", rating: "positive" as const, createdAt: 20 },
                    ],
                  },
                }),
              }
            : undefined,
      };
      const result = await consumeFeedbackSignals(ctx as never, db, sessionId);
      expect(result.ingested).toBe(1);
      expect(result.signals).toEqual(["n1"]);
      // Without the service: fail-open empty ingestion.
      const result2 = await consumeFeedbackSignals({ get: () => undefined } as never, db, sessionId);
      expect(result2.ingested).toBe(0);
      expect(result2.signals).toEqual(["n1"]);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});
