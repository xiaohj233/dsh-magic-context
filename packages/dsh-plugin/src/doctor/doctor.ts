/**
 * doctor/doctor — `dsh-magic-context doctor` (Phase 2 slice C).
 *
 * Checklist (each item reports ok/warn/fail + a fix hint):
 *   1. DSH version vs the compatibility expectation (exact rc 0.1.0-rc.6);
 *   2. bundle install state (profile package.json `dsh.profile.bundles`);
 *   3. magic-standard preset generated + stock layout still contract-valid
 *      (re-runs scanStockPresetLayout against the stock file the include row
 *      points at, and applyMagicPatches as a dry-run);
 *   4. shared DB: storage dir location + openDatabaseAsync result
 *      classification (schema fence / migration guard / fatal) + liveness
 *      marker scan;
 *   5. config loading (loadPluginConfigDetailed loadOutcome classification).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import { readJsoncFile } from "@magic-context/core/shared/jsonc-parser";
import { loadPluginConfigDetailed } from "@magic-context/core/config";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
  LATEST_SUPPORTED_VERSION,
  getMigrationOnOpenRefusal,
  getPersistedSchemaVersion,
  getSchemaFenceRejection,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  applyMagicPatches,
  scanStockPresetLayout,
} from "../compat/dsh-0.1/preset";
import type { RpcPortFileRecord } from "../compat/dsh-0.1/liveness";
import {
  DSH_COMPAT_EXPECTED_VERSION,
  DSH_PACKAGE,
  MAGIC_CONTEXT_PACKAGE,
  errorMessage,
  locateDshInstall,
  magicEntryPath,
  magicStandardAgentCordisPath,
  magicStandardDir,
  magicStandardPresetYamlPath,
  parseFlags,
  resolveDshHome,
  stringFlag,
} from "./env";
import { parseEntryListYaml } from "./setup";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Human fix guidance for warn/fail items. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly exitCode: number;
  readonly checks: readonly DoctorCheck[];
}

export interface DshDoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dshHome?: string;
  readonly dshInstallDir?: string;
  readonly stockPresetPath?: string;
  /** Workspace directory (project config + liveness project scope). */
  readonly directory?: string;
  /** Restrict the bundle check to one profile name. */
  readonly profile?: string;
  /** Storage dir override (tests). */
  readonly storageDirOverride?: string;
  /** Shared DB path override (tests). */
  readonly dbPathOverride?: string;
}

export interface DbOpenOutcome {
  readonly kind: "ok" | "schema-fence" | "migration-guard" | "fatal";
  readonly db?: Database;
  readonly schemaVersion?: number;
  readonly latestSupported?: number;
  readonly detail?: unknown;
}

/**
 * Classify the result of opening the shared DB the way the host bootstrap does
 * (openDatabaseAsync). `null` means the core refused: the recorded
 * schema-fence rejection wins, then the migration-on-open refusal, then a
 * generic guard refusal. A throw is a fatal open error.
 */
export async function classifyDatabaseOpen(
  dbPath: string,
): Promise<DbOpenOutcome> {
  try {
    const db = await openDatabaseAsync({ dbPath });
    if (db === null) {
      const fence = getSchemaFenceRejection();
      if (fence !== null) return { kind: "schema-fence", detail: fence };
      const guard = getMigrationOnOpenRefusal();
      if (guard !== null) return { kind: "migration-guard", detail: guard };
      return {
        kind: "migration-guard",
        detail: "open returned null without a recorded reason",
      };
    }
    return {
      kind: "ok",
      db,
      schemaVersion: getPersistedSchemaVersion(db),
      latestSupported: LATEST_SUPPORTED_VERSION,
    };
  } catch (error) {
    return { kind: "fatal", detail: errorMessage(error) };
  }
}

export interface LivenessMarkerEntry {
  readonly path: string;
  readonly pid: number;
  readonly live: boolean;
  readonly port: number;
}

