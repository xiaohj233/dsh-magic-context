/**
 * doctor/env — DSH environment discovery for the setup/doctor tools.
 *
 * Everything the bin scripts need to locate the machine's DSH install and the
 * shared Magic Context paths, plus small file helpers (atomic writes, flag
 * parsing). Path semantics follow dsh-reference:
 *
 *   - DSH home: `$DSH_HOME` (empty = unset) → `~/.dsh`            (H.3, I.1)
 *   - system standard preset: `<dsh install>/config/agent-presets/standard/
 *     agent.cordis.yml`; the install is found with the profile/install double
 *     anchor from A.1 (install first, then profile dirs), falling back to the
 *     `dsh` executable on PATH.
 *   - user config: `~/.config/cortexkit/magic-context.jsonc`       (§2.1)
 *   - storage dir: `~/.local/share/cortexkit/magic-context/`       (§2.1)
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

/** npm package identity of this adapter (checked against profile bundles). */
export const MAGIC_CONTEXT_PACKAGE = "dsh-magic-context";

/** The exact DSH release this adapter's compat layer (compat/dsh-0.1) pins. */
export const DSH_COMPAT_EXPECTED_VERSION = "0.1.0-rc.6";

/** Installed-package identity of the DSH runtime. */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

/** System preset directory inside a dsh install. */
export const STOCK_PRESET_REL = join(
  "config",
  "agent-presets",
  "standard",
  "agent.cordis.yml",
);

/**
 * Resolve the DSH home directory. Priority: `$DSH_HOME` (empty string counts
 * as unset) → `~/.dsh` (dsh-home-paths semantics).
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return join(homedir(), ".dsh");
}

export interface DshInstallLocateResult {
  /** Package root of the resolved `@deepseek-ai/dsh` install (if found). */
  readonly dshInstallDir?: string;
  /** Absolute path of the system standard `agent.cordis.yml` (if found). */
  readonly stockPresetPath?: string;
  /** Every candidate probed, for the fail diagnosis. */
  readonly tried: readonly string[];
}

export interface DshInstallLocateOptions {
  readonly dshHome: string;
  /** Explicit install dir override (tests / `--dsh-install`). */
  readonly dshInstallDir?: string;
  /** Explicit stock preset override (tests / `--stock-preset`). */
  readonly stockPresetPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Locate the DSH install and the system standard preset.
 *
 * Anchors (dsh-reference §A.1 "模块解析双锚点"): the install is resolved from
 * the dsh install first, then from profile directories. Concrete candidate
 * order:
 *   1. explicit overrides (`--dsh-install` / `--stock-preset`, env
 *      `DSH_INSTALL_DIR` as an escape hatch);
 *   2. the home-level fallback closure `$DSH_HOME/profiles/node_modules/…`
 *      (healProfilesModuleFallback);
 *   3. every `$DSH_HOME/profiles/<name>/node_modules/…` (profile anchor);
 *   4. the `dsh` executable on PATH, walked up to its package root.
 */
export function locateDshInstall(
  opts: DshInstallLocateOptions,
): DshInstallLocateResult {
  if (opts.stockPresetPath !== undefined) {
    return { stockPresetPath: opts.stockPresetPath, tried: [opts.stockPresetPath] };
  }
  const env = opts.env ?? process.env;
  const tried: string[] = [];

  const installCandidates: string[] = [];
  if (opts.dshInstallDir !== undefined) installCandidates.push(opts.dshInstallDir);
  const envInstall = env.DSH_INSTALL_DIR;
  if (envInstall !== undefined && envInstall.trim() !== "") {
    installCandidates.push(envInstall);
  }
  installCandidates.push(join(opts.dshHome, "profiles", "node_modules", DSH_PACKAGE));
  try {
    const profilesRoot = join(opts.dshHome, "profiles");
    if (existsSync(profilesRoot)) {
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        installCandidates.push(
          join(profilesRoot, entry.name, "node_modules", DSH_PACKAGE),
        );
      }
    }
  } catch {
    // Unreadable profiles dir — PATH fallback still applies.
  }
  installCandidates.push(...findDshInstallOnPath(env));

