/**
 * compat/dsh-0.1 — the DSH compatibility layer (PLAN §2).
 *
 * Every `@deepseek-ai/dsh-*` import in this adapter lives behind this layer.
 * DSH upgrades原则上 only touch this directory, its contract fixtures, and the
 * dependency lock. The adapter's feature code depends only on this layer and
 * on `dsh-magic-context-adapter` (adapter-api).
 */
export * from "./session";
export * from "./compaction";
export * from "./prestep";
export * from "./tools";
export * from "./commands";
export * from "./subagent";
export * from "./typert";
export * from "./liveness";
export * from "./preset";
