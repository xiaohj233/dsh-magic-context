/**
 * entries/preset-include — no-write file-backed loader tree for SHIPPED
 * compositions (the stock `standard` preset the thin preset includes).
 *
 * WHY: the loader's dispose handler writes a tree back to its source file
 * whenever it decides the config changed — a plugin self-disposing is enough,
 * and tearing an agent down disposes its whole subtree. The raw
 * `@deepseek-ai/cordis-plugin-include` tree inherits that write, so including
 * the SHIPPED stock composition through it truncates the stock file to `[]`
 * the first time a session ends. `@deepseek-ai/dsh-agent-presets` documents
 * exactly this hazard and defends against it with `PresetTree.write() = no-op`
 * ("A preset is an input, never a persistence target"); this entry is the same
 * defense for the thin preset's include row. The shipped composition is
 * read-only input; user state lives elsewhere, so dropping the write also
 * drops nothing that a session could persist.
 *
 * The row's `name` must be this entry's absolute file path (the thin preset
 * emits it via `magicEntryPath("preset-include")`) so the loader resolves the
 * class from THIS package instead of the stock directory's module walk.
 */
import { Include } from "@deepseek-ai/cordis-plugin-include";

export default class MagicPresetInclude extends Include {
  /** A shipped composition is an input, never a persistence target. */
  write(): void {
    // Intentionally empty: never rewrite the included stock file.
  }
}
