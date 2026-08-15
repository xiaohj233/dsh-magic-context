/**
 * entries/preset-include — contract test.
 *
 * The include row the thin preset emits for the SHIPPED stock composition must
 * resolve to a class that (a) IS the loader's own `Include` tree (same module
 * instance — the `EntryGroup.key` tree-carrier marker is inherited statically,
 * so the loader still recognizes the row as a file-backed subtree) and (b)
 * never writes its source file back (the loader's dispose handler would
 * otherwise truncate the shipped composition to `[]` on the first agent
 * teardown — see dsh-agent-presets' `PresetTree`).
 */
import { describe, expect, it } from "bun:test";
import { Include } from "@deepseek-ai/cordis-plugin-include";
import MagicPresetInclude from "./preset-include";

describe("magic preset-include entry (no-write include)", () => {
  it("is a subclass of the loader's own Include tree class", () => {
    expect(MagicPresetInclude.name).toBe("MagicPresetInclude");
    expect(Object.getPrototypeOf(MagicPresetInclude)).toBe(Include);
  });

  it("overrides write() with a no-op (shipped input, never a persistence target)", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      MagicPresetInclude.prototype,
      "write",
    );
    expect(descriptor).toBeDefined();
    // Calling it on a bare object must neither throw nor return anything.
    expect(
      descriptor!.value!.call({} as never),
    ).toBeUndefined();
  });

  it("inherits the loader's tree-carrier marker statically", () => {
    // Include declares `static readonly [EntryGroup.key] = true`; static class
    // fields are inherited, so the loader's carrier check still passes on the
    // subclass without us importing the marker symbol ourselves.
    expect(typeof (MagicPresetInclude as unknown as Record<string, unknown>).name).toBe(
      "string",
    );
    // The static block of the parent must be visible through the subclass:
    // construct a throwaway subclass-free check — any static property the
    // parent declares is reachable via the subclass's prototype chain.
    const proto = Object.getPrototypeOf(MagicPresetInclude) as typeof Include;
    // EntryGroup.key is a symbol; the carrier marker is the only static field
    // Include declares beyond standard Function fields.
    const keys = Reflect.ownKeys(proto);
    const marker = keys.find((key) => typeof key === "symbol");
    expect(marker).toBeDefined();
    expect((proto as unknown as Record<symbol, unknown>)[marker!]).toBe(true);
    expect((MagicPresetInclude as unknown as Record<symbol, unknown>)[marker!]).toBe(true);
  });
});
