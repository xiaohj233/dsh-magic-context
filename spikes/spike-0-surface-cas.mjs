/**
 * Spike 0 — Surface CAS & replay determinism (dsh-session).
 *
 * Verifies the DSH surface contract that Magic's SurfaceMutationCoordinator
 * and DshTranscript MutationPlan will build on:
 *  1. append-only events with mandatory surfaceOp markers;
 *  2. positional replacement (`{op:'replace',start,end}` + sourceEventSeqs)
 *     as the ONLY legitimate surface mutation — the "DSH 事务" CAS primitive;
 *  3. replaceGeneration monotonicity (the CAS generation guard);
 *  4. replay determinism via the pure foldSurface() projection;
 *  5. contract violations are rejected (invalid ranges, missing coverage,
 *     surfaceOp on non-eligible events, missing marker).
 *
 * Constraint compliance: read-only against DSH packages; no llm/stream
 * request rewriting — mutations are surface log appends only.
 */
import assert from "node:assert/strict";
import { dshImport, dshImportSubpath } from "./lib/dsh-sdk.mjs";

const { Session } = await dshImport("@deepseek-ai/dsh-session");
const { foldSurface } = await dshImportSubpath(
  "@deepseek-ai/dsh-session",
  "lib/types/surface.js",
);
const { createUserMessage, createAssistantMessage, createToolResultMessage } =
  await dshImport("@deepseek-ai/dsh-llm");

const text = (t) => [{ type: "text", text: t }];

/** Build a synthetic conversation exercising appends + one replacement. */
function buildSession() {
  const session = Session.create("spike-0-session");
  // turn 1: user asks, assistant replies with one tool call, tool result.
  session.append("turn/start", { turn: 1 });
  const u1 = session.append(
    "user/message",
    createUserMessage({ content: text("first user prompt"), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 1, step: 1 });
  const a1 = session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: "text", text: "let me check" },
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
      content: text("contents of a.txt"),
      isError: false,
    }),
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 1, reason: "success" });
  // turn 2: user asks again, assistant answers.
  session.append("turn/start", { turn: 2 });
  const u2 = session.append(
    "user/message",
    createUserMessage({ content: text("second user prompt"), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 2, step: 1 });
  const a2 = session.append("assistant/message", {
    turn: 2,
    step: 1,
    message: createAssistantMessage({
      content: text("done"),
      source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    }),
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 2, reason: "success" });
  return { session, u1, a1, t1, u2, a2 };
}

/** Compact the first exchange [u1..t1] with a checkpoint message (Magic-style). */
function compactFirstExchange(session, u1, a1, t1, content = "[summary]") {
  return session.append(
    "user/message",
    createUserMessage({
      content: text(content),
      source: { kind: "plugin", plugin: "compact", compactionId: "c-1" },
    }),
    {
      surfaceOp: { op: "replace", start: u1.seq, end: t1.seq },
      sourceEventSeqs: [u1.seq, a1.seq, t1.seq],
    },
  );
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

await check("append-only log is immutable and frozen", () => {
  const { session } = buildSession();
  assert.ok(Object.isFrozen(session.events));
  assert.ok(Object.isFrozen(session.events[0]));
  assert.throws(() => {
    session.events[0].data = "x";
  }, TypeError);
});

await check("surface nodes mirror appends in order", () => {
  const { session, u1, a1, t1, u2, a2 } = buildSession();
  assert.deepEqual(
    [...session.surface.nodes],
    [u1.seq, a1.seq, t1.seq, u2.seq, a2.seq],
  );
  assert.equal(session.surface.replaceGeneration, 0);
});

await check("positional replacement is the surface CAS primitive", () => {
  const { session, u1, a1, t1, u2, a2 } = buildSession();
  const before = [...session.surface.nodes];
  const checkpoint = compactFirstExchange(session, u1, a1, t1);
  assert.deepEqual([...session.surface.nodes], [checkpoint.seq, u2.seq, a2.seq]);
  assert.equal(session.surface.replaceGeneration, 1);
  assert.deepEqual(before.length, 5);
  // replacement copies are model-only: original append-origin events remain
  // in the log (append-only), only the surface projection shadows them.
  assert.equal(session.events.length, 13);
});

await check("replaceGeneration is monotonic and generation-aware", () => {
  const { session, u1, a1, t1, u2, a2 } = buildSession();
  assert.equal(session.surface.replaceGeneration, 0);
  compactFirstExchange(session, u1, a1, t1);
  assert.equal(session.surface.replaceGeneration, 1);
  session.append("user/message", createUserMessage({ content: text("m2"), source: { kind: "user" } }), {
    surfaceOp: { op: "replace", start: u2.seq, end: a2.seq },
    sourceEventSeqs: [u2.seq, a2.seq],
  });
  assert.equal(session.surface.replaceGeneration, 2);
});

await check("foldSurface replay is deterministic (replay invariant)", () => {
  const { session, u1, a1, t1 } = buildSession();
  compactFirstExchange(session, u1, a1, t1);
  const first = foldSurface(session.events);
  const second = foldSurface(session.events);
  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes, [...session.surface.nodes]);
  assert.equal(first.replacements.length, 1);
  assert.deepEqual(first.replacements[0].shadowedSeqs, [u1.seq, a1.seq, t1.seq]);
});

