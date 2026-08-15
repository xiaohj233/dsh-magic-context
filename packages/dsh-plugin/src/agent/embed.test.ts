import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { runEmbedDrain } from "./embed";
import * as embedState from "@magic-context/core/hooks/magic-context/embed-session-state";

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

describe("embed drain (/ctx-embed seam)", () => {
  it("maps the core outcome statuses to user-facing texts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-embed-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const sessionId = "dsh:a1b2c3d4:s1";
      const projectIdentity = "dir:abc";
      const signal = new AbortController().signal;

      const outcomes: Array<Record<string, unknown>> = [
        { status: "nothing" },
        { status: "disabled" },
        { status: "busy" },
        { status: "stalled", embedded: 3, remaining: 2 },
        { status: "completed", embedded: 5 },
      ];
      const texts: string[] = [];
      for (const outcome of outcomes) {
        const result = await runEmbedDrain(
          db,
          projectIdentity,
          sessionId,
          "start",
          signal,
          Date.now,
          (async () => outcome) as never,
        );
        texts.push(result.text);
      }
      expect(texts[0]).toContain("already embedded");
      expect(texts[1]).toContain("No embedding provider");
      expect(texts[2]).toContain("already running for this project");
      expect(texts[3]).toContain("3 compartment");
      expect(texts[4]).toContain("Embedded 5 compartments");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("pause aborts the active run and reports coverage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-embed-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const sessionId = "dsh:a1b2c3d4:s2";
      const projectIdentity = "dir:abc";
      const signal = new AbortController().signal;
      // Seed a coverage row so the pause report resolves.
      db.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'dsh', ?, 0)",
      ).run(sessionId, projectIdentity);
      const result = await runEmbedDrain(db, projectIdentity, sessionId, "pause", signal);
      expect(result.text).toContain("Paused at");
      expect(result.level).toBe("info");
      expect(embedState.embedPauseBySession.has(sessionId)).toBe(true);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("idempotent start keeps an active drain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-embed-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const sessionId = "dsh:a1b2c3d4:s3";
      const signal = new AbortController().signal;
      // Fake an active run state.
      embedState.embedRunStateBySession.set(
        sessionId,
        new AbortController(),
      );
      const result = await runEmbedDrain(db, "dir:abc", sessionId, "start", signal);
      expect(result.text).toContain("already running for this session");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});
