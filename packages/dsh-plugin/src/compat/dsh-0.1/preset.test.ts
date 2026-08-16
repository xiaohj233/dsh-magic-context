import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  applyMagicPatches,
  buildThinPresetEntries,
  scanStockPresetLayout,
} from "./preset";

/** Minimal stand-in for the stock standard preset's compaction group. */
function stockLayout(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
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
    ...(overrides.extra ?? []),
  ];
}

describe("magic-standard thin preset (guarded patch)", () => {
  it("disables compaction-basic and inserts the Magic engine into the group", () => {
    const patched = applyMagicPatches(stockLayout(), {
      stockPresetPath: "/stock/standard/agent.cordis.yml",
    });
    const group = patched.find((row) => row.id === "compaction");
    const children = group?.config as Record<string, unknown>[];
    const basic = children.find((row) => row.id === "compaction-basic");
    expect(basic?.disabled).toBe(true);
    const engine = children.find((row) => row.id === "magic-compaction");
    expect(engine?.name).toBe("dsh-magic-context/compaction");
    expect((engine?.config as { auto?: boolean })?.auto).toBe(true);
    // Stock siblings untouched.
    expect(children.some((row) => row.id === "command-compact" && !row.disabled)).toBe(true);
    expect(children.some((row) => row.id === "tool-result-pruner" && !row.disabled)).toBe(true);
  });

  it("exactly one compaction provider remains", () => {
    const patched = applyMagicPatches(stockLayout(), {
      stockPresetPath: "/stock/standard/agent.cordis.yml",
    });
    const group = patched.find((row) => row.id === "compaction");
    const providers = (group?.config as Record<string, unknown>[])
      .filter((row) => !row.disabled)
      .filter((row) => String(row.id).includes("compaction"));
    expect(providers.map((row) => row.id)).toEqual(["magic-compaction"]);
  });

  it("contract scan rejects unknown layouts (fail closed)", () => {
    expect(scanStockPresetLayout(stockLayout())).toBeUndefined();
    expect(scanStockPresetLayout([])).toBe("compaction group row missing");
    // Rewrite the NESTED compaction-basic row inside the group's config.
    const renamedBasic = stockLayout().map((row) =>
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
    );
    expect(scanStockPresetLayout(renamedBasic)).toBe("compaction-basic name mismatch");
    expect(
      scanStockPresetLayout(
        stockLayout().map((row) =>
          row.id === "compaction"
            ? { ...row, isolate: { compaction: true } }
            : row,
        ),
      ),
    ).toBe("compaction group isolate realms mismatch");
  });

  it("buildThinPresetEntries emits the include row with guarded patches", () => {
    const thin = buildThinPresetEntries({
      stockPresetPath: "/stock/standard/agent.cordis.yml",
      magicRows: [{ id: "magic-agent", name: "dsh-magic-context/agent" }],
    });
    expect(thin.length).toBe(1);
    const include = thin[0];
    expect(include.id).toBe("magic-include-standard");
    // Without an explicit entry the row falls back to the raw include — only
    // for offline config tooling; setup/doctor always pass the no-write entry.
    expect(include.name).toBe("@deepseek-ai/cordis-plugin-include");
    const config = include.config as { path: string; patches: unknown[] };
    // Windows drive paths would parse as a URL scheme; the emitted include
    // path is the universal file:// URL form.
    expect(config.path).toBe("file:///stock/standard/agent.cordis.yml");
    expect(config.patches).toHaveLength(3);
  });

  it("include row names this package's no-write entry when includeEntry is set", () => {
    const thin = buildThinPresetEntries({
      stockPresetPath: "/stock/standard/agent.cordis.yml",
      includeEntry: "D:/pkg/dist/entries/preset-include.js",
      magicRows: [{ id: "magic-agent", name: "dsh-magic-context/agent" }],
    });
    const include = thin[0];
    // The shipped stock file must be mounted through a write()-no-op tree:
    // the raw include inherits the loader's write-back, which truncates the
    // shipped composition to `[]` on the first agent teardown.
    // pathToFileURL 语义：POSIX 上 "D:/..." 是相对路径（相对 cwd 解析）；
    // Windows 上是驱动器绝对路径。两侧都断言实现与 pathToFileURL 一致。
    expect(include.name).toBe(pathToFileURL("D:/pkg/dist/entries/preset-include.js").href);
    const config = include.config as { path: string; patches: unknown[] };
    expect(config.path).toBe("file:///stock/standard/agent.cordis.yml");
    expect(config.patches).toHaveLength(3);
  });

  it("emits absolute magic-row names as file:// URLs", () => {
    const thin = buildThinPresetEntries({
      stockPresetPath: "/stock/standard/agent.cordis.yml",
      includeEntry: "D:/pkg/dist/entries/preset-include.js",
      magicRows: [
        {
          id: "magic-agent",
          name: "D:\\pkg\\dist\\entries\\agent.js",
        },
      ],
    });
    const config = thin[0].config as { patches: { insert: Record<string, unknown>[] }[] };
    const magicAgent = (config.patches[2] as { insert: Record<string, unknown>[] }).insert[0];
    // 绝对路径才转 file:// URL；夹具按平台取绝对路径（Windows 驱动器盘符 /
    // POSIX 根路径），期望与 pathToFileURL 一致。
    const absoluteEntry = process.platform === "win32"
      ? "D:\\pkg\\dist\\entries\\agent.js"
      : "/pkg/dist/entries/agent.js";
    const magicRows = [
      { id: "magic-agent", name: absoluteEntry },
    ];
    const thin2 = buildThinPresetEntries({
      stockPresetPath: "/stock/standard/agent.cordis.yml",
      includeEntry: "D:/pkg/dist/entries/preset-include.js",
      magicRows,
    });
    const config2 = thin2[0].config as { patches: { insert: Record<string, unknown>[] }[] };
    const agent2 = (config2.patches[2] as { insert: Record<string, unknown>[] }).insert[0];
    expect(agent2.name).toBe(
      pathToFileURL(process.platform === "win32" ? "D:/pkg/dist/entries/agent.js" : "/pkg/dist/entries/agent.js").href,
    );
    // 原夹具（Windows 专属路径）在 POSIX 上按相对路径原样透传。
    expect(magicAgent.name).toBe(
      process.platform === "win32" ? "file:///D:/pkg/dist/entries/agent.js" : "D:\\pkg\\dist\\entries\\agent.js",
    );
  });

  it("thin preset round-trips through the loader YAML dialect", async () => {
    const yaml = await import("js-yaml");
    const { entryListSchema } = await import("@deepseek-ai/cordis-plugin-include");
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-preset-"));
    try {
      const file = join(dir, "agent.cordis.yml");
      const thin = buildThinPresetEntries({ stockPresetPath: "/stock/x.yml" });
      writeFileSync(file, yaml.dump(thin, { schema: entryListSchema }));
      const reloaded = yaml.load(readFileSync(file, "utf8"), { schema: entryListSchema });
      expect(reloaded).toEqual(thin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
