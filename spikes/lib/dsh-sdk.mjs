/**
 * dsh-sdk: resolve installed DSH 0.1.0-rc.6 packages to importable file URLs.
 *
 * The spikes run against the INSTALLED DSH packages (read-only). The canonical
 * copy used by the live harness lives under the global dsh CLI install's own
 * node_modules; the profile pnpm workspace links there.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export const DSH_PKG_ROOT =
  process.env.DSH_SPIKE_PKG_ROOT ??
  "D:\\Dev\\DevEnv\\Node\\npm-global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai";

/** Map a bare `@deepseek-ai/<name>` specifier to a file URL for its lib entry. */
export function dshUrl(specifier, entry = "lib/index.js") {
  if (!specifier.startsWith("@deepseek-ai/")) {
    throw new Error(`dshUrl: unsupported specifier ${specifier}`);
  }
  const name = specifier.slice("@deepseek-ai/".length);
  return pathToFileURL(join(DSH_PKG_ROOT, name, entry)).href;
}

/** Dynamic-import one DSH package's lib entry and return its namespace. */
export async function dshImport(specifier, entry = "lib/index.js") {
  return import(dshUrl(specifier, entry));
}

/** Import a subpath export of a DSH package (e.g. lib/types/foo.js). */
export async function dshImportSubpath(specifier, subpath) {
  return import(dshUrl(specifier, subpath));
}
