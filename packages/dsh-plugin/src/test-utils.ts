/**
 * DSH adapter test utilities (mirrors pi-plugin test-utils).
 *
 * The shared DB must be opened AFTER the harness identity is locked: tests
 * call `setDshHarness()` exactly like the Pi suite calls `setHarness("pi")`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";
import { setDshHarness } from "@xiao_hj909/magic-context-for-dsh-adapter";

export type { Database };

/** Create a temp storage directory for an isolated DSH test home. */
export function createTestStorageDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-magic-test-"));
}

/** Open a fresh, migrated test DB (harness locked to dsh first). */
export async function createTestDb(dbPath: string): Promise<Database> {
  setDshHarness();
  const db = await openDatabaseAsync({ dbPath });
  if (db === null) throw new Error("createTestDb: openDatabaseAsync refused");
  initializeDatabase(db);
  return db;
}
