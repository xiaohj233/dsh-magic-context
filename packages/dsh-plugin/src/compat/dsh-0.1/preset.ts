/**
 * compat/dsh-0.1/preset — thin preset generation + guarded patch (PLAN D5 / §7.2).
 *
 * Validated in Phase 0 spike-1 against the real stock `standard` preset:
 *   - the Magic engine row is inserted INTO the isolated `compaction` group;
 *   - `compaction-basic` is DISABLED (row kept for diagnostics) under a
 *     `name` guard — a mismatch skips the patch with a warning;
 *   - `command-compact` / `tool-result-pruner` stay untouched;
 *   - unknown layouts fail closed (doctor refuses to generate).
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";

export { entryListSchema };

/** The exact stock rows the guarded patch targets (contract scan constants). */
export const STOCK_COMPACTION_GROUP = {
  id: "compaction",
  name: "cordis:group",
  isolate: { compaction: true, toolResultPruner: true },
} as const;

export const STOCK_COMPACTION_BASIC_ROW = {
  id: "compaction-basic",
  name: "@deepseek-ai/dsh-compaction-basic",
} as const;

/** A loader patch entry (the include plugin's patch list shape). */
export interface PatchEntry {
  readonly id?: string;
  readonly name?: string;
  readonly insert?: readonly Record<string, unknown>[];
  readonly disabled?: boolean;
  readonly config?: unknown;
}

/**
 * Contract-scan one stock agent.cordis.yml entry list: verifies the compaction
 * group and compaction-basic row match the expected layout. Returns a reason
 * when the layout is unknown (fail closed), or undefined when it matches.
 */
export function scanStockPresetLayout(entries: readonly Record<string, unknown>[]): string | undefined {
  const group = entries.find((row) => row.id === STOCK_COMPACTION_GROUP.id);
  if (group === undefined) return "compaction group row missing";
  if (group.name !== STOCK_COMPACTION_GROUP.name) return "compaction group name mismatch";
  if (!group.group) return "compaction group is not a group";
  if (JSON.stringify(group.isolate) !== JSON.stringify(STOCK_COMPACTION_GROUP.isolate)) {
    return "compaction group isolate realms mismatch";
  }
  const children = (group.config as readonly Record<string, unknown>[] | undefined) ?? [];
  const basic = children.find((row) => row.id === STOCK_COMPACTION_BASIC_ROW.id);
  if (basic === undefined) return "compaction-basic row missing";
  if (basic.name !== STOCK_COMPACTION_BASIC_ROW.name) return "compaction-basic name mismatch";
  return undefined;
}

export interface MagicThinPresetOptions {
  /** Absolute path of the stock preset's agent.cordis.yml to include. */
  readonly stockPresetPath: string;
  /**
   * Absolute path of the Magic engine entry FILE (dist/entries/compaction.js).
   * Rows inserted into the nested stock include resolve from the STOCK
   * directory's module walk (which never reaches the profile's node_modules),
   * so Magic rows must be absolute file URLs, not package specifiers.
   */
  readonly magicEngineEntry?: string;
  /**
   * Extra top-level rows to insert. Names must be absolute entry file paths
   * (or `cordis:`/relative names) for the same resolution reason.
   */
  readonly magicRows?: readonly Record<string, unknown>[];
  /**
   * Absolute path of THIS package's no-write include entry
   * (`dist/entries/preset-include.js`). The include row MUST mount the shipped
   * stock file through a `write()`-no-op tree: the loader's dispose handler
   * writes a tree back to its source file when it decides the config changed,
   * and the raw `@deepseek-ai/cordis-plugin-include` truncates the SHIPPED
   * composition to `[]` the first time a session ends (dsh-agent-presets'
   * `PresetTree` exists for exactly this reason). When omitted the row falls
   * back to the raw include — acceptable only for offline config tooling
   * (applyMagicPatches) and tests; setup/doctor always pass the entry.
   */
  readonly includeEntry?: string;
}

/**
 * Generate the thin preset's entry list: one include row over the stock file
 * plus the guarded patches. The caller (doctor/setup) writes it to
 * `$DSH_HOME/.agent-presets/magic-standard/agent.cordis.yml`.
 */
export function buildThinPresetEntries(opts: MagicThinPresetOptions): Record<string, unknown>[] {
  const patches: PatchEntry[] = [
    {
      id: STOCK_COMPACTION_BASIC_ROW.id,
      name: STOCK_COMPACTION_BASIC_ROW.name,
      disabled: true,
    },
    {
      id: STOCK_COMPACTION_GROUP.id,
      insert: [
        {
          id: "magic-compaction",
          name:
            opts.magicEngineEntry === undefined
              ? "@xiao_hj909/magic-context-for-dsh/compaction"
              : pathToFileURL(opts.magicEngineEntry).href,
          config: { auto: true },
        },
      ],
    },
  ];
  if (opts.magicRows !== undefined && opts.magicRows.length > 0) {
    // Absolute filesystem names (magicEntryPath results) are emitted as
    // file:// URLs: dsh-agent-presets' PresetTree.import() converts bare
    // absolute paths itself, but the raw Include tree (fallback tooling) and
    // every resolver treats the URL form uniformly.
    patches.push({
      insert: opts.magicRows.map((row) => ({
        ...row,
        name:
          typeof row.name === "string" && isAbsolute(row.name)
            ? pathToFileURL(row.name).href
            : row.name,
      })),
    });
  }
  return [
    {
      id: "magic-include-standard",
      // The include row must mount the SHIPPED stock file through our no-write
      // entry (dist/entries/preset-include.js): the loader's dispose handler
      // writes a tree back to its source file, and the raw
      // `@deepseek-ai/cordis-plugin-include` would truncate the shipped
      // composition to `[]` the first time a session ends. The name is an
      // absolute file URL so the row resolves from THIS package even when the
      // composition is mounted from a nested include (stock dir's module walk
      // never reaches the profile's node_modules).
      name:
        opts.includeEntry === undefined
          ? "@deepseek-ai/cordis-plugin-include"
          : pathToFileURL(opts.includeEntry).href,
      config: {
        // The include plugin resolves `path` with `new URL(path, baseUrl)`;
        // a Windows drive path ("D:\…") parses as a `D:` scheme and fails.
        // `pathToFileURL` yields the scheme-file form on every platform.
        path: pathToFileURL(opts.stockPresetPath).href,
        patches,
      },
    },
  ];
}

/**
 * Apply the guarded patches over a parsed stock entry list (structure-level
 * verification used by tests and doctor dry-runs). Reuses the loader's own
 * patch engine, so the dump can never drift from what boots.
 */
export function applyMagicPatches(
  entries: readonly Record<string, unknown>[],
  opts: MagicThinPresetOptions,
): Record<string, unknown>[] {
  const layoutIssue = scanStockPresetLayout(entries);
  if (layoutIssue !== undefined) throw new Error(`magic-standard: stock preset layout ${layoutIssue}`);
  const thin = buildThinPresetEntries(opts);
  const includeConfig = thin[0].config as { patches: Parameters<typeof applyEntryPatches>[1] };
  return applyEntryPatches(
    entries as unknown as Parameters<typeof applyEntryPatches>[0],
    includeConfig.patches,
    () => {},
  ) as unknown as Record<string, unknown>[];
}
