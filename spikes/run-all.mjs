/**
 * Run every Phase 0 contract spike in order; exits non-zero on any failure.
 */
import { spawnSync } from "node:child_process";

const spikes = [
  "spike-0-surface-cas.mjs",
  "spike-1-guarded-patch.mjs",
  "spike-2-pre-step-gate.mjs",
  "spike-3-compaction-summarize-subclass.mjs",
  "spike-4-typert-remote.mjs",
  "spike-5-worker-provider.mjs",
];

let failed = 0;
for (const spike of spikes) {
  const result = spawnSync(process.execPath, [spike], { stdio: "inherit", cwd: import.meta.dirname });
  if (result.status !== 0) {
    console.log(`\n=== ${spike} FAILED (exit ${result.status}) ===`);
    failed += 1;
  }
}
console.log(`\nphase-0 spikes: ${spikes.length - failed}/${spikes.length} suites green`);
process.exitCode = failed === 0 ? 0 : 1;
