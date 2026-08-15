#!/usr/bin/env node
/**
 * doctor/cli — `dsh-magic-context` bin entry.
 *
 * Subcommands:
 *   setup    locate DSH + generate the magic-standard thin preset + bootstrap
 *            the user config (see ./setup)
 *   doctor   run the adapter checklist (see ./doctor)
 *   --version / -v
 *
 * Built to dist/cli.js by `bun run build` and wired as package.json bin
 * `dsh-magic-context`. The lib functions (runDshSetup / runDshDoctor) stay
 * console-free so tests drive them directly.
 */
import { runDshSetup, type SetupReport } from "./setup";
import { runDshDoctor, type DoctorReport } from "./doctor";
import { MAGIC_CONTEXT_PACKAGE } from "./env";

const VERSION = "0.1.0";

export function printSetupReport(report: SetupReport): void {
  for (const step of report.steps) {
    const mark = step.status === "ok" ? "ok  " : step.status === "warn" ? "warn" : "FAIL";
    console.log(`[${mark}] ${step.title}`);
    for (const line of step.detail.split("\n")) console.log(`       ${line}`);
  }
  if (report.nextSteps.length > 0) {
    console.log("\nNext steps:");
    for (const line of report.nextSteps) console.log(`  - ${line}`);
  }
}

export function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    const mark = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
    console.log(`[${mark}] ${check.title}`);
    for (const line of check.detail.split("\n")) console.log(`       ${line}`);
    if (check.fix !== undefined) console.log(`       fix: ${check.fix}`);
  }
}

function usage(): void {
  console.log(
    [
      `${MAGIC_CONTEXT_PACKAGE} — Magic Context DSH adapter tools`,
      "",
      "Usage:",
      "  dsh-magic-context setup   [--dsh-home <dir>] [--dsh-install <dir>]",
      "                            [--stock-preset <file>] [--profile <name>] [--dry-run]",
      "  dsh-magic-context doctor  [--dsh-home <dir>] [--dsh-install <dir>]",
      "                            [--stock-preset <file>] [--profile <name>]",
      "                            [--directory <dir>]",
      "  dsh-magic-context --version",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "setup": {
      const report = await runDshSetup(rest);
      printSetupReport(report);
      return report.exitCode;
    }
    case "doctor": {
      const report = await runDshDoctor(rest);
      printDoctorReport(report);
      return report.exitCode;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      usage();
      return command === undefined ? 0 : 2;
  }
}

// Direct execution (also used by the built dist/cli.js bin).
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const normalized = entry.replace(/\\/g, "/");
  // Under node ESM import.meta.url is file:///<path>; under bun it is the
  // absolute path. Comparing the tail keeps both runtimes working.
  return (
    import.meta.url.endsWith(normalized) ||
    import.meta.url.endsWith(normalized.split("/").pop() ?? "")
  );
}

if (isDirectEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