export interface LivenessMarkerScan {
  readonly markers: readonly LivenessMarkerEntry[];
  readonly liveCount: number;
}

/** Scan `<storageDir>/rpc/<projectHash>/port-<pid>.json` markers. */
export function scanLivenessMarkers(storageDir: string): LivenessMarkerScan {
  const rpcRoot = join(storageDir, "rpc");
  if (!existsSync(rpcRoot)) return { markers: [], liveCount: 0 };
  const markers: LivenessMarkerEntry[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(rpcRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { markers: [], liveCount: 0 };
  }
  for (const projectDir of projectDirs) {
    const dirPath = join(rpcRoot, projectDir);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("port-") || !file.endsWith(".json")) continue;
      const path = join(dirPath, file);
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as RpcPortFileRecord;
        markers.push({
          path,
          pid: record.pid,
          live: pidAlive(record.pid),
          port: record.port,
        });
      } catch {
        markers.push({ path, pid: NaN, live: false, port: 0 });
      }
    }
  }
  return { markers, liveCount: markers.filter((marker) => marker.live).length };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Profile package.json facts used by the bundle-install check. */
export interface ProfileBundleFacts {
  readonly name: string;
  readonly packageJsonPath: string;
  readonly packageJsonExists: boolean;
  readonly bundles: readonly string[];
  readonly bundleInstalled: boolean;
  readonly nodeModulesPackageExists: boolean;
}

/** Read the bundle facts for one profile directory. */
export function profileBundleFacts(
  dshHome: string,
  profileName: string,
): ProfileBundleFacts {
  const packageJsonPath = join(dshHome, "profiles", profileName, "package.json");
  const packageJsonExists = existsSync(packageJsonPath);
  let bundles: string[] = [];
  if (packageJsonExists) {
    const parsed = readJsoncFile<{
      dsh?: { profile?: { bundles?: unknown } };
    }>(packageJsonPath);
    const raw = parsed?.dsh?.profile?.bundles;
    if (Array.isArray(raw)) bundles = raw.map(String);
  }
  const bundleInstalled = bundles.includes(MAGIC_CONTEXT_PACKAGE);
  const nodeModulesPackageExists = existsSync(
    join(dshHome, "profiles", profileName, "node_modules", MAGIC_CONTEXT_PACKAGE),
  );
  return {
    name: profileName,
    packageJsonPath,
    packageJsonExists,
    bundles,
    bundleInstalled,
    nodeModulesPackageExists,
  };
}

