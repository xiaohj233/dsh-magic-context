import {
  resolveCortexKitUserConfigPath
} from "./agent-64cec3zk.js";
import {
  LATEST_SUPPORTED_VERSION,
  getPersistedSchemaVersion
} from "./agent-hb5apgm1.js";
import"./agent-amr6x35h.js";
import"./agent-wckvcay0.js";

// src/host/remote.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { Service } from "@deepseek-ai/cordis";

// src/compat/dsh-0.1/typert.ts
var MAGIC_CONTEXT_REMOTE_NAMESPACE = "magicContext";

// src/doctor/env.ts
import { dirname, join } from "node:path";
var MAGIC_CONTEXT_PACKAGE = "@xiao_hj909/magic-context-for-dsh";
var STOCK_PRESET_REL = join("config", "agent-presets", "standard", "agent.cordis.yml");

// src/host/remote.ts
var MAGIC_STATUS_METHOD = "status";
var MAGIC_DIAGNOSTICS_METHOD = "diagnostics";
function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "")
    return explicit;
  return join2(homedir(), ".dsh");
}

class MagicContextRemoteService extends Service {
  host;
  typertRemote;
  constructor(ctx, host) {
    super(ctx, "magicContextRemote");
    this.host = host;
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: "magicContextRemote",
      namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE
    });
  }
  async status(args = {}) {
    const bootstrap = await this.host.ready;
    const storage = (() => {
      if (bootstrap.kind !== "ok") {
        return {
          ok: false,
          latestSupported: LATEST_SUPPORTED_VERSION,
          reason: bootstrap.reason,
          detail: safeDetail(bootstrap.detail)
        };
      }
      return {
        ok: true,
        schemaVersion: getPersistedSchemaVersion(bootstrap.db),
        latestSupported: LATEST_SUPPORTED_VERSION
      };
    })();
    const home = dshHome();
    const configPath = resolveCortexKitUserConfigPath();
    const presetDir = join2(home, ".agent-presets", "magic-standard");
    return {
      package: MAGIC_CONTEXT_PACKAGE,
      harness: "dsh",
      storage,
      config: { path: configPath, exists: existsSync(configPath) },
      preset: { dir: presetDir, exists: existsSync(join2(presetDir, "agent.cordis.yml")) },
      ...args.sessionId === undefined ? {} : { sessionId: args.sessionId }
    };
  }
  async diagnostics(args) {
    const sessionId = String(args?.sessionId ?? "").slice(0, 512);
    const empty = {
      sessionId,
      outbox: { pending: 0, applied: 0, committed: 0, abandoned: 0 },
      tags: { active: 0, dropped: 0 },
      compartments: 0,
      meta: { hasM0: false }
    };
    if (sessionId.length === 0)
      return empty;
    const bootstrap = await this.host.ready;
    if (bootstrap.kind !== "ok")
      return empty;
    const db = bootstrap.db;
    const count = (sql, ...params) => db.prepare(sql).get(...params).n;
    try {
      const outbox = {
        pending: count("SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'pending'", sessionId),
        applied: count("SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'applied'", sessionId),
        committed: count("SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'committed'", sessionId),
        abandoned: count("SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'abandoned'", sessionId)
      };
      const tags = {
        active: count("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'", sessionId),
        dropped: count("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'", sessionId)
      };
      const compartments = count("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?", sessionId);
      const metaRow = db.prepare("SELECT last_context_percentage, cached_m0_bytes FROM session_meta WHERE session_id = ?").get(sessionId);
      return {
        sessionId,
        outbox,
        tags,
        compartments,
        meta: {
          ...typeof metaRow?.last_context_percentage === "number" ? { lastContextPercentage: metaRow.last_context_percentage } : {},
          hasM0: metaRow?.cached_m0_bytes !== null && metaRow?.cached_m0_bytes !== undefined
        }
      };
    } catch {
      return empty;
    }
  }
}
function safeDetail(detail) {
  if (detail === undefined || detail === null)
    return;
  if (typeof detail === "string")
    return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
function magicStatusDescriptor() {
  return {
    id: "magicContext.status",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_STATUS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" }
      }
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1
    }
  };
}
function magicDiagnosticsDescriptor() {
  return {
    id: "magicContext.diagnostics",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_DIAGNOSTICS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" }
      }
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1
    }
  };
}
function registerMagicContextRemote(ctx, host) {
  const typert = ctx.get("typert");
  if (typert === undefined)
    return;
  const service = new MagicContextRemoteService(ctx, host);
  const contribution = {
    package: MAGIC_CONTEXT_PACKAGE,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [magicStatusDescriptor(), magicDiagnosticsDescriptor()]
  };
  const disposer = typert.register(contribution);
  return () => {
    disposer();
  };
}

// src/entries/remote.ts
var name = "magic-context-remote";
var inject = ["magicContextHost", "typert"];
function apply(ctx) {
  const host = ctx.get("magicContextHost");
  if (host === undefined) {
    throw new Error("magic-context-remote: magicContextHost service unavailable");
  }
  const disposer = registerMagicContextRemote(ctx, host);
  if (disposer === undefined) {
    ctx.logger?.info?.("[magic-context] typert registry absent; magicContext remote skipped");
    return;
  }
  ctx.effect(() => disposer);
}
var remote_default = { name, inject, apply };
export {
  name,
  inject,
  remote_default as default,
  apply
};
