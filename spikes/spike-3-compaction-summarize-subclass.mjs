/**
 * Spike 3 — MagicCompactionEngine: BasicCompactionEngine subclass with a
 * `summarize()` override (PLAN D3 / §5.1).
 *
 * Validates that the official compaction transaction stays fully owned by
 * dsh-compaction-basic while the summary content comes from our hook:
 *  1. a subclass overriding ONLY `summarize()` plugs into compactRegion();
 *  2. the transaction emits the official event sequence
 *     compaction/start → compaction/summary → user/message(replace) →
 *     compaction/end with the compactCheckpointSource provenance;
 *  3. the returned result correlates start/summary/end seqs, the shadowed
 *     range, and the shadowed token count;
 *  4. the durable lock rejects a second concurrent compaction;
 *  5. a summary that is not smaller than the shadowed content fails the
 *     transaction (official pricing check);
 *  6. `summarize()` receives the replayed region input (system/tools/messages)
 *     — the KV-cache-preserving prefix contract.
 */
import assert from "node:assert/strict";
import { dshImport } from "./lib/dsh-sdk.mjs";

const { Context } = await dshImport("@deepseek-ai/cordis");
const { BasicCompactionEngine } = await dshImport("@deepseek-ai/dsh-compaction-basic");
const { CompactionId, compactCheckpointSource, isCompactCheckpointSource } =
  await dshImport("@deepseek-ai/dsh-compaction");
const { Session } = await dshImport("@deepseek-ai/dsh-session");
const { createUserMessage, createAssistantMessage, createToolResultMessage } =
  await dshImport("@deepseek-ai/dsh-llm");
const { default: TokenMeter } = await dshImport("@deepseek-ai/dsh-token-meter");

const text = (t) => [{ type: "text", text: t }];
/** Pad prose to a realistic per-message length (token region >> summary frame). */
const pad = (t, n) => {
  const base = t;
  return base.length >= n ? base : base + "\n\n" + "lorem ipsum dolor sit amet ".repeat(Math.ceil((n - base.length) / 28));
};
const PAD = 4000; // ~1k tokens per message → selected region ≫ 278-token frame

/** Magic-style engine: sole hook is summarize(). The official contract takes
 * the summary as TEXT BLOCKS (frameSummary spreads them into the checkpoint). */
class MagicEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}, hook = null) {
    super(ctx, { auto: false, ...config });
    this.hook = hook;
  }
  async summarize(input, agent, signal) {
    if (this.hook) return this.hook(input, agent, signal);
    return {
      summary: [{ type: "text", text: `Magic summary of ${input.messages.length} region message(s)` }],
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
}

/** Build a session with one balanced exchange and an OPEN turn. */
function buildOpenTurnSession() {
  const session = Session.create("spike-3-session");
  session.append("turn/start", { turn: 1 });
  const u1 = session.append(
    "user/message",
    createUserMessage({ content: text(pad("first user prompt", PAD)), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 1, step: 1 });
  const a1 = session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: "text", text: pad("let me check the file", PAD) },
        {
          type: "tool-call",
          callId: "call-1",
          name: "fs_read",
          arguments: JSON.stringify({ path: "a.txt" }),
        },
      ],
      source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    }),
  }, { surfaceOp: "append" });
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "fs_read",
    arguments: JSON.stringify({ path: "a.txt" }),
  });
  const t1 = session.append("tool/result", {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: "call-1",
      content: text(pad("contents of a.txt", PAD)),
      isError: false,
    }),
  }, { surfaceOp: "append" });
  // Close the step like a real between-step compaction boundary; the TURN
  // stays open (required for the "current-turn" compaction owner).
  session.append("step/end", { turn: 1, step: 1 });
  return { session, u1, a1, t1 };
}

