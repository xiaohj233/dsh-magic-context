/**
 * Host half of dsh-magic-context (Phase 1 boundary).
 *
 * The bundle patch (cordis.patch.yml) mounts this row on the HOST plane:
 *   - id: magic-host
 *     name: 'dsh-magic-context'
 *     inject: []
 *
 * It boots the shared Magic SQLite store (with the DSH liveness marker), then
 * provides `ctx.magicContextHost` — the single host service the agent plane
 * and the Typert Remote consume. Full tool/command/dreamer registration lands
 * in Phase 2; this entry pins the boot contract and the service identity.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  bootstrapDshStorage,
  type DshStorageBootstrap,
} from "./host/bootstrap";
import { canonicalSessionKey, parseDshSessionKey } from "dsh-magic-context-adapter";

/** Cordis plugin name (loader diagnostics). */
export const name = "magic-context-dsh";

/** Host plugin configuration. */
export interface MagicHostConfig {
  /** Workspace/directory identity for config migration + liveness marker. */
  directory?: string;
  /** Loopback port for the liveness marker (0 in headless runs). */
  port?: number;
  /** SHA-256 first-8-hex of the DSH home for canonical session keys. */
  homeHash?: string;
}

/** The host service the adapter's planes consume. */
export interface MagicContextHostService {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
  /** Parse a canonical key back to the DSH-native session id. */
  parseKey(key: string): { homeHash: string; dshSessionId: string } | undefined;
  /**
   * Register the Magic compaction summarize hook. The agent plane registers it
   * at apply time; the compaction entry bundle reads it through the host
   * service (cross-bundle singleton — a module-level registry would be
   * duplicated per bundle).
   */
  registerSummarizeHook(hook: MagicSummarizeHook): void;
  /** The registered hook, if any (compaction engine bundle reads this). */
  summarizeHook(): MagicSummarizeHook | undefined;
}

/**
 * The compaction summarize hook contract (structural view — the pinned
 * SummarizationInput/SummaryResult types live in compat/dsh-0.1/compaction).
 */
export type MagicSummarizeHook = (
  input: unknown,
  agent: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Register the host service on `ctx` (idempotent per fiber). */
export function apply(ctx: Context, config: MagicHostConfig = {}): void {
  const directory = config.directory ?? process.cwd();
  const homeHash = config.homeHash ?? defaultHomeHash();
  const ready = bootstrapDshStorage({
    directory,
    port: config.port ?? 0,
    homeHash,
    log: (message) => ctx.logger?.info?.(message),
  });
  let summarizeHook: MagicSummarizeHook | undefined;
  const host: MagicContextHostService = {
    ready,
    canonicalKey(dshSessionId: string): string {
      return canonicalSessionKey(homeHash, dshSessionId);
    },
    parseKey(key: string) {
      return parseDshSessionKey(key);
    },
    registerSummarizeHook(hook: MagicSummarizeHook): void {
      summarizeHook = hook;
    },
    summarizeHook(): MagicSummarizeHook | undefined {
      return summarizeHook;
    },
  };
  ctx.provide("magicContextHost", host);
  // The `magicContext` Typert Remote is registered by the dedicated
  // `/remote` bundle row (`dsh-magic-context/remote`), NOT here —
  // the loader mounts both rows, so registering in both double-provides
  // `magicContextRemote` and fails the tree.
}

/** Deterministic home hash (first 8 hex of sha256 of the DSH home path). */
export function defaultHomeHash(): string {
  const home = process.env.DSH_HOME ?? requireHome();
  return hash8(home);
}

function requireHome(): string {
  // Fall back to the OS home; DSH always sets DSH_HOME in launched profiles.
  return process.env.HOME ?? process.env.USERPROFILE ?? "unknown-home";
}

function hash8(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
