/**
 * Spike 5 — Minimal worker provider seam (PLAN §5.13 / D7).
 *
 * Validates the DSH-native primitives a tool-requiring Sidekick/maintenance
 * worker will be composed from, without any dependency on undeclared
 * AgentOptions fields:
 *  1. `tools.restrict({allow:[...]})` — allowlist semantics: named tools stay,
 *     everything else vanishes from the visible catalog AND refuses to
 *     execute; unknown names fail loudly (the subagent `toolFilter` applies
 *     exactly this in the child's creation window);
 *  2. `resolveChildDepth` — depth = parent + 1, persisted header as the
 *     monotone floor, and a `maxDepth` cap rejecting deeper children
 *     (`SubagentDepthError`) so a worker can be pinned;
 *  3. `SubagentRuntime.start` capability validation — a provider without the
 *     `toolFilter`/`depthLimit` capabilities rejects such a request with a
 *     typed error (fail loud, no silent degradation);
 *  4. `captureDelegatedPolicyOverrides` — a delegated child's approval policy
 *     is pinned to 'never' (no inherited ask surface), sandbox override
 *     captured from the parent;
 *  5. worker isolation markers are just data: a child session can be stamped
 *     with its own delegation metadata without touching the parent.
 */
import assert from "node:assert/strict";
import { dshImport } from "./lib/dsh-sdk.mjs";

const { Context } = await dshImport("@deepseek-ai/cordis");
const { createScope } = await dshImport("@deepseek-ai/dsh-scope");
const {
  defineTool,
  default: ToolRuntime,
} = await dshImport("@deepseek-ai/dsh-tools");
const { default: SystemPrompt } = await dshImport("@deepseek-ai/dsh-system-prompt");
const {
  default: SubagentRuntime,
  SubagentError,
  resolveChildDepth,
  SubagentDepthError,
  captureDelegatedPolicyOverrides,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} = await dshImport("@deepseek-ai/dsh-subagent");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** Stub parent agent: a session header carrying the durable delegation depth. */
function stubParent(delegationDepth = 0) {
  return {
    id: `parent-${delegationDepth}`,
    session: {
      id: `parent-${delegationDepth}`,
      header: {
        id: `parent-${delegationDepth}`,
        cwd: "C:\\work",
        delegationDepth,
      },
      surface: { nodes: [], replaceGeneration: 0 },
      events: [],
    },
    options: { provider: "deepseek-official", model: "deepseek-v4-flash" },
  };
}

const OUT = { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "ok" }] };
const readTool = defineTool({
  name: "read",
  description: "read a file",
  parameters: { path: { type: "string", required: true } },
  output: OUT,
  async execute() {
    return { content: [{ type: "text", text: "file contents" }] };
  },
});
const writeTool = defineTool({
  name: "write",
  description: "write a file",
  parameters: { path: { type: "string", required: true }, content: { type: "string" } },
  output: OUT,
  async execute() {
    return { content: [{ type: "text", text: "wrote" }] };
  },
});
const shellTool = defineTool({
  name: "bash",
  description: "run a shell command",
  parameters: { command: { type: "string", required: true } },
  output: OUT,
  async execute() {
    return { content: [{ type: "text", text: "$" }] };
  },
});

