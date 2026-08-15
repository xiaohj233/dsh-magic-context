/**
 * Phase 5 upgrade matrix — the compat-layer contract gate (PLAN §7.3).
 *
 * The adapter pins the dsh-0.1 contracts in `compat/dsh-0.1/` (exact-rc
 * dependencies + local pinned shapes). This gate reads the INSTALLED
 * `@deepseek-ai/*` packages' type declarations and asserts the pinned
 * vocabulary still exists — a rename/removal fails loudly before a DSH
 * upgrade can silently break the adapter. Runs against the CURRENT install
 * (the supported RC) in CI; a candidate-version run is the upgrade gate.
 *
 * Provenance: the official documentation URLs (docs/phase5-upgrade.md)
 * cross-check these contracts; the strings here are the mechanical part.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

interface PackageContract {
  readonly name: string;
  /** Package root to resolve (defaults to `name`; subpath exports use the parent). */
  readonly root?: string;
  /** Must-exist vocabulary lines in the package's .d.ts files. */
  readonly required: readonly string[];
}

const CONTRACTS: readonly PackageContract[] = [
  {
    name: "@deepseek-ai/dsh-session",
    required: [
      "surfaceOp",
      "replaceGeneration",
      "sourceEventSeqs",
      "append-only",
      "SessionId",
    ],
  },
  {
    name: "@deepseek-ai/dsh-session/surface",
    root: "@deepseek-ai/dsh-session",
    required: ["deriveEventMessage", "foldSurface", "isSurfaceEvent"],
  },
  {
    name: "@deepseek-ai/dsh-compaction",
    required: ["compactCheckpointSource", "ManualCompactionError", "CompactionId"],
  },
  {
    name: "@deepseek-ai/dsh-compaction-basic",
    required: ["BasicCompactionEngine", "summarize"],
  },
  {
    name: "@deepseek-ai/dsh-llm",
    required: ["createUserMessage", "createAssistantMessage", "createToolResultMessage"],
  },
  {
    name: "@deepseek-ai/dsh-subagent",
    required: [
      "captureDelegatedPolicyOverrides",
      "resolveChildDepth",
      "SubagentDepthError",
      "toolFilter",
    ],
  },
  {
    name: "@deepseek-ai/cordis-plugin-include",
    required: ["applyEntryPatches", "entryListSchema", "class Include"],
  },
];

/** Resolve the package root from the adapter's own dependency graph. */
function packageRoot(name: string): string {
  const resolved = require.resolve(`${name}/package.json`);
  return dirname(resolved);
}

/** Recursively read every .d.ts under the package root. */
function readTypeDeclarations(root: string): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of readDirSafe(dir)) {
      const full = join(dir, entry);
      if (entry.endsWith(".d.ts")) {
        out.push(readFileSync(full, "utf8"));
      } else if (entry !== "node_modules") {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out.join("\n");
}

function readDirSafe(dir: string): string[] {
  try {
    return require("node:fs").readdirSync(dir);
  } catch {
    return [];
  }
}

describe("compat contract gate (dsh-0.1 upgrade matrix)", () => {
  it("the pinned DSH contract vocabulary exists in the installed packages", () => {
    for (const contract of CONTRACTS) {
      const root = packageRoot(contract.root ?? contract.name);
      expect(existsSync(root), `${contract.name} package root`).toBe(true);
      const declarations = readTypeDeclarations(root);
      for (const token of contract.required) {
        expect(
          declarations.includes(token),
          `${contract.name}: pinned vocabulary "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("the pinned SummarizationInput/SummaryResult shapes match the basic engine's summarizer", () => {
    const root = packageRoot("@deepseek-ai/dsh-compaction-basic");
    const declarations = readTypeDeclarations(root);
    // The adapter pins summary as ContentBlock[], provider/model required.
    expect(declarations).toMatch(/summarize\s*\(/);
    expect(declarations).toMatch(/summary\s*:/);
    expect(declarations).toMatch(/provider\s*:/);
    expect(declarations).toMatch(/model\s*:/);
  });

  it("the pinned surface contract matches the session package", () => {
    const root = packageRoot("@deepseek-ai/dsh-session");
    const declarations = readTypeDeclarations(root);
    // SurfaceOp = 'append' | { op: 'replace', start, end } — the CAS primitive.
    expect(declarations).toMatch(/SurfaceOp/);
    expect(declarations).toMatch(/op:\s*'replace'/);
    expect(declarations).toMatch(/sourceEventSeqs/);
  });
});
