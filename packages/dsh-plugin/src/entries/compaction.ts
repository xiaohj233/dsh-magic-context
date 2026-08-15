/**
 * Subpath entry: `dsh-magic-context/compaction` — the Magic
 * compaction engine row the thin preset inserts into the isolated `compaction`
 * group (PLAN D3 / §5.1). Mirrors `@deepseek-ai/dsh-compaction-basic`'s
 * default-export-class shape so the loader instantiates it as the
 * `compaction` provider.
 */
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
export { MagicCompactionEngine };
export default MagicCompactionEngine;
