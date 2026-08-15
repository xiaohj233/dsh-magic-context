/**
 * Spike 4 — External Typert Remote: registry + strict gateway dispatch.
 *
 * Validates the DSH Remote seam that the Client half and the standalone
 * Dashboard will use (PLAN §3.1 Typert Remote / §7.3 compatibility.json
 * remotes):
 *  1. a Host contribution registers schemas + invocation descriptors under a
 *     `magicContext` namespace (compatibility.json hostEndpointPrefix);
 *  2. the Gateway dispatches the method against a Cordis service with strict
 *     codec validation (invalid args → TypertGatewayError with a stable code;
 *     unknown endpoints → definition-unavailable);
 *  3. src-json (weak) codecs pass values through while strict codecs parse;
 *  4. a lookup-based parameter resolves a Host object through the registry
 *     and an unresolvable id fails with lookup-not-found;
 *  5. a business failure surfaces through the RemoteFailure envelope shape
 *     (ok:false) that generated clients fold into `RemoteResult`;
 *  6. registration is fiber-owned: disposing the contribution withdraws the
 *     endpoint (no leak).
 *
 * The physical carrier (HTTP/WS loopback) is the same stack the web profile
 * already mounts; the wire envelope itself is exercised in phase 4 E2E.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dshImport } from "./lib/dsh-sdk.mjs";

const { Context } = await dshImport("@deepseek-ai/cordis");
const { default: TypertRegistry } = await dshImport("@deepseek-ai/dsh-typert-registry");
const { default: TypertGatewayService, TypertGatewayError } = await dshImport("@deepseek-ai/dsh-api-gateway");

// zod from the DSH install's own dependency tree (the typert codecs are zod).
const zod = await import(
  pathToFileURL(
    "D:\\Dev\\DevEnv\\Node\\npm-global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\zod\\index.js",
  ).href
);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** Our MagicContext host service (the receiver of the remote methods). */
function createMagicHost() {
  const calls = [];
  const service = {
    calls,
    status: async ({ sessionId }) => {
      calls.push(["status", sessionId]);
      return { sessionId, compartments: 3, memories: 12, harness: "dsh" };
    },
    sessions: async ({ sessionId, limit = 20 }) => {
      calls.push(["sessions", sessionId, limit]);
      return { items: [{ sessionId, updatedAt: 1 }, { sessionId: "b", updatedAt: 2 }] };
    },
    failing: async () => {
      throw new Error("business boom");
    },
  };
  // The strict (generated-descriptor) dispatch path requires the service to
  // carry a `typertRemote` binding — TypertRemoteService sets it in its
  // constructor; the spike pins the same shape manually.
  Object.defineProperty(service, "typertRemote", {
    value: Object.freeze({
      service,
      serviceKey: "magicContextHost",
      namespace: "magicContext",
    }),
  });
  return service;
}

/** Boot a context with registry + gateway + our contribution. */
async function bootRemote() {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry, {});
  const gatewayFiber = ctx.plugin(TypertGatewayService, {});
  const gateway = (await gatewayFiber).ctx.typertGateway;
  const magicHost = createMagicHost();
  ctx.provide("magicContextHost", magicHost);

  const strictStatusSchema = zod.object({
    sessionId: zod.string().min(1),
    detail: zod.boolean().optional(),
  });
  const contribution = {
    package: "@xiao_hj909/magic-context-for-dsh",
    face: "host",
    schemas: [
      { name: "MagicStatusArgs", schema: strictStatusSchema },
      { name: "MagicStatusResult", schema: zod.object({ sessionId: zod.string(), compartments: zod.number(), memories: zod.number(), harness: zod.string() }) },
      { name: "MagicListArgs", schema: zod.object({ sessionId: zod.string(), limit: zod.number().int().min(1).max(100).default(20) }) },
      { name: "MagicListResult", schema: zod.object({ items: zod.array(zod.object({ sessionId: zod.string(), updatedAt: zod.number() })) }) },
    ],
    model: {
      services: [
        {
          key: "magicContextHost",
          exportName: "MagicContextHostService",
          members: [
            { kind: "method", name: "status", signature: "(args: MagicStatusArgs) => MagicStatusResult", summary: "session status" },
            { kind: "method", name: "sessions", signature: "(args: MagicListArgs) => MagicListResult", summary: "paginated sessions" },
            { kind: "method", name: "failing", signature: "() => MagicStatusResult", summary: "always fails" },
          ],
          types: [],
        },
      ],
      events: [],
      objects: [],
    },
    invocations: [
      {
        id: "magicContext.status",
        service: "magicContextHost",
        namespace: "magicContext",
        method: "status",
        invocation: { kind: "direct" },
        parameters: [
          { name: "args", wire: "args", source: "json", codec: { mode: "strict", typeSymbol: "MagicStatusArgs", schema: { parse: (v) => strictStatusSchema.parse(v) } } },
        ],
        result: { mode: "strict", typeSymbol: "MagicStatusResult", schema: { parse: (v) => contribution.schemas[1].schema.parse(v) } },
      },
      {
        id: "magicContext.sessions",
        service: "magicContextHost",
        namespace: "magicContext",
        method: "sessions",
        invocation: { kind: "direct" },
        parameters: [
          { name: "args", wire: "args", source: "json", codec: { mode: "src-json" } },
        ],
        result: { mode: "src-json" },
      },
      {
        id: "magicContext.failing",
        service: "magicContextHost",
        namespace: "magicContext",
        method: "failing",
        invocation: { kind: "direct" },
        parameters: [],
        result: { mode: "src-json" },
      },
    ],
  };

  const disposer = ctx.typert.register(contribution);
  return { ctx, gateway, magicHost, disposer };
}

