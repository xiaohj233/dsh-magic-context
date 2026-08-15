/**
 * Spike 2 — First-request gate: agent/pre-step waterfall with `prepend`.
 *
 * Validates the listener mechanics behind PLAN §4.1 ("首步准入") and §3.1
 * (MagicContextAgentPlugin pre-step gate):
 *
 *  1. `ctx.on('agent/pre-step', …, { prepend: true })` places our listener
 *     OUTERMOST: it runs before downstream listeners and may await the
 *     DB/config/schema fence before calling `next()`;
 *  2. the final PreStepDecision is the outermost listener's return value —
 *     our gate can append the m0 knowledge baseline to `messages` (SOFT+
 *     tail append channel; the request itself is never rewritten);
 *  3. pass-through and reject passthrough preserve downstream decisions;
 *  4. a listener that never calls `next()` vetoes the step (fail-closed path).
 *
 * Uses a bare Cordis context: scope filtering is installed by dsh-scope, which
 * a plain Context does not mount, so all listeners receive the dispatch. The
 * listener contract exercised here is exactly what the agent-scoped plugin
 * will register.
 */
import assert from "node:assert/strict";
import { dshImport } from "./lib/dsh-sdk.mjs";

const { Context } = await dshImport("@deepseek-ai/cordis");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** Dispatch one agent/pre-step waterfall with a synthetic payload. */
async function dispatchPreStep(ctx, messages, next) {
  const payload = {
    agent: { id: "spike-2-agent" },
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  };
  const innermost = next ?? (async () => ({ kind: "enter", messages }));
  return ctx.waterfall({}, "agent/pre-step", payload, innermost);
}

await check("prepend listener runs outermost (before downstream)", async () => {
  const ctx = new Context();
  const order = [];
  // Downstream (registered first, must run second).
  ctx.on("agent/pre-step", async (payload, next) => {
    order.push("downstream");
    return next();
  });
  // Magic gate (prepend → outermost).
  ctx.on("agent/pre-step", async (payload, next) => {
    order.push("gate");
    const decision = await next();
    return decision;
  }, { prepend: true });
  const decision = await dispatchPreStep(ctx, []);
  assert.deepEqual(order, ["gate", "downstream"]);
  assert.equal(decision.kind, "enter");
});

await check("first-request gate awaits the fence, then appends the m0 baseline", async () => {
  const ctx = new Context();
  const events = [];
  let fenceResolve;
  const fence = new Promise((resolve) => {
    fenceResolve = resolve;
  });
  // Our gate: wait for DB/config/schema fence, then inject the baseline.
  ctx.on("agent/pre-step", async (payload, next) => {
    events.push("gate-enter");
    await fence; // DB/config/schema fence
    events.push("gate-fence-ready");
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    return {
      kind: "enter",
      messages: [
        ...decision.messages,
        { id: "m0-baseline", role: "user", content: "knowledge baseline" },
      ],
    };
  }, { prepend: true });
  // Downstream listener: must NOT see the request until the gate passed.
  ctx.on("agent/pre-step", async (payload, next) => {
    events.push("downstream");
    return next();
  });
  const pending = dispatchPreStep(ctx, [{ id: "u1", role: "user", content: "hi" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ["gate-enter"], "downstream must not run before the fence");
  fenceResolve();
  const decision = await pending;
  assert.deepEqual(events, ["gate-enter", "gate-fence-ready", "downstream"]);
  assert.equal(decision.kind, "enter");
  assert.deepEqual(decision.messages.map((m) => m.id), ["u1", "m0-baseline"]);
});

await check("gate passes through when no injection applies", async () => {
  const ctx = new Context();
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    return decision;
  }, { prepend: true });
  ctx.on("agent/pre-step", async (payload, next) => next(), {});
  const decision = await dispatchPreStep(ctx, [{ id: "u1", role: "user", content: "hi" }]);
  assert.equal(decision.kind, "enter");
  assert.deepEqual(decision.messages.map((m) => m.id), ["u1"]);
});

await check("reject decision passes through the outer gate", async () => {
  const ctx = new Context();
  ctx.on("agent/pre-step", async (payload, next) => next(), { prepend: true });
  ctx.on("agent/pre-step", async () => ({ kind: "reject" }), {});
  const decision = await dispatchPreStep(ctx, []);
  assert.equal(decision.kind, "reject");
});

await check("a gate that never calls next() vetoes the step (fail closed)", async () => {
  const ctx = new Context();
  let downstreamRan = false;
  ctx.on("agent/pre-step", async () => {
    downstreamRan = true;
    return { kind: "enter", messages: [] };
  }, { prepend: true });
  // The vetoing gate: does not call next() and returns nothing. The chain
  // result is undefined, i.e. the step is rejected.
  const gate = ctx.on("agent/pre-step", async () => {}, { prepend: true });
  const decision = await dispatchPreStep(ctx, []);
  assert.equal(decision, undefined);
  assert.equal(downstreamRan, false);
  gate();
});

await check("listener disposal is fiber-owned (no leaks after dispose)", async () => {
  const ctx = new Context();
  let calls = 0;
  const fiber = ctx.plugin({
    apply(pluginCtx) {
      pluginCtx.on("agent/pre-step", async (payload, next) => {
        calls += 1;
        return next();
      }, { prepend: true });
    },
  });
  await fiber;
  await dispatchPreStep(ctx, []);
  assert.equal(calls, 1);
  await fiber.dispose();
  await dispatchPreStep(ctx, []);
  assert.equal(calls, 1, "listener must be removed with its fiber");
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
console.log(`\nspike-2: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