/** Boot a context with real TokenMeter + stub llm/sessions + our engine. */
async function bootEngine(hook, contextWindow = 4000) {
  const ctx = new Context();
  await ctx.plugin(TokenMeter, {});
  ctx.provide("llm", {
    async resolveModelInfo() {
      return { context: { contextWindow } };
    },
  });
  ctx.provide("sessions", { async flush() {} });
  const fiber = ctx.plugin(MagicEngine, { auto: false });
  const engine = (await fiber).ctx.compaction;
  if (hook) engine.hook = hook; // ctx.plugin passes only (ctx, config); the hook is assigned post-creation
  return { ctx, engine, dispose: () => fiber.dispose() };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

let seenInput = null;
await check("subclass with summarize() override runs the official transaction", async () => {
  const { ctx, engine, dispose } = await bootEngine(async (input) => {
    seenInput = input;
    return {
      summary: [{ type: "text", text: "Magic digest" }],
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    };
  });
  try {
    const { session, u1, a1, t1 } = buildOpenTurnSession();
    const agent = {
      session,
      options: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    };
    const result = await engine.compactRegion(u1.seq, t1.seq, agent, new AbortController().signal);
    // Result shape + correlation.
    assert.equal(typeof result.compactionId, "string");
    assert.ok(result.startSeq < result.summarySeq);
    assert.ok(result.summarySeq < result.endSeq);
    assert.deepEqual(result.shadowedSeqs, [u1.seq, a1.seq, t1.seq]);
    assert.deepEqual(result.shadowedRange, { start: u1.seq, end: t1.seq });
    assert.equal(result.summary[0].text, "Magic digest");
    assert.ok(result.shadowedTokenCount > 0);
    // Official event sequence.
    const types = session.events.map((e) => e.type);
    const compactionIndexes = types
      .map((t, i) => (t.startsWith("compaction/") ? i : -1))
      .filter((i) => i >= 0);
    assert.deepEqual(types.slice(compactionIndexes[0], compactionIndexes[2] + 1), [
      "compaction/start",
      "compaction/summary",
      "user/message",
      "compaction/end",
    ]);
    // Checkpoint provenance + surface replace.
    const checkpoint = session.events[compactionIndexes[1] + 1];
    assert.equal(checkpoint.type, "user/message");
    assert.ok(isCompactCheckpointSource(checkpoint.data.source));
    assert.deepEqual(checkpoint.surfaceOp, { op: "replace", start: u1.seq, end: t1.seq });
    assert.deepEqual(checkpoint.sourceEventSeqs, [
      result.startSeq,
      result.summarySeq,
      u1.seq,
      a1.seq,
      t1.seq,
    ]);
    // Surface updated + generation bumped.
    assert.deepEqual([...session.surface.nodes], [checkpoint.seq]);
    assert.equal(session.surface.replaceGeneration, 1);
    // Replay determinism of the full log.
    const revived = Session.fromRestore(session.id, session.events, session.header);
    assert.deepEqual([...revived.surface.nodes], [checkpoint.seq]);
  } finally {
    await dispose();
  }
});

await check("summarize() receives the replayed region prefix (KV-cache contract)", async () => {
  const { ctx, engine, dispose } = await bootEngine(null);
  try {
    const { session, u1, t1 } = buildOpenTurnSession();
    const agent = { session, options: {} };
    await engine.compactRegion(u1.seq, t1.seq, agent, new AbortController().signal);
  } finally {
    await dispose();
  }
  assert.ok(seenInput !== null);
  assert.ok(Array.isArray(seenInput.messages));
  assert.ok(seenInput.messages.length >= 3, "region messages must be replayed");
  assert.ok(
    seenInput.messages.every((m) => ["user", "assistant", "tool"].includes(m.role)),
  );
});

await check("durable compaction lock rejects a second concurrent compaction", async () => {
  const { ctx, engine, dispose } = await bootEngine(null);
  try {
    const { session, u1, t1 } = buildOpenTurnSession();
    // Simulate an already-active transaction by leaving an unmatched start.
    session.append("compaction/start", { compactionId: CompactionId("other") });
    const agent = { session, options: {} };
    await assert.rejects(
      engine.compactRegion(u1.seq, t1.seq, agent, new AbortController().signal),
      /compaction already in progress/,
    );
  } finally {
    await dispose();
  }
});

await check("a summary not smaller than the shadowed content fails the transaction", async () => {
  const { ctx, engine, dispose } = await bootEngine(async () => ({
    summary: [{ type: "text", text: "x".repeat(100000) }], // deliberately huge
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  }));
  try {
    const { session, u1, t1 } = buildOpenTurnSession();
    const agent = { session, options: {} };
    await assert.rejects(
      engine.compactRegion(u1.seq, t1.seq, agent, new AbortController().signal),
      /summary is not smaller/,
    );
    // Failed transaction still closes with a compaction/end carrying the error.
    const last = session.events.at(-1);
    assert.equal(last.type, "compaction/end");
    assert.ok(last.data.error);
  } finally {
    await dispose();
  }
});

await check("compactIfNeeded pressure path works with the subclass hook", async () => {
  // Realistic pressure: contextWindow 3000 → threshold 2400; the ~2958-token
  // surface trips it, one compaction (shadowing u1) drops below the threshold.
  const { ctx, engine, dispose } = await bootEngine(null, 3000);
  try {
    const { session, u1, t1 } = buildOpenTurnSession();
    session.append("request/header", {
      header: {
        config: { provider: "deepseek-official", model: "deepseek-v4-flash" },
        system: "you are a test agent",
      },
      reason: "initial",
    });
    const agent = { session, options: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
    const result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    assert.ok(result !== null);
    assert.equal(result.summary[0].text, "Magic summary of 1 region message(s)");
    assert.ok(result.shadowedTokenCount > 100, "shadowed region must be priced");
  } finally {
    await dispose();
  }
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ok  ${r.name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${r.name}`);
    console.log(`      ${r.error?.message ?? r.error}`);
  }
}
console.log(`\nspike-3: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
