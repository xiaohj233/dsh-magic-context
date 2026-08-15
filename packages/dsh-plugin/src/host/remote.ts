/**
 * host/remote — the `magicContext` Typert Remote namespace (Phase 2 slice C).
 *
 * The persistent-bundle client→host channel is NOT the dynamic-package
 * `harness.handle` / `host.call` pair (dsh-reference §G.1, §F.4): a persistent
 * bundle's browser half reaches the host through the Typert Gateway over the
 * shared `/api` RPC channel (`ctx.connection.rpc.call('/api',
 * 'magicContext/status', { args })`), and the host half registers a strict
 * InvocationDescriptor with `ctx.typert.register(...)`. This module registers
 * the `magicContext/status` endpoint against the live `magicContextHost`
 * service, with no runtime dependency beyond Cordis + the core — the
 * typertRemote binding is hand-built (the protocol package's frozen
 * `{service, serviceKey, namespace}` shape) and the descriptor uses src-json
 * codecs, so no decorators or generated artifacts are involved.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
  LATEST_SUPPORTED_VERSION,
  getPersistedSchemaVersion,
} from "@magic-context/core/features/magic-context/storage-db";
import type TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/typert";
import type { MagicContextHostService } from "../index";
import { MAGIC_CONTEXT_PACKAGE } from "../doctor/env";

/** Wire endpoint name (client calls `magicContext/status`). */
export const MAGIC_STATUS_METHOD = "status";

/** Wire endpoint name for the per-session diagnostics (Phase 4). */
export const MAGIC_DIAGNOSTICS_METHOD = "diagnostics";

/** JSON-safe per-session diagnostics (outbox/tags/compartments/meta). */
export interface MagicSessionDiagnostics {
  readonly sessionId: string;
  readonly outbox: {
    readonly pending: number;
    readonly applied: number;
    readonly committed: number;
    readonly abandoned: number;
  };
  readonly tags: { readonly active: number; readonly dropped: number };
  readonly compartments: number;
  readonly meta: { readonly lastContextPercentage?: number; readonly hasM0: boolean };
}

/** JSON-safe status summary served to the browser card / header action. */
export interface MagicStatus {
  readonly package: string;
  readonly harness: "dsh";
  readonly storage: {
    readonly ok: boolean;
    readonly schemaVersion?: number;
    readonly latestSupported: number;
    readonly reason?: "schema-fence" | "migration-guard" | "error";
    readonly detail?: string;
  };
  readonly config: { readonly path: string; readonly exists: boolean };
  readonly preset: { readonly dir: string; readonly exists: boolean };
  readonly sessionId?: string | null;
}

function dshHome(): string {
  const explicit = process.env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return join(homedir(), ".dsh");
}

/** Cordis Service backing the `magicContext` Remote namespace. */
export class MagicContextRemoteService extends Service {
  /** Hand-built Typert Gateway binding (protocol `bindTypertRemote` shape). */
  readonly typertRemote: Readonly<{
    service: MagicContextRemoteService;
    serviceKey: string;
    namespace: string;
  }>;

  constructor(
    ctx: Context,
    private readonly host: MagicContextHostService,
  ) {
    super(ctx, "magicContextRemote");
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: "magicContextRemote",
      namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    });
  }

  /** `magicContext/status` — current adapter state for one session. */
  async status(args: { sessionId?: string } = {}): Promise<MagicStatus> {
    const bootstrap = await this.host.ready;
    const storage = (() => {
      if (bootstrap.kind !== "ok") {
        return {
          ok: false,
          latestSupported: LATEST_SUPPORTED_VERSION,
          reason: bootstrap.reason,
          detail: safeDetail(bootstrap.detail),
        };
      }
      return {
        ok: true,
        schemaVersion: getPersistedSchemaVersion(bootstrap.db),
        latestSupported: LATEST_SUPPORTED_VERSION,
      };
    })();
    const home = dshHome();
    const configPath = resolveCortexKitUserConfigPath();
    const presetDir = join(home, ".agent-presets", "magic-standard");
    return {
      package: MAGIC_CONTEXT_PACKAGE,
      harness: "dsh",
      storage,
      config: { path: configPath, exists: existsSync(configPath) },
      preset: { dir: presetDir, exists: existsSync(join(presetDir, "agent.cordis.yml")) },
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    };
  }

  /** `magicContext/diagnostics` — per-session context-management state. */
  async diagnostics(args: { sessionId: string }): Promise<MagicSessionDiagnostics> {
    // Security: bound the session id (Remote 限额 — PLAN §11) and never echo
    // unvalidated input into SQL beyond the bound parameter.
    const sessionId = String(args?.sessionId ?? "").slice(0, 512);
    const empty = {
      sessionId,
      outbox: { pending: 0, applied: 0, committed: 0, abandoned: 0 },
      tags: { active: 0, dropped: 0 },
      compartments: 0,
      meta: { hasM0: false },
    };
    if (sessionId.length === 0) return empty;
    const bootstrap = await this.host.ready;
    if (bootstrap.kind !== "ok") return empty;
    const db = bootstrap.db;
    const count = (sql: string, ...params: (string | number)[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;
    try {
      const outbox = {
        pending: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'pending'",
          sessionId,
        ),
        applied: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'applied'",
          sessionId,
        ),
        committed: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'committed'",
          sessionId,
        ),
        abandoned: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'abandoned'",
          sessionId,
        ),
      };
      const tags = {
        active: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'",
          sessionId,
        ),
        dropped: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'",
          sessionId,
        ),
      };
      const compartments = count(
        "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
        sessionId,
      );
      const metaRow = db
        .prepare(
          "SELECT last_context_percentage, cached_m0_bytes FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | { last_context_percentage: number | null; cached_m0_bytes: Uint8Array | null }
        | undefined;
      return {
        sessionId,
        outbox,
        tags,
        compartments,
        meta: {
          ...(typeof metaRow?.last_context_percentage === "number"
            ? { lastContextPercentage: metaRow.last_context_percentage }
            : {}),
          hasM0: metaRow?.cached_m0_bytes !== null && metaRow?.cached_m0_bytes !== undefined,
        },
      };
    } catch {
      return empty;
    }
  }
}

function safeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** Strict descriptor for `magicContext/status` (src-json codecs, no schemas). */
export function magicStatusDescriptor(): InvocationDescriptor {
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
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/** Strict descriptor for `magicContext/diagnostics` (Phase 4). */
export function magicDiagnosticsDescriptor(): InvocationDescriptor {
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
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/**
 * Provide the remote service and register the `magicContext/status`
 * contribution. Returns a disposer, or undefined when the Typert registry is
 * absent from this host plane (headless profiles) — callers must tolerate
 * that. Registration is fiber-owned: the contribution auto-withdraws when the
 * calling plugin is stopped or updated.
 */
export function registerMagicContextRemote(
  ctx: Context,
  host: MagicContextHostService,
): (() => void) | undefined {
  const typert = ctx.get("typert") as TypertRegistry | undefined;
  if (typert === undefined) return undefined;

  const service = new MagicContextRemoteService(ctx, host);
  // The Service constructor provides `magicContextRemote`; no explicit
  // ctx.provide here (a second provide on the same fiber throws).

  const contribution: TypertContribution = {
    package: MAGIC_CONTEXT_PACKAGE,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [magicStatusDescriptor(), magicDiagnosticsDescriptor()],
  };
  const disposer = typert.register(contribution);
  return () => {
    void disposer();
  };
}