/** List profile names under `$DSH_HOME/profiles`. */
export function listProfiles(dshHome: string): string[] {
  const profilesRoot = join(dshHome, "profiles");
  if (!existsSync(profilesRoot)) return [];
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function runDshDoctor(
  argv: readonly string[],
  options: DshDoctorOptions = {},
): Promise<DoctorReport> {
  const { flags } = parseFlags(argv);
  const env = options.env ?? process.env;
  const dshHome = options.dshHome ?? stringFlag(flags, "dsh-home") ?? resolveDshHome(env);
  const dshInstallDir = options.dshInstallDir ?? stringFlag(flags, "dsh-install");
  const stockPresetPath = options.stockPresetPath ?? stringFlag(flags, "stock-preset");
  const directory = options.directory ?? stringFlag(flags, "directory") ?? process.cwd();
  const profileFilter = options.profile ?? stringFlag(flags, "profile");

  const checks: DoctorCheck[] = [];
  const located = locateDshInstall({ dshHome, dshInstallDir, stockPresetPath, env });

  // 1. DSH version vs the compatibility expectation.
  if (located.dshInstallDir === undefined) {
    checks.push({
      id: "dsh-version",
      title: "DSH version",
      status: "fail",
      detail:
        `Could not locate the DSH install (expected ${DSH_COMPAT_EXPECTED_VERSION}). Probed:\n` +
        located.tried.map((candidate) => `  - ${candidate}`).join("\n"),
      fix: `Install DSH ${DSH_COMPAT_EXPECTED_VERSION} or pass --dsh-install <dir>.`,
    });
  } else {
    const manifestPath = join(located.dshInstallDir, "package.json");
    let installedVersion: string | undefined;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") installedVersion = parsed.version;
    } catch (error) {
      checks.push({
        id: "dsh-version",
        title: "DSH version",
        status: "fail",
        detail: `${manifestPath}: ${errorMessage(error)}`,
        fix: `Reinstall DSH ${DSH_COMPAT_EXPECTED_VERSION}.`,
      });
      installedVersion = undefined;
    }
    if (installedVersion !== undefined) {
      if (installedVersion === DSH_COMPAT_EXPECTED_VERSION) {
        checks.push({
          id: "dsh-version",
          title: "DSH version",
          status: "ok",
          detail: `${located.dshInstallDir} → ${installedVersion} (matches the compat contract ${DSH_COMPAT_EXPECTED_VERSION}).`,
        });
      } else {
        checks.push({
          id: "dsh-version",
          title: "DSH version",
          status: "fail",
          detail:
            `installed ${installedVersion} at ${located.dshInstallDir}; the adapter pins ` +
            `exact-rc ${DSH_COMPAT_EXPECTED_VERSION} (compat/dsh-0.1).`,
          fix: `Install the exact release: ${DSH_PACKAGE}@${DSH_COMPAT_EXPECTED_VERSION}.`,
        });
      }
    }
  }

  // 2. Bundle install state (per profile).
  const profiles = profileFilter !== undefined
    ? [profileFilter]
    : listProfiles(dshHome);
  if (profiles.length === 0) {
    checks.push({
      id: "bundle-install",
      title: "Bundle install state",
      status: "warn",
      detail: `no profiles found under ${join(dshHome, "profiles")}.`,
      fix: `Create a profile first (e.g. dsh --profile web), then add ${MAGIC_CONTEXT_PACKAGE}.`,
    });
  } else {
    let installedCount = 0;
    for (const profileName of profiles) {
      const facts = profileBundleFacts(dshHome, profileName);
      if (facts.bundleInstalled) installedCount += 1;
      const status: CheckStatus = !facts.packageJsonExists
        ? "warn"
        : facts.bundleInstalled
          ? "ok"
          : "fail";
      checks.push({
        id: `bundle-install.${profileName}`,
        title: `Bundle install state — profile ${profileName}`,
        status,
        detail: facts.bundleInstalled
          ? `${MAGIC_CONTEXT_PACKAGE} is in dsh.profile.bundles` +
            (facts.nodeModulesPackageExists ? " and resolvable in node_modules." : " but NOT resolvable in node_modules.")
          : `${MAGIC_CONTEXT_PACKAGE} is missing from dsh.profile.bundles` +
            (facts.packageJsonExists
              ? ` (current bundles: ${facts.bundles.join(", ") || "none"}).`
              : ` (${facts.packageJsonPath} missing).`),
        fix: `dsh plugin --profile ${profileName} add ${MAGIC_CONTEXT_PACKAGE} (or edit the profile package.json dsh.profile.bundles manually).`,
      });
    }
    if (installedCount === 0 && profiles.length > 0) {
      checks.push({
        id: "bundle-install",
        title: "Bundle install state (summary)",
        status: "fail",
        detail: `${MAGIC_CONTEXT_PACKAGE} is not installed in any profile.`,
        fix: `dsh plugin --profile <name> add ${MAGIC_CONTEXT_PACKAGE}`,
      });
    }
  }

  // 3. magic-standard preset generated + layout still contract-valid.
  const presetDir = magicStandardDir(dshHome);
  const agentCordisPath = magicStandardAgentCordisPath(dshHome);
  const presetYamlPath = magicStandardPresetYamlPath(dshHome);
  if (!existsSync(agentCordisPath) || !existsSync(presetYamlPath)) {
    checks.push({
      id: "preset-generated",
      title: "magic-standard preset",
      status: "fail",
      detail:
        `${presetDir} is missing (${existsSync(presetYamlPath) ? "" : "preset.yml, "}` +
        `${existsSync(agentCordisPath) ? "" : "agent.cordis.yml"}).`,
      fix: "Run `dsh-magic-context setup` to generate the thin preset.",
    });
  } else {
    let presetStatus: CheckStatus = "ok";
    let presetDetail = `${presetDir}: generated.`;
    try {
      const thinEntries = parseEntryListYaml(readFileSync(agentCordisPath, "utf8"));
      const includeRow = thinEntries.find((row) => row.id === "magic-include-standard");
      const includeConfig = includeRow?.config as
        | { path?: unknown; patches?: unknown }
        | undefined;
      // The generated include path is a file:// URL (setup emits it that way
      // so Windows drive paths survive the loader's URL resolution); convert
      // it back to a filesystem path before reading.
      const includePath =
        typeof includeConfig?.path === "string" && includeConfig.path.startsWith("file:")
          ? fileURLToPath(includeConfig.path)
          : includeConfig?.path;
      if (
        includeRow === undefined ||
        typeof includePath !== "string" ||
        !existsSync(includePath)
      ) {
        presetStatus = "fail";
        presetDetail = `${agentCordisPath}: the include row is missing or its stock path no longer exists.`;
      } else if (includeRow.name === "@deepseek-ai/cordis-plugin-include") {
        // Regression guard: the raw include inherits the loader's write-back,
        // which truncates the SHIPPED stock composition to `[]` the first time
        // a session ends (dsh-agent-presets' PresetTree documents this exact
        // hazard). setup must emit our no-write entry instead.
        presetStatus = "fail";
        presetDetail =
          `${agentCordisPath}: the include row still uses the raw ` +
          `@deepseek-ai/cordis-plugin-include, which truncates the shipped ` +
          `stock preset on the first agent teardown (loader write-back).`;
      } else {
        // The include row must mount the shipped stock file through OUR
        // no-write entry (dist/entries/preset-include.js).
        const expectedIncludeEntry = pathToFileURL(
          magicEntryPath("preset-include"),
        ).href;
        const entryFile =
          typeof includeRow.name === "string" && includeRow.name.startsWith("file:")
            ? fileURLToPath(includeRow.name)
            : includeRow.name;
        if (
          includeRow.name !== expectedIncludeEntry ||
          typeof entryFile !== "string" ||
          !existsSync(entryFile)
        ) {
          presetStatus = "fail";
          presetDetail =
            `${agentCordisPath}: the include row does not name this package's ` +
            `no-write entry (${expectedIncludeEntry})` +
            `${typeof entryFile === "string" && existsSync(entryFile) ? "" : " and the entry file is missing"}.`;
        } else {
          // Re-run the contract scan against the STOCK file the include row
          // references, then prove the guarded patch still applies (dry run).
          const stockEntries = parseEntryListYaml(readFileSync(includePath, "utf8"));
          const layoutIssue = scanStockPresetLayout(stockEntries);
          if (layoutIssue !== undefined) {
            presetStatus = "fail";
            presetDetail =
              `${includePath}: stock layout changed (${layoutIssue}) — the ` +
              `guarded patch no longer applies; the generated preset is stale.`;
          } else {
            applyMagicPatches(stockEntries, { stockPresetPath: includePath });
            presetDetail =
              `${presetDir}: valid; stock layout at ${includePath} re-scanned ` +
              `and the guarded patch applies cleanly.`;
          }
        }
      }
    } catch (error) {
      presetStatus = "fail";
      presetDetail = `${agentCordisPath}: ${errorMessage(error)}`;
    }
    checks.push({
      id: "preset-generated",
      title: "magic-standard preset",
      status: presetStatus,
      detail: presetDetail,
      fix: presetStatus === "ok"
        ? undefined
        : "Run `dsh-magic-context setup` to regenerate (it fails closed on a layout mismatch).",
    });
  }

  // 4. Shared DB.
  const storageDir = options.storageDirOverride ?? getMagicContextStorageDir();
  const dbPath = options.dbPathOverride ?? join(storageDir, "context.db");
  if (!existsSync(dbPath)) {
    checks.push({
      id: "shared-db",
      title: "Shared DB",
      status: "warn",
      detail: `${dbPath} does not exist yet (storage dir: ${storageDir}).`,
      fix: "Start a session or run `dsh-magic-context setup`, then re-run doctor.",
    });
  } else {
    const outcome = await classifyDatabaseOpen(dbPath);
    switch (outcome.kind) {
      case "ok": {
        outcome.db?.close();
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "ok",
          detail:
            `${dbPath}: opened; schema v${outcome.schemaVersion} (adapter supports ` +
            `up to v${outcome.latestSupported}).`,
        });
        break;
      }
      case "schema-fence":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail:
            `${dbPath}: schema fence refused the open — the persisted schema is ` +
            `newer than this adapter supports. ${formatDetail(outcome.detail)}`,
          fix: "Update Magic Context / the DSH adapter to a build that supports the newer schema.",
        });
        break;
      case "migration-guard":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail:
            `${dbPath}: the migration-on-open guard refused the open — another ` +
            `harness process may still be running against this database. ${formatDetail(outcome.detail)}`,
          fix: "Close every OpenCode / Pi / DSH process that may hold the DB, then re-run doctor.",
        });
        break;
      case "fatal":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail: `${dbPath}: ${String(outcome.detail ?? "unknown open error")}`,
          fix: "Repair or restore the database; see doctor repair guidance.",
        });
        break;
    }
  }

  // 5. Liveness markers (explains a migration-guard refusal).
  const markerScan = scanLivenessMarkers(storageDir);
  if (markerScan.liveCount === 0) {
    checks.push({
      id: "liveness-markers",
      title: "Liveness markers",
      status: "ok",
      detail:
        markerScan.markers.length === 0
          ? `${join(storageDir, "rpc")}: no DSH liveness markers.`
          : `${markerScan.markers.length} marker(s) found, all from dead processes (stale, harmless).`,
    });
  } else {
    checks.push({
      id: "liveness-markers",
      title: "Liveness markers",
      status: "warn",
      detail:
        `${markerScan.liveCount} live DSH liveness marker(s) under ${join(storageDir, "rpc")} — ` +
        `a running harness process may hold the migration guard.`,
      fix: "If no harness is actually running, remove the stale port-*.json marker files.",
    });
  }

  // 6. Config loading.
  const configPath = resolveCortexKitUserConfigPath();
  const loaded = loadPluginConfigDetailed(directory);
  const outcome = loaded.loadOutcome;
  const statusForOutcome: Record<string, CheckStatus> = {
    ok: "ok",
    "schema-recovery": "warn",
    "substitution-failure": "warn",
    "legacy-config-unmigrated": "warn",
    "project-file-parse-error": "fail",
    "project-file-io-error": "fail",
  };
  const configStatus: CheckStatus = !existsSync(configPath)
    ? "warn"
    : (statusForOutcome[outcome] ?? "warn");
  checks.push({
    id: "config-load",
    title: "Config loading",
    status: configStatus,
    detail:
      `${existsSync(configPath) ? configPath : "no user config (defaults apply)"} ` +
      `→ loadOutcome=${outcome} (user: ${loaded.sources.userConfig}, project: ${loaded.sources.projectConfig})` +
      (loaded.config.configWarnings?.length
        ? `; warnings: ${loaded.config.configWarnings.join(" | ")}`
        : ""),
    fix: configStatus === "ok"
      ? undefined
      : configStatus === "fail"
        ? "Fix the config file parse error, then re-run doctor."
        : "Review the config warnings; run `dsh-magic-context setup` to bootstrap a user config.",
  });

  return {
    exitCode: checks.some((check) => check.status === "fail") ? 1 : 0,
    checks,
  };
}

function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
