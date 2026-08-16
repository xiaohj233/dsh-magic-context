import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { dump as yamlDump } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { parseJsonc } from "@magic-context/core/shared/jsonc-parser";
import {
  runDshSetup,
  parseEntryListYaml,
  RECOMMENDED_CONFIG_KEYS,
} from "./setup";
import {
  MAGIC_CONTEXT_PACKAGE,
  magicEntryPath,
  magicStandardAgentCordisPath,
  magicStandardDir,
  magicStandardPresetYamlPath,
} from "./env";

/** Minimal stand-in for the stock standard preset layout (same as preset.test). */
function stockLayout(): Record<string, unknown>[] {
  return [
    { id: "persona", name: "@deepseek-ai/dsh-persona", config: { text: "x" } },
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner" },
      ],
    },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
  ];
}

function writeStockPreset(installDir: string, overrides: (rows: Record<string, unknown>[]) => Record<string, unknown>[] = (rows) => rows): string {
  // A dsh install root is identified by its package.json identity.
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }),
  );
  const file = join(installDir, "config", "agent-presets", "standard", "agent.cordis.yml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yamlDump(overrides(stockLayout()), { schema: entryListSchema }));
  return file;
}

interface TestEnv {
  root: string;
  dshHome: string;
  installDir: string;
  configHome: string;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-setup-"));
  return {
    root,
    dshHome: join(root, "dsh-home"),
    installDir: join(root, "install"),
    configHome: join(root, "config"),
  };
}

async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("dsh-magic-context setup (Phase 2 slice C)", () => {
  it("generates the thin preset structure and the user config", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      const stock = writeStockPreset(env.installDir);
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(report.exitCode).toBe(0);
      expect(report.steps.every((step) => step.status !== "fail")).toBe(true);

      // agent.cordis.yml = the single include row over the stock file.
      const agentCordisPath = magicStandardAgentCordisPath(env.dshHome);
      expect(report.generatedFiles).toContain(agentCordisPath);
      const entries = parseEntryListYaml(readFileSync(agentCordisPath, "utf8"));
      expect(entries).toHaveLength(1);
      const include = entries[0];
      expect(include.id).toBe("magic-include-standard");
      // The include row names THIS package's no-write entry (absolute file
      // path): the raw include would truncate the shipped stock composition
      // via the loader's write-back on the first agent teardown.
      expect(include.name).toBe(pathToFileURL(magicEntryPath("preset-include")).href);
      const config = include.config as { path: string; patches: unknown[] };
      // The include path is emitted as a file:// URL (Windows drive paths
      // would parse as a URL scheme).
      expect(config.path).toBe(pathToFileURL(stock).href);
      // compaction-basic disable + compaction insert + magicRows insert.
      expect(config.patches).toHaveLength(3);
      const magicRows = (config.patches[2] as { insert: Record<string, unknown>[] }).insert;
      // Nested-include rows resolve from the stock directory's module walk,
      // so Magic rows are emitted as absolute entry file paths.
      expect(
        magicRows.some(
          (row) =>
            row.id === "magic-agent" &&
            typeof row.name === "string" &&
            row.name.includes("entries") &&
            row.name.endsWith("agent.js"),
        ),
      ).toBe(true);
      const compactionRows = (
        config.patches[1] as { insert: Record<string, unknown>[] }
      ).insert;
      expect(
        compactionRows.some(
          (row) =>
            row.id === "magic-compaction" &&
            typeof row.name === "string" &&
            row.name.includes("entries") &&
            row.name.endsWith("compaction.js"),
        ),
      ).toBe(true);

      // preset.yml metadata.
      const presetYamlPath = magicStandardPresetYamlPath(env.dshHome);
      expect(report.generatedFiles).toContain(presetYamlPath);
      const presetYaml = readFileSync(presetYamlPath, "utf8");
      expect(presetYaml).toContain("name: Magic Context standard");
      expect(presetYaml).toContain("order: 10");

      // 0600 permissions (mode bits are meaningless on Windows).
      if (process.platform !== "win32") {
        expect(statSync(agentCordisPath).mode & 0o777).toBe(0o600);
        expect(statSync(presetYamlPath).mode & 0o777).toBe(0o600);
      }

      // User config created with defaults.
      const configPath = join(env.configHome, "cortexkit", "magic-context.jsonc");
      expect(report.generatedFiles).toContain(configPath);
      expect(existsSync(configPath)).toBe(true);
      const parsed = parseJsonc<{ enabled?: boolean }>(readFileSync(configPath, "utf8"));
      expect(parsed.enabled).toBe(true);

      // Next steps mention the profile install command.
      expect(report.nextSteps.some((line) => line.includes("dsh plugin"))).toBe(true);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails closed on a stock layout mismatch and writes nothing", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      writeStockPreset(env.installDir, (rows) =>
        rows.map((row) =>
          row.id === "compaction"
            ? {
                ...row,
                config: (row.config as Record<string, unknown>[]).map((child) =>
                  child.id === "compaction-basic"
                    ? { ...child, name: "some-other-package" }
                    : child,
                ),
              }
            : row,
        ),
      );
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(report.exitCode).toBe(1);
      expect(report.generatedFiles).toEqual([]);
      const scanStep = report.steps.find((step) => step.title.includes("contract scan"));
      expect(scanStep?.status).toBe("fail");
      // Fail closed: neither the preset nor the user config is written.
      expect(existsSync(magicStandardDir(env.dshHome))).toBe(false);
      expect(existsSync(join(env.configHome, "cortexkit", "magic-context.jsonc"))).toBe(false);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("never overwrites an existing user config and hints about missing keys", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      writeStockPreset(env.installDir);
      const configPath = join(env.configHome, "cortexkit", "magic-context.jsonc");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, '{\n  "enabled": false,\n  "custom": 1\n}\n', "utf8");

      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(report.exitCode).toBe(0);
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain('"custom": 1');
      expect(report.generatedFiles).not.toContain(configPath);

      const configStep = report.steps.find((step) => step.title.includes("user config"));
      expect(configStep?.status).toBe("warn");
      const missing = RECOMMENDED_CONFIG_KEYS.filter((key) => key !== "enabled");
      expect(configStep?.detail).toContain(missing[0]);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("writes nothing on --dry-run", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      writeStockPreset(env.installDir);
      const report = await runDshSetup(["--dry-run"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(report.exitCode).toBe(0);
      expect(report.generatedFiles).toEqual([]);
      expect(existsSync(magicStandardAgentCordisPath(env.dshHome))).toBe(false);
      expect(existsSync(join(env.configHome, "cortexkit", "magic-context.jsonc"))).toBe(false);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("reports a diagnosis when the DSH install cannot be found", async () => {
    const env = makeEnv();
    try {
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: join(env.root, "missing-install"),
        // 遮蔽 PATH：避免实现回退到本机真实 dsh 安装（环境敏感）
        env: { ...process.env, PATH: "/nonexistent-path" },
      });
      expect(report.exitCode).toBe(1);
      const installStep = report.steps.find((step) => step.title.includes("DSH install"));
      expect(installStep?.status).toBe("fail");
      expect(installStep?.detail).toContain("Probed");
    } finally {
      await cleanup(env.root);
    }
  });
});
