import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapDshStorage,
  contextDbPath,
  dshCanonicalSessionKey,
} from "./bootstrap";
import { removeDshLivenessMarker } from "../compat/dsh-0.1/liveness";

describe("dsh storage bootstrap (Phase 1 boundary)", () => {
  it("opens the shared DB with the liveness marker present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-boot-"));
    try {
      const dbPath = join(dir, "context.db");
      const outcome = await bootstrapDshStorage({
        directory: join(dir, "proj"),
        port: 0,
        dbPath,
        storageDirOverride: dir,
        homeHash: "a1b2c3d4",
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      expect(outcome.db).toBeDefined();
      expect(outcome.storageDir).toBe(dir);
      // The marker file exists while the process is live.
      expect(outcome.livenessPath).toContain("port-");
      // The shared DB is created at the canonical location.
      expect(contextDbPath(dir)).toBe(join(dir, "context.db"));
      outcome.db.close();
      removeDshLivenessMarker(outcome.livenessPath);
    } finally {
      // Windows may hold WAL handles briefly after close; best-effort retry.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  });

  it("derives canonical session keys", () => {
    expect(dshCanonicalSessionKey("a1b2c3d4", "session-x")).toBe(
      "dsh:a1b2c3d4:session-x",
    );
  });
});
