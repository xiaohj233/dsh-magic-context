import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { deriveMutationPlan, readDshTranscript } from "./transcript";

function buildSession() {
  const session = Session.create(SessionId("sess-cleanup"));
  const u1 = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
  session.append("user/message", u1, { surfaceOp: "append" });
  const a1 = createAssistantMessage({ content: [{ type: "text", text: "let me check" }], provider: "deepseek", model: "deepseek-chat", source: { kind: "model" } });
  session.append("assistant/message", { turn: 1, step: 1, message: a1 }, { surfaceOp: "append" });
  return session;
}

describe("heuristic cleanup integration (Pi/OpenCode parity)", () => {
  it("runs without error and keeps the plan pipeline intact when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-cleanup-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = readDshTranscript({
        session: { events: session.events, surface: session.surface, header: { cwd: "/tmp" } },
        canonicalSessionId: "dsh:a1b2c3d4:sess-cleanup",
      });
      const plan = deriveMutationPlan(view, {
        db,
        protectedTags: 20,
        heuristicCleanup: { caveman: { enabled: false, minChars: 500 } },
      });
      expect(plan).not.toBeNull();
      expect(plan!.ops.length).toBeGreaterThan(0);
      expect(getTagsBySession(db, view.sessionId).length).toBeGreaterThan(0);
      db.close();
    } finally {
      await rmSync(dir, { recursive: true, force: true });
    }
  });
});
