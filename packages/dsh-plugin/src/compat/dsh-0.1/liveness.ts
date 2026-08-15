/**
 * compat/dsh-0.1/liveness — cross-process migration guard marker.
 *
 * The Magic core refuses to migrate the shared SQLite while another harness
 * process is live (storage-db migration-on-open guard). The project constraint
 * forbids editing core, so the DSH adapter WRITES the same RpcPortFileRecord
 * shape the guard already scans (`<storageDir>/rpc/<projectHash>/port-<pid>.json`),
 * making the guard conservatively treat a live DSH process as a live server and
 * refuse migration (PLAN §2 跨进程安全; recorded deviation in PHASE-0.md).
 *
 * This module is I/O-light by design: writing the record is the adapter's only
 * contribution; the guard itself stays core-owned.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The RpcPortFileRecord shape the core guard parses (rpc-utils.ts). */
export interface RpcPortFileRecord {
  readonly port: number;
  readonly pid: number;
  readonly started_at: number;
  readonly token?: string;
  readonly instance_id?: string;
}

/** Project hash used by rpc-utils: sha256 of the project path, first 16 hex. */
export function projectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export interface DshLivenessMarkerOptions {
  readonly storageDir: string;
  readonly projectPath: string;
  readonly port: number;
  readonly pid?: number;
  readonly instanceId?: string;
  readonly startedAt?: number;
}

/** Absolute path of the marker file for one process. */
export function markerPath(opts: {
  readonly storageDir: string;
  readonly projectPath: string;
  readonly pid: number;
}): string {
  return join(opts.storageDir, "rpc", projectHash(opts.projectPath), `port-${opts.pid}.json`);
}

/** Write the liveness marker (idempotent; caller removes on shutdown). */
export function writeDshLivenessMarker(opts: DshLivenessMarkerOptions): string {
  const pid = opts.pid ?? process.pid;
  const record: RpcPortFileRecord = {
    port: opts.port,
    pid,
    started_at: opts.startedAt ?? Date.now(),
    ...(opts.instanceId === undefined ? {} : { instance_id: `dsh:${opts.instanceId}` }),
  };
  const path = markerPath({
    storageDir: opts.storageDir,
    projectPath: opts.projectPath,
    pid,
  });
  mkdirSync(join(opts.storageDir, "rpc", projectHash(opts.projectPath)), {
    recursive: true,
  });
  writeFileSync(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  return path;
}

/** Remove the liveness marker (best-effort). */
export function removeDshLivenessMarker(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup; a stale marker only delays a future migration.
  }
}