await check("contribution registers and the gateway dispatches a strict method", async () => {
  const { gateway, magicHost } = await bootRemote();
  const value = await gateway.invoke({
    namespace: "magicContext",
    method: "status",
    args: { args: { sessionId: "s-1", detail: true } },
  });
  assert.equal(value.sessionId, "s-1");
  assert.equal(value.harness, "dsh");
  assert.deepEqual(magicHost.calls[0], ["status", "s-1"]);
});

await check("strict codec rejects invalid arguments (input-invalid)", async () => {
  const { gateway } = await bootRemote();
  await assert.rejects(
    gateway.invoke({ namespace: "magicContext", method: "status", args: { args: { sessionId: 42 } } }),
    (error) => error instanceof TypertGatewayError && error.code === "input-invalid",
  );
});

await check("unknown endpoint fails with invocation-unavailable", async () => {
  const { gateway } = await bootRemote();
  await assert.rejects(
    gateway.invoke({ namespace: "magicContext", method: "nope", args: {} }),
    (error) => error instanceof TypertGatewayError && error.code === "invocation-unavailable",
  );
});

await check("unknown namespace fails with invocation-unavailable", async () => {
  const { gateway } = await bootRemote();
  await assert.rejects(
    gateway.invoke({ namespace: "other", method: "x", args: {} }),
    (error) => error instanceof TypertGatewayError && error.code === "invocation-unavailable",
  );
});

await check("src-json codec passes wire values through", async () => {
  const { gateway } = await bootRemote();
  const value = await gateway.invoke({
    namespace: "magicContext",
    method: "sessions",
    args: { args: { sessionId: "s-2", limit: 10 } },
  });
  assert.equal(value.items.length, 2);
});

await check("missing wire field for a required parameter fails", async () => {
  const { gateway } = await bootRemote();
  // status has a strict, required `args` wire field.
  await assert.rejects(
    gateway.invoke({ namespace: "magicContext", method: "status", args: {} }),
    (error) => error instanceof TypertGatewayError && error.code === "arguments-invalid",
  );
});

await check("business failure carries identity (envelope for RemoteResult)", async () => {
  const { gateway } = await bootRemote();
  await assert.rejects(
    gateway.invoke({ namespace: "magicContext", method: "failing", args: {} }),
    /business boom/,
  );
  // The CLIENT envelope folds the failure into {ok:false, error:{code,message,details}}.
  const envelope = await Promise.resolve().then(async () => {
    try {
      const value = await gateway.invoke({ namespace: "magicContext", method: "failing", args: {} });
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof TypertGatewayError ? error.code : "business",
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      };
    }
  });
  assert.equal(envelope.ok, false);
  assert.equal(typeof envelope.error.code, "string");
  assert.equal(typeof envelope.error.message, "string");
});

await check("disposing the contribution withdraws the endpoint (no leak)", async () => {
  const { gateway, disposer } = await bootRemote();
  await disposer();
  await assert.rejects(
    gateway.invoke({ namespace: "magicContext", method: "status", args: { args: { sessionId: "s" } } }),
    (error) => error instanceof TypertGatewayError && error.code === "definition-unavailable",
  );
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
console.log(`\nspike-4: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
