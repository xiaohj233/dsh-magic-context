/**
 * Minimal ambient types for `js-yaml` (dev-only YAML tooling).
 *
 * `js-yaml@4` ships no bundled types and `@types/js-yaml` is not part of this
 * workspace's dependency graph, so the setup/doctor tools declare just the
 * surface they use (load/dump + the schema option the loader dialect needs).
 * The declaration is scoped to this package's compile program; the core
 * (`@magic-context/core/*`) does not import js-yaml.
 */
declare module "js-yaml" {
  export interface Schema {
    readonly name?: string;
    [key: string]: unknown;
  }
  export interface LoadOptions {
    schema?: Schema;
    [key: string]: unknown;
  }
  export interface DumpOptions {
    schema?: Schema;
    [key: string]: unknown;
  }
  export function load(input: string, options?: LoadOptions): unknown;
  export function dump(obj: unknown, options?: DumpOptions): string;
  export const JSON_SCHEMA: Schema;
  export const DEFAULT_SCHEMA: Schema;
}