await check("a resumed session (seed replay) reproduces the same surface", () => {
  const { session, u1, a1, t1 } = buildSession();
  compactFirstExchange(session, u1, a1, t1);
  const revived = Session.fromRestore(session.id, session.events, session.header);
  assert.deepEqual([...revived.surface.nodes], [...session.surface.nodes]);
  assert.equal(revived.surface.replaceGeneration, session.surface.replaceGeneration);
});

await check("surface-eligible event without surfaceOp is rejected", () => {
  const session = Session.create("spike-0-no-marker");
  assert.throws(() => {
    session.append("user/message", createUserMessage({ content: text("x"), source: { kind: "user" } }));
  }, /requires a surfaceOp marker/);
});

await check("non-surface event with surfaceOp is rejected", () => {
  const session = Session.create("spike-0-wrong-marker");
  assert.throws(() => {
    session.append("turn/start", { turn: 1 }, { surfaceOp: "append" });
  }, /not surface-eligible and cannot carry surfaceOp/);
});

await check("replace with missing shadowed coverage is rejected", () => {
  const session = Session.create("spike-0-bad-coverage");
  const u = session.append(
    "user/message",
    createUserMessage({ content: text("a"), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({ content: text("b"), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  assert.throws(() => {
    session.append("user/message", createUserMessage({ content: text("ckpt"), source: { kind: "plugin", plugin: "compact" } }), {
      surfaceOp: { op: "replace", start: u.seq, end: u.seq + 1 },
      sourceEventSeqs: [u.seq], // incomplete: misses the second node
    });
  });
});

await check("replace with out-of-range start/end is rejected", () => {
  const session = Session.create("spike-0-bad-range");
  const u = session.append(
    "user/message",
    createUserMessage({ content: text("a"), source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  assert.throws(() => {
    session.append("user/message", createUserMessage({ content: text("ckpt"), source: { kind: "plugin", plugin: "compact" } }), {
      surfaceOp: { op: "replace", start: u.seq, end: u.seq + 9 },
      sourceEventSeqs: [u.seq],
    });
  });
});

await check("tool pairing boundaries survive compaction replacement", () => {
  const { session, u1, a1, t1, u2, a2 } = buildSession();
  const checkpoint = compactFirstExchange(session, u1, a1, t1);
  const { nodes } = foldSurface(session.events);
  // ckpt + u2 + assistant2; the replaced range's tool pair is fully shadowed.
  assert.deepEqual(nodes, [checkpoint.seq, u2.seq, a2.seq]);
});

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${r.name}`);
    console.log(`      ${r.error?.message ?? r.error}`);
  }
}
console.log(`\nspike-0: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
