import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  magicUserMessage,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import {
  buildDshOrdinalMap,
  convertDshEventsToRawMessages,
  deriveMutationPlan,
  dshSeqForOrdinal,
  findKnowledgeBaselineNodeIndices,
  isKnowledgeBaselineMessage,
  isSkillCatalogBaselineMessage,
  readDshTranscript,
  type DshTranscriptView,
} from "./transcript";

/** Build a real DSH session with a scripted conversation (append-only). */
function buildSession() {
  const session = Session.create(SessionId("sess-transcript"));
  const user1 = createUserMessage({
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" },
  });
  session.append("user/message", user1, { surfaceOp: "append" });
  const assistant1 = createAssistantMessage({
    content: [
      { type: "text", text: "let me check" },
      { type: "tool-call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  session.append("assistant/message", { turn: 1, step: 1, message: assistant1 }, { surfaceOp: "append" });
  const tool1 = createToolResultMessage({
    callId: "call-1",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
  });
  session.append("tool/result", { turn: 1, step: 1, message: tool1 }, { surfaceOp: "append" });
  session.append("tool/call", { turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: "{}" });
  const user2 = createUserMessage({
    content: [{ type: "text", text: "thanks" }],
    source: { kind: "user" },
  });
  session.append("user/message", user2, { surfaceOp: "append" });
  const assistant2 = createAssistantMessage({
    content: [{ type: "text", text: "done" }],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  session.append("assistant/message", { turn: 2, step: 1, message: assistant2 }, { surfaceOp: "append" });
  // Dangling tool result at the tail (no following user).
  const tool2 = createToolResultMessage({
    callId: "call-2",
    content: [{ type: "text", text: "tail output" }],
    isError: false,
  });
  session.append("tool/result", { turn: 2, step: 1, message: tool2 }, { surfaceOp: "append" });
  return session;
}

function viewOf(session: Session): DshTranscriptView {
  return readDshTranscript({
    session: {
      events: session.events,
      surface: session.surface,
      header: { cwd: "C:/work" },
    },
    canonicalSessionId: "dsh:a1b2c3d4:sess-transcript",
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

describe("transcript mapping (DSH events → RawMessage[])", () => {
  it("folds tool results AND their tool-call assistant into the following user message", () => {
    const session = buildSession();
    const messages = convertDshEventsToRawMessages(session.events);
    // user1, user2(+assistant1 tool-call + tool1), assistant2, synth-user(tool2)
    // The tool-call assistant is folded with its results so the surface never
    // keeps an assistant `tool_calls` block without a following tool message
    // (issue #1: "insufficient tool messages following tool_calls").
    expect(messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 4]);
    // user2 carries the folded assistant text AND the folded tool part.
    const user2 = messages[1]!;
    expect(user2.parts.some((p) => isToolPart(p, "call-1"))).toBe(true);
    expect(user2.parts.some((p) => isRecord(p) && p.type === "text")).toBe(true);
    // Tail synthetic user carries tool2 (and assistant2's tool-call).
    const tail = messages[3]!;
    expect(tail.id.startsWith("synth-user-")).toBe(true);
    expect(tail.parts.some((p) => isToolPart(p, "call-2"))).toBe(true);
    // No standalone assistant with a tool-call block remains.
    const assistant = messages[2]!;
    expect(assistant.parts.some((p) => isToolPart(p, "call-1"))).toBe(false);
    expect(assistant.parts.some((p) => isRecord(p) && p.type === "text")).toBe(true);
  });

  it("builds a reversible seq ↔ ordinal map", () => {
    const session = buildSession();
    const events = session.events;
    const map = buildDshOrdinalMap(events);
    // user1's seq → ordinal 1; tool1's seq and assistant1's seq → ordinal 2
    // (both folded into user2).
    const seqs = events.map((e) => e.seq);
    expect(dshSeqForOrdinal(events, 1)).toBe(seqs[0]);
    expect(dshSeqForOrdinal(events, 2)).toBe(seqs[4]); // user2's own seq
    const tool1Seq = seqs[2]!;
    expect(map.seqToOrdinal.get(tool1Seq)).toBe(2);
    const assistant1Seq = seqs[1]!;
    expect(map.seqToOrdinal.get(assistant1Seq)).toBe(2);
  });

  it("produces a stable read-only view with digest/watermark/generation", () => {
    const session = buildSession();
    const view = viewOf(session);
    expect(view.sessionId).toBe("dsh:a1b2c3d4:sess-transcript");
    expect(view.generation).toBe(0);
    expect(view.sourceWatermark).toBe(session.events[session.events.length - 1]!.seq);
    expect(view.inputDigest.length).toBe(16);
    expect(view.surfaceNodes).toEqual([...session.surface.nodes]);
    // Same input → same digest.
    expect(viewOf(session).inputDigest).toBe(view.inputDigest);
  });

  it("detects the Magic knowledge baseline (m0) in the surface", () => {
    const session = Session.create(SessionId("sess-kb"));
    session.append(
      "user/message",
      magicUserMessage("knowledge baseline", {
        kind: "plugin",
        plugin: "magic-context",
        messageId: "mc-kb:1:digest",
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "user/message",
      createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    const view = viewOf(session);
    expect(view.messages.some((m) => isKnowledgeBaselineMessage(m))).toBe(true);
    const indices = findKnowledgeBaselineNodeIndices(session.events, view.surfaceNodes);
    expect(indices).toEqual([0]);
  });
});

describe("deriveMutationPlan (recording pipeline)", () => {
  it("records §N§ prefix injections on the first pass and replays byte-identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);

      const first = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(first).not.toBeNull();
      expect(first!.ops.length).toBeGreaterThan(0);
      expect(first!.ops.every((op) => op.kind === "tags")).toBe(true);
      expect(first!.ops.every((op) => op.replacement.includes("\u00a7"))).toBe(true);
      expect(first!.sessionId).toBe(view.sessionId);
      expect(first!.inputDigest).toBe(view.inputDigest);
      expect(first!.generation).toBe(view.generation);

      // The view is immutable, so re-deriving against the SAME view yields the
      // same plan (replay invariant); surface-side idempotency is enforced by
      // the coordinator's outbox CAS (opId already applied → no-op), and by
      // the surface reflecting applied prefixes on later passes.
      const second = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(second).not.toBeNull();
      expect(second!.ops).toEqual(first!.ops);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("derives a drop op from a queued pending operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      // First pass assigns tags.
      deriveMutationPlan(view, { db, protectedTags: 0 });
      const tags = getTagsBySession(db, view.sessionId);
      expect(tags.length).toBeGreaterThan(0);
      const textTag = tags.find((t) => t.type === "message")!;
      queuePendingOp(db, view.sessionId, textTag.tagNumber, "drop", Date.now());

      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).not.toBeNull();
      const dropOp = plan!.ops.find((op) => op.kind === "drops");
      expect(dropOp).toBeDefined();
      expect(dropOp!.replacement).toContain(`[dropped \u00a7${textTag.tagNumber}\u00a7]`);
      expect(dropOp!.shadowedSeqs.length).toBeGreaterThan(0);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("is deterministic: identical views + DB state produce identical ops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      const a = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      const b = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      expect(a.ops).toEqual(b.ops);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("never mutates the input events or surface (read-only view)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const eventsBefore = JSON.stringify(session.events);
      const nodesBefore = [...session.surface.nodes];
      const view = viewOf(session);
      deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(JSON.stringify(session.events)).toBe(eventsBefore);
      expect([...session.surface.nodes]).toEqual(nodesBefore);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("returns null for an empty session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-empty"));
      const view = viewOf(session);
      expect(deriveMutationPlan(view, { db, protectedTags: 0 })).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("fold write-back ops cover the tool-call assistant node (LLM-valid surface)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      // The folding of tool results is tag-driven; with tags applied the
      // fold message is dirty and the plan carries a replace op for the
      // tool/result span. (If the shared tagger does not dirty it, the
      // bug cannot reproduce through this path — assert non-null to know.)
      expect(plan).not.toBeNull();
      if (plan === null) return;
      const assistantSeq = session.events[1]!.seq; // assistant1 (tool-call)
      const tool1Seq = session.events[2]!.seq; // tool/result call-1
      const assistantIndex = view.surfaceNodes.indexOf(assistantSeq);
      const tool1Index = view.surfaceNodes.indexOf(tool1Seq);
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(tool1Index).toBeGreaterThan(assistantIndex);
      // The op that replaces the tool/result span must ALSO cover the
      // preceding tool-call assistant node — otherwise the surface keeps an
      // assistant `tool_calls` block with no following tool message
      // (issue #1: "insufficient tool messages following tool_calls").
      const foldOp = plan.ops.find(
        (op) =>
          op.kind !== "temporal" &&
          op.start <= tool1Index &&
          tool1Index < op.end &&
          op.shadowedSeqs.includes(tool1Seq),
      );
      expect(foldOp).toBeDefined();
      expect(foldOp!.start).toBeLessThanOrEqual(assistantIndex);
      expect(foldOp!.shadowedSeqs).toContain(assistantSeq);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("keeps dsh skill-catalog messages out of the tag/drop pipeline (no ops, marked baseline)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-skillcat-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-skillcat"));
      // dsh-tool-skill's durable catalog reminder: source.kind === 'skill-catalog'.
      const catalog = createUserMessage({
        content: [
          {
            type: "text",
            text: "<system-reminder>\nThe available skill catalog changed…\n</system-reminder>",
          },
        ],
        source: {
          kind: "skill-catalog",
          form: "catalog",
          update: true,
          entries: [{ name: "test-skill", description: "A test skill." }],
        } as never,
      });
      session.append("user/message", catalog, { surfaceOp: "append" });

      const view = viewOf(session);
      // The catalog message is marked as a protected baseline in the view…
      const marked = view.messages.find((m) => isSkillCatalogBaselineMessage(m));
      expect(marked).toBeDefined();
      // …and deriveMutationPlan produces NO ops for it (before the fix the
      // tagger would inject a §N§ prefix → a surface replace each round →
      // the visible catalog digest disappears → dsh-tool-skill re-injects
      // the reminder on every pre-step).
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolPart(part: unknown, callId: string): boolean {
  return isRecord(part) && part.type === "tool" && part.callID === callId;
}