await check("allowlist restriction keeps only the named tools", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { persona: "" });
  const fiber = ctx.plugin(ToolRuntime, {});
  const tools = (await fiber).ctx.tools;
  // Global registration (host plane), like the base composition's tools.
  const disposers = [readTool, writeTool, shellTool].map((t) => tools.register(t));
  // Agent scope: the child's creation window. The agent OBJECT is the ScopeKey
  // the tool registry routes on (createExecution passes exec.agent as the scope).
  const agent = { ...stubParent(), ctx: undefined };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  try {
    assert.deepEqual(tools.schemas().map((t) => t.name).sort(), ["bash", "read", "write"]);
    const scopedTools = scope.ctx.get("tools");
    const lift = scopedTools.restrict({ allow: ["read"] });
    assert.deepEqual(tools.schemas(agent).map((t) => t.name), ["read"]);
    assert.equal(tools.get("bash", agent), undefined, "masked tool reads as absent");
    assert.ok(tools.get("read", agent) !== undefined, "allowlisted tool stays visible");
    // The allowlisted tool still executes…
    const exec = (name, args) => tools.execute({
      callId: `call-${name}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
    const outcome = await exec("read", { path: "a.txt" });
    assert.equal(outcome.isError, false);
    // …and the masked one refuses to execute.
    const denied = await exec("bash", { command: "ls" });
    assert.equal(denied.isError, true);
    assert.ok(
      JSON.stringify(denied.error).includes("UNKNOWN_TOOL"),
      `masked tool must surface UNKNOWN_TOOL, got ${JSON.stringify(denied.error)}`,
    );
    lift();
    assert.equal(tools.schemas(agent).length, 3, "restriction must be liftable (fiber-owned)");
  } finally {
    disposers.forEach((d) => d());
    await scope.dispose();
    await fiber.dispose();
  }
});

await check("unknown tool names in a restriction fail loudly", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { persona: "" });
  const fiber = ctx.plugin(ToolRuntime, {});
  const tools = (await fiber).ctx.tools;
  tools.register(readTool);
  const scope = createScope(ctx, { agent: "spike-5-unknown" });
  try {
    assert.throws(
      () => scope.ctx.get("tools").restrict({ allow: ["read", "no-such-tool"] }),
      /no-such-tool/,
    );
  } finally {
    await scope.dispose();
    await fiber.dispose();
  }
});

await check("resolveChildDepth: child = parent + 1, cap enforced", async () => {
  assert.equal(resolveChildDepth(stubParent(0), undefined), 1);
  assert.equal(resolveChildDepth(stubParent(2), undefined), 3);
  assert.equal(resolveChildDepth(stubParent(0), 1), 1);
  assert.throws(
    () => resolveChildDepth(stubParent(1), 1),
    (error) => error instanceof SubagentDepthError && error.attemptedDepth === 2 && error.maxDepth === 1,
  );
});

await check("subagent start validates capabilities (fail loud, no silent degradation)", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(SubagentRuntime, {});
  const subagents = (await fiber).ctx.subagents;
  const bareProvider = {
    name: "bare",
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start(request) {
      throw new Error("should never be called");
    },
  };
  subagents.registerProvider(bareProvider);
  const request = {
    label: "magic-worker",
    prompt: [{ type: "text", text: "do the thing" }],
    parent: stubParent(0),
    signal: new AbortController().signal,
    toolFilter: { allow: ["read"] },
    maxDepth: 0,
  };
  await assert.rejects(
    subagents.start("bare", request),
    (error) => error instanceof SubagentError,
  );
  await fiber.dispose();
});

await check("provider with the capabilities accepts the same request shape", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(SubagentRuntime, {});
  const subagents = (await fiber).ctx.subagents;
  const capableProvider = {
    name: "capable",
    capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: true,
    async start(request) {
      // Descriptor is resolved before dispatch; the worker composition is data.
      assert.equal(request.descriptor.mode, "one-shot");
      assert.equal(request.descriptor.version, SUBAGENT_DESCRIPTOR_VERSION);
      assert.deepEqual(request.toolFilter, { allow: ["read"] });
      return {
        id: "child-1",
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: "completed" }),
        async dispose() {},
      };
    },
  };
  subagents.registerProvider(capableProvider);
  const run = await subagents.start("capable", {
    label: "magic-worker",
    prompt: [{ type: "text", text: "do the thing" }],
    parent: stubParent(0),
    signal: new AbortController().signal,
    toolFilter: { allow: ["read"] },
    maxDepth: 1,
    persona: "Magic maintenance worker",
  });
  const result = await run.result;
  assert.equal(result.stopReason, "completed");
  await fiber.dispose();
});

await check("delegated policy overrides pin approval to 'never'", async () => {
  const ctx = new Context();
  ctx.provide("approval", {});
  const parent = { ...stubParent(0), ctx };
  const overrides = captureDelegatedPolicyOverrides(parent);
  assert.equal(overrides.approvalPolicy, "never");
  assert.equal(overrides.sandboxMode, undefined);
});

await check("worker descriptor snapshot is versioned, detached data", async () => {
  const descriptor = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "spawn",
    label: "magic-context-worker",
  });
  assert.equal(descriptor.version, SUBAGENT_DESCRIPTOR_VERSION);
  assert.equal(descriptor.mode, "one-shot");
  assert.equal(descriptor.provider, "spawn");
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
console.log(`\nspike-5: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
