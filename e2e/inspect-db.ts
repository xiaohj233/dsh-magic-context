import { Database } from "bun:sqlite";
import { join } from "node:path";
// Resolve against this repo (e2e/..) so the script is portable.
const root = new URL("..", import.meta.url).pathname.replace(/^([A-Za-z]):\//, "$1:/");
const db = new Database(
  join(root, "e2e", "scratch-data", "cortexkit", "magic-context", "context.db"),
  { readonly: true },
);
const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log("tables:", tables.length);
const s = db
  .query("SELECT session_id, harness, cached_m0_bytes IS NOT NULL AS has_m0 FROM session_meta")
  .all();
console.log("session_meta:", JSON.stringify(s));
const sp = db
  .query("SELECT session_id, harness, project_path FROM session_projects")
  .all();
console.log("session_projects:", JSON.stringify(sp));
const mig = db
  .query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
  .get();
console.log("schema:", JSON.stringify(mig));
const td = db
  .query("SELECT session_id, harness, decision FROM transform_decisions LIMIT 5")
  .all();
console.log("transform_decisions:", JSON.stringify(td));
