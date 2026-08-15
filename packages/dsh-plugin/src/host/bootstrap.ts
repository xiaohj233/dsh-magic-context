/**
 * Host bootstrap — the DSH adapter's startup sequence (PLAN §3.1
 * MagicContextHostService responsibilities: shared SQLite, schema fence,
 * cross-process lease/liveness, config authority).
 *
 * Mirrors the Pi adapter's boot order (magic-reference §5.1):
 *   1. `setDshHarness()` before any DB write;
 *   2. config-location migration (core, harness-agnostic, fail-open);
 *   3. SQLite PRAGMA tuning config;
 *   4. DSH liveness marker BEFORE opening the shared DB, so the core
 *      migration-on-open guard conservatively treats this process as live;
 *   5. `openDatabaseAsync()` — null means schema-fence or migration-guard
 *      refusal → fail-closed decision by the caller.
 */
import { join } from "node:path";
import {
  migrateMagicContextConfigLocations,
  type ConfigMigrationLogger,
} from "@magic-context/core/config/migrate-config-location";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
  applySqliteTuningPragmas,
  getMigrationOnOpenRefusal,
  getSchemaFenceRejection,
  openDatabaseAsync,
  setSqlitePragmaConfig,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  canonicalSessionKey,
  setDshHarness,
} from "dsh-magic-context-adapter";
import {
  markerPath,
  removeDshLivenessMarker,
  writeDshLivenessMarker,
} from "../compat/dsh-0.1/liveness";
import { initializeDshAdapterTables } from "../agent/outbox";

export type { Database };

/** Outcome of the DSH storage bootstrap. */
export type DshStorageBootstrap =
  | {
      readonly kind: "ok";
      readonly db: Database;
      readonly storageDir: string;
      readonly livenessPath: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: "schema-fence" | "migration-guard";
      readonly detail: unknown;
    };

export interface DshBootstrapOptions {
  /** Workspace/directory identity used for the config migration + marker. */
  readonly directory: string;
  /** Loopback port the host exposes (used by the liveness marker). */
  readonly port: number;
  /** Explicit shared DB path override (tests); defaults to the CortexKit path. */
  readonly dbPath?: string;
  /** Storage directory override (tests). */
  readonly storageDirOverride?: string;
  /** SHA-256 first-8-hex home hash for canonical session keys. */
  readonly homeHash: string;
  /** Logger sink. */
  readonly log?: (message: string) => void;
}

/**
 * Run the DSH storage bootstrap. Idempotent per process: subsequent calls
 * reuse the already-open DB handle (core caches by path).
 */
export async function bootstrapDshStorage(
  opts: DshBootstrapOptions,
): Promise<DshStorageBootstrap> {
  const log = opts.log ?? (() => {});
  // 1. Lock the harness identity before any DB write.
  setDshHarness();

  // 2. Config-location migration (fail-open by design).
  const migrationLogger: ConfigMigrationLogger = {
    warn: (message: string) => log(`[magic-context] config migration: ${message}`),
  };
  const migrationWarnings = migrateMagicContextConfigLocations(opts.directory, migrationLogger);
  for (const warning of migrationWarnings) {
    log(`[magic-context] config migration warning: ${warning}`);
  }

  // 3. PRAGMA tuning (defaults: 64 MB cache, no mmap).
  setSqlitePragmaConfig({ cacheSizeMb: 64, mmapSizeMb: 0 });

  // 4. Open the shared DB (schema fence + migration guard enforced by core).
  //    The liveness marker is written AFTER a successful open (mirroring the
  //    OpenCode server, which publishes its port file only once the DB is
  //    migrated) — otherwise our own marker would make the guard refuse our
  //    own migration. Once live, the marker makes the guard conservatively
  //    refuse a concurrent migration by any other DSH/OpenCode/Pi process.
  const storageDir = opts.storageDirOverride ?? getMagicContextStorageDir();
  const ownLivenessPath = markerPath({
    storageDir,
    projectPath: opts.directory,
    pid: process.pid,
  });
  try {
    const db = await openDatabaseAsync(
      opts.dbPath === undefined ? undefined : { dbPath: opts.dbPath },
    );
    if (db === null) {
      const fence = getSchemaFenceRejection();
      const guard = getMigrationOnOpenRefusal();
      if (fence !== null) {
        return { kind: "refused", reason: "schema-fence", detail: fence };
      }
      if (guard !== null) {
        return { kind: "refused", reason: "migration-guard", detail: guard };
      }
      return { kind: "refused", reason: "migration-guard", detail: "open returned null" };
    }
    applySqliteTuningPragmas(db);
    // Adapter-owned tables (outbox saga + compaction marker + meta). The core
    // schema fence only tracks schema_migrations; these dsh_* tables are the
    // adapter's own persistence and never touch core migrations.
    initializeDshAdapterTables(db);
    const markerPathOut = writeDshLivenessMarker({
      storageDir,
      projectPath: opts.directory,
      port: opts.port,
      instanceId: process.pid.toString(16),
    });
    log(`[magic-context] dsh liveness marker: ${markerPathOut}`);
    return { kind: "ok", db, storageDir, livenessPath: markerPathOut };
  } catch (error) {
    removeDshLivenessMarker(ownLivenessPath);
    throw error;
  }
}

/** Canonical Magic session key for a DSH session under this home. */
export function dshCanonicalSessionKey(homeHash: string, dshSessionId: string): string {
  return canonicalSessionKey(homeHash, dshSessionId);
}

/** Convenience: the shared DB file path inside a storage dir (tests). */
export function contextDbPath(storageDir: string): string {
  return join(storageDir, "context.db");
}