  for (const candidate of installCandidates) {
    tried.push(candidate);
    const stock = join(candidate, STOCK_PRESET_REL);
    if (isDshInstallRoot(candidate) && existsSync(stock)) {
      return { dshInstallDir: candidate, stockPresetPath: stock, tried };
    }
  }
  return { tried };
}

/** Whether a directory is the `@deepseek-ai/dsh` package root. */
export function isDshInstallRoot(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return parsed.name === DSH_PACKAGE;
  } catch {
    return false;
  }
}

/** PATH lookup for the `dsh` executable, resolved to its package root. */
function findDshInstallOnPath(env: NodeJS.ProcessEnv): string[] {
  const pathVar = env.PATH ?? "";
  const exts = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  for (const segment of pathVar.split(";").concat(process.platform === "win32" ? [] : pathVar.split(":"))) {
    const dir = segment.trim();
    if (dir === "") continue;
    for (const ext of exts) {
      const bin = join(dir, `dsh${ext}`);
      if (!existsSync(bin)) continue;
      const resolved = resolvePackageRoot(bin);
      if (resolved !== undefined) return [resolved];
    }
  }
  return [];
}

/** Walk up from an executable to the nearest `@deepseek-ai/dsh` package root. */
function resolvePackageRoot(binPath: string): string | undefined {
  let current: string;
  try {
    current = realpathSync(binPath);
  } catch {
    current = binPath;
  }
  let dir = dirname(current);
  for (let depth = 0; depth < 10 && dir !== dirname(dir); depth += 1) {
    if (isDshInstallRoot(dir)) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

// ── Magic Context paths ─────────────────────────────────────────────────────

/** `$DSH_HOME/.agent-presets` — user preset root (dsh-reference §A.6). */
export function agentPresetsRoot(dshHome: string): string {
  return join(dshHome, ".agent-presets");
}

/** `$DSH_HOME/.agent-presets/magic-standard` — this adapter's thin preset. */
export function magicStandardDir(dshHome: string): string {
  return join(agentPresetsRoot(dshHome), "magic-standard");
}

export function magicStandardAgentCordisPath(dshHome: string): string {
  return join(magicStandardDir(dshHome), "agent.cordis.yml");
}

export function magicStandardPresetYamlPath(dshHome: string): string {
  return join(magicStandardDir(dshHome), "preset.yml");
}

// ── file helpers ────────────────────────────────────────────────────────────

/**
 * Atomic write: write a temp file in the target directory, then rename over
 * the target (same-filesystem rename is atomic on POSIX and Windows). Mode is
 * applied to the temp file before rename so the target never exists with
 * looser permissions (0600 for generated secrets/config).
 */
export function writeFileAtomic(
  target: string,
  content: string,
  mode = 0o600,
): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${target.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Tiny flag parser for the bin scripts: `--name` (value `true`), `--name=value`
 * and `--name value`. Anything else is collected as a positional.
 */
export function parseFlags(
  argv: readonly string[],
): { flags: Record<string, string | true>; positionals: string[] } {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

/** Stable human-readable error text for a thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Read one flag as an optional string (boolean flags yield undefined). */
export function stringFlag(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Absolute path of one bundled entry file (`dist/entries/<name>.js`) of THIS package. */
export function magicEntryPath(
  entry: "agent" | "compaction" | "commands" | "tools" | "remote" | "preset-include",
): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12 && dir !== dirname(dir); depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === MAGIC_CONTEXT_PACKAGE) {
          return join(dir, "dist", "entries", `${entry}.js`);
        }
      } catch {
        // Unparseable manifest — keep walking up.
      }
    }
    dir = dirname(dir);
  }
  throw new Error(
    `cannot locate ${MAGIC_CONTEXT_PACKAGE} package root from ${import.meta.url}`,
  );
}
