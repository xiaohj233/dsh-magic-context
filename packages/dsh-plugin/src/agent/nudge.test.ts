import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createTestDb, createTestStorageDir } from "../test-utils";
import { maybeNudgeChannels, scanSessionMetrics } from "./nudge";
import { updateTagTokenCount } from "@magic-context/core/features/magic-context/storage-tags";

describe("nudge (ctx_reduce Channel-1 parity)", () => {
  async function openDb() {
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    return { db, dir, sessionId: "dsh:test:nudge-session" };
  }

  function fakeAgent(events: unknown[]): never {
    return { session: { events } } as never;
  }

  it("scans session metrics: context window + last input usage", () => {
    const metrics = scanSessionMetrics(
      fakeAgent([
        { type: "request/context", data: { contextWindow: 1000000 } },
        { type: "assistant/message", data: { usage: { inputTokens: 5000, outputTokens: 10 } } },
      ]),
    );
    expect(metrics.contextWindow).toBe(1000000);
    expect(metrics.lastInputTokens).toBe(5000);
  });

  it("persists nudge cadence state and stays silent below the floor", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      const agent = fakeAgent([{ type: "request/context", data: { contextWindow: 1000000 } }]);
      const injected: unknown[] = [];
      (agent as unknown as { inject: (m: unknown) => void }).inject = (m) => injected.push(m);
      maybeNudgeChannels(db, sessionId, agent, { threshold: 65, protectedTags: 0, log: () => {} });
      expect(injected.length).toBe(0);
      // 无工具标签 → 低于地板 → 不触达（也不建 meta 行）。
      const row = db
        .prepare("SELECT last_nudge_undropped FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { last_nudge_undropped: number } | null;
      expect(row).toBeNull();
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("fires Channel 1 and injects a reminder when reclaimable tool output is large", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      // 写入一条大工具输出标签的 token_count。
      db.prepare(
        `INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, token_count, drop_mode)
         VALUES (?, 'm1:p0', 'tool', 40000, 1, 'dsh', 20000, 'full')`,
      ).run(sessionId);
      const agent = fakeAgent([
        { type: "request/context", data: { contextWindow: 1000000 } },
        { type: "assistant/message", data: { usage: { inputTokens: 100000, outputTokens: 10 } } },
      ]);
      const injected: { text: string; messageId: string }[] = [];
      (agent as unknown as { inject: (m: { content: { text: string }[]; source: { messageId: string } }) => void }).inject =
        (m) => injected.push({ text: m.content[0].text, messageId: m.source.messageId });
      maybeNudgeChannels(db, sessionId, agent, {
        threshold: 65,
        protectedTags: 20,
        log: () => {},
      });
      // 20000 >= 10000 地板；压力 100000/1000000 = 0.1 < 0.8 → 压力门不过 → 不 fire。
      expect(injected.length).toBe(0);
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });
});
