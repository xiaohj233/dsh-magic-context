/**
 * Spike 1 — Thin preset include + guarded patch (cordis-plugin-include).
 *
 * Validates the mechanism behind PLAN D5 ("薄 preset 递归 include + guarded
 * patch，不复制 YAML") against the REAL official `standard` agent preset of
 * the installed DSH 0.1.0-rc.6 (read-only):
 *
 *  1. the standard composition parses under the loader's entry-list dialect
 *     and carries the expected compaction group structure;
 *  2. a guarded disable patch (`id` + `name` guard) turns off compaction-basic
 *     while keeping command-compact and tool-result-pruner;
 *  3. a group insert adds the Magic engine row into the `compaction` group —
 *     the realm already isolates the group, so exactly one `compaction`
 *     provider remains in the patched composition;
 *  4. top-level inserts add the Magic agent rows;
 *  5. the name guard really is a guard: a mismatched package name skips the
 *     patch with a warning and never silently disables;
 *  6. the thin preset we would generate round-trips through the same YAML
 *     dialect the loader mounts.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dshImport } from "./lib/dsh-sdk.mjs";

const { applyEntryPatches, entryListSchema } = await dshImport(
  "@deepseek-ai/cordis-plugin-include",
);
const yaml = await import("js-yaml").catch(() => null);

const STANDARD_PRESET =
  process.env.DSH_STANDARD_PRESET ??
  "D:\\Dev\\DevEnv\\Node\\npm-global\\node_modules\\@deepseek-ai\\dsh\\config\\agent-presets\\standard\\agent.cordis.yml";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** The Magic patches applied over the stock standard composition. */
function magicPatches() {
  return [
    // Guarded disable: id + name must both match; otherwise the patch skips.
    {
      id: "compaction-basic",
      name: "@deepseek-ai/dsh-compaction-basic",
      disabled: true,
    },
    // Insert the Magic engine into the existing isolated compaction group.
    {
      id: "compaction",
      insert: [
        {
          id: "magic-compaction",
          name: "@xiao_hj909/magic-context-for-dsh/compaction",
          config: { auto: true },
        },
      ],
    },
    // Top-level inserts: Magic agent rows join the same standing mount.
    {
      insert: [
        { id: "magic-agent", name: "@xiao_hj909/magic-context-for-dsh/agent" },
        { id: "magic-commands", name: "@xiao_hj909/magic-context-for-dsh/commands" },
      ],
    },
  ];
}

/** Collect rows (with group ancestry) from the composed entry list. */
function flattenRows(entries, group = null, out = []) {
  for (const entry of entries) {
    out.push({ ...entry, group });
    if (entry.group && Array.isArray(entry.config)) {
      flattenRows(entry.config, entry.id, out);
    }
  }
  return out;
}

let standard = null;
await check("stock standard preset parses under the loader dialect", async () => {
  const raw = readFileSync(STANDARD_PRESET, "utf8");
  standard = yaml.load(raw, { schema: entryListSchema });
  assert.ok(Array.isArray(standard));
  const rows = flattenRows(standard);
  const compactionGroup = standard.find((r) => r.id === "compaction");
  assert.ok(compactionGroup?.group === true);
  assert.deepEqual(compactionGroup.isolate, { compaction: true, toolResultPruner: true });
  const compactionRows = flattenRows(compactionGroup.config);
  assert.ok(compactionRows.some((r) => r.id === "compaction-basic"));
  assert.ok(compactionRows.some((r) => r.id === "command-compact"));
  assert.ok(compactionRows.some((r) => r.id === "tool-result-pruner"));
});

await check("guarded disable + group insert + top-level inserts apply", async () => {
  const patched = applyEntryPatches(standard, magicPatches(), () => {});
  const rows = flattenRows(patched);
  const compactionGroup = patched.find((r) => r.id === "compaction");
  const compactionRows = flattenRows(compactionGroup.config);
  const basic = compactionRows.find((r) => r.id === "compaction-basic");
  assert.equal(basic.disabled, true);
  assert.equal(basic.name, "@deepseek-ai/dsh-compaction-basic");
  const magicEngine = compactionRows.find((r) => r.id === "magic-compaction");
  assert.equal(magicEngine.name, "@xiao_hj909/magic-context-for-dsh/compaction");
  assert.deepEqual(magicEngine.config, { auto: true });
  // command-compact and pruner untouched (coexistence rule 5.2/5.3).
  assert.ok(compactionRows.some((r) => r.id === "command-compact" && !r.disabled));
  assert.ok(compactionRows.some((r) => r.id === "tool-result-pruner" && !r.disabled));
  // top-level rows inserted.
  assert.ok(rows.some((r) => r.id === "magic-agent" && r.group === null));
  assert.ok(rows.some((r) => r.id === "magic-commands" && r.group === null));
});

await check("exactly one compaction provider remains (no double provider)", async () => {
  const patched = applyEntryPatches(standard, magicPatches(), () => {});
  const compactionGroup = patched.find((r) => r.id === "compaction");
  const providers = flattenRows(compactionGroup.config)
    .filter((r) => !r.group)
    .filter((r) => !r.disabled)
    .filter((r) => /compaction/i.test(r.id));
  assert.deepEqual(providers.map((r) => r.id), ["magic-compaction"]);
});

await check("name guard rejects a mismatched package (fail closed)", async () => {
  const warnings = [];
  const patched = applyEntryPatches(standard, [
    { id: "compaction-basic", name: "some-other-package", disabled: true },
  ], (msg, ...args) => warnings.push([msg, ...args]));
  const compactionGroup = patched.find((r) => r.id === "compaction");
  const basic = flattenRows(compactionGroup.config).find((r) => r.id === "compaction-basic");
  assert.notEqual(basic.disabled, true, "must NOT disable on name mismatch");
  assert.ok(warnings.length > 0, "must warn");
});

await check("unknown id patches are skipped with a warning", async () => {
  const warnings = [];
  const patched = applyEntryPatches(standard, [
    { id: "no-such-row", disabled: true },
  ], (msg, ...args) => warnings.push([msg, ...args]));
  assert.equal(patched.length, standard.length);
  assert.ok(warnings.length > 0);
});

await check("patched composition stays deterministic (replay invariant)", async () => {
  const a = applyEntryPatches(standard, magicPatches(), () => {});
  const b = applyEntryPatches(standard, magicPatches(), () => {});
  assert.deepEqual(a, b);
});

await check("thin preset file round-trips through the loader dialect", async () => {
  const thinPreset = [
    {
      id: "magic-include-standard",
      name: "@deepseek-ai/cordis-plugin-include",
      config: {
        path: STANDARD_PRESET,
        patches: magicPatches(),
      },
    },
  ];
  const outDir = join(dirname(fileURLToPath(import.meta.url)), ".generated");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "magic-standard.agent.cordis.yml");
  writeFileSync(outFile, yaml.dump(thinPreset, { schema: entryListSchema }));
  const reloaded = yaml.load(readFileSync(outFile, "utf8"), { schema: entryListSchema });
  assert.deepEqual(reloaded, thinPreset);
  // Sanity: the include row + its patches produce the same result as direct application.
  const includeConfig = reloaded[0].config;
  const composed = applyEntryPatches(standard, includeConfig.patches, () => {});
  const rows = flattenRows(composed);
  assert.ok(rows.some((r) => r.id === "magic-compaction"));
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
console.log(`\nspike-1: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
