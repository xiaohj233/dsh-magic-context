/**
 * Agent plane entry — `/agent` subpath of dsh-magic-context
 * (Phase 2 slice A: knowledge mode).
 *
 * Mounted on the AGENT plane (host-side plugin scope that observes every
 * agent), this plugin composes the four knowledge-mode pieces:
 *
 *   - system-guidance  — static `## Magic Context` prompt section (cache-stable);
 *   - session-track    — session → project attribution (session_projects rows);
 *   - knowledge-gate   — first-step m[0]/m[1] injection via agent.inject(),
 *                        once per session per surface generation (pre-step);
 *   - auto-search      — `<ctx-search-hint>` vague-recall blocks on new user
 *                        messages (fired from inside the gate).
 *
 * All side effects are fiber-owned: every registration goes through ctx.on /
 * ctx.effect / the section disposer, so stop/update/reload unwinds them.
 * `inject` lists ONLY the hard dependency (the host service); the systemPrompt
 * service is optional and read via ctx.get-style structural access.
 */
import type { Context } from "@deepseek-ai/cordis";
import { setDshHarness } from "dsh-magic-context-adapter";
import { loadPluginConfig, type MagicContextPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled, isDreamerRunnable, isHistorianRunnable } from "@magic-context/core/config/agent-disable";
import type { MagicContextHostService } from "../index";
import { registerKnowledgeGate } from "./knowledge-gate";
import type { KnowledgeConfig } from "./knowledge-gate";
import { registerSystemGuidance } from "./system-guidance";
import type { GuidanceConfig } from "./system-guidance";
import { registerSessionProjectTracking } from "./session-track";
import type { SessionTrackOptions } from "./session-track";
import type { AutoSearchConfig } from "./auto-search";
import { registerCtxTools, type CtxToolsOptions } from "./tools";
import { registerCtxCommands, type CtxCommandsOptions } from "./commands";
import { registerContextPlane, type ContextPlaneConfig, type ContextPlaneHistorianConfig } from "./context-plane";
import {
  registerMagicHistorianPlane,
  createLlmSummarizeCall,
  readContextPressure,
  currentModel,
} from "./historian-wiring";
import {
  runDshHistorian,
  signalDshDeferredHistoryRefresh,
  signalDshDeferredMaterialization,
} from "./historian";
import { dshDreamSeams, registerDshDreamer } from "./dreamer";
import { createRecompSeams } from "./recomp";
import { createSidekickSeam } from "./sidekick";
import { createEmbedSeam } from "./embed";
import { dshModelRefToCanonical } from "dsh-magic-context-adapter";
import { modelSupportsVision } from "@magic-context/core/shared/models-dev-cache";
import type { KnowledgeAgentView } from "./knowledge-gate";

/**
 * Mural wiring (Phase 4): vision-gated image-block injection on the m0
 * baseline. The vision gate uses the canonical model (adapter-api map) with
 * the core models.dev cache — unknown models fail closed (no image). The data
 * URL produced by the m0 fold is persisted via ctx.attachments.saveImage.
 */
function createMuralWiring(
  ctx: Context,
  enabled: boolean,
): NonNullable<Parameters<typeof registerKnowledgeGate>[1]["mural"]> {
  return {
    enabled,
    supportsVision: (agent: KnowledgeAgentView) => {
      const { provider, model } = agent.options;
      if (!provider || !model) return false;
      const canonical = dshModelRefToCanonical(`${provider}/${model}`);
      const separator = canonical.indexOf("/");
      if (separator <= 0) return false;
      return modelSupportsVision(canonical.slice(0, separator), canonical.slice(separator + 1));
    },
    resolveImage: async (dataUrl: string) => {
      const attachments = ctx.get("attachments") as
        | { saveImage?: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown> }
        | undefined;
      if (attachments?.saveImage === undefined) return null;
      const match = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(dataUrl);
      if (match === null) return null;
      const attachment = await attachments.saveImage({
        data: Buffer.from(match[2]!, "base64"),
        mediaType: `image/${match[1]!}`,
        name: "magic-mural.png",
      });
      return { type: "image", attachment };
    },
  };
}

/** Cordis plugin name (loader diagnostics). */
export const name = "magic-context-agent";

/** Hard dependency: the host plugin's storage/bootstrap service. */
export const inject = ["magicContextHost"];

/** Agent-plane plugin configuration (all sections optional; defaults are knowledge-mode). */
export interface MagicAgentConfig {
  /** Session workspace directory (header cwd wins per session). */
  directory?: string;
  /** m[0]/m[1] knowledge gate options. */
  knowledge?: KnowledgeConfig;
  /** Static guidance section options. */
  guidance?: GuidanceConfig;
  /** Auto-search hint options. */
  autoSearch?: AutoSearchConfig;
  /** Session → project tracking options. */
  sessionTracking?: SessionTrackOptions;
  /** Context-management plane (Phase 3): transcript/coordinator pre-step gate. */
  context?: ContextPlaneConfig;
  /** Historian background-pass trigger (Phase 4): pressure threshold config. */
  historian?: ContextPlaneHistorianConfig;
  /** Dreamer scheduler (Phase 4): per-project background tasks. */
  dreamer?: { enabled?: boolean; tickMs?: number };
  /** ctx_* tool registration options. */
  tools?: CtxToolsOptions;
  /** /ctx-* command registration options. */
  commands?: CtxCommandsOptions;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Internal: raw `dreamer` section bridged from the shared config. */
  _dreamerCore?: unknown;
}

/** Read the host service provided by the host entry (inject guarantees it). */
export function readMagicContextHost(ctx: Context): MagicContextHostService | undefined {
  return (ctx as unknown as { magicContextHost?: MagicContextHostService }).magicContextHost;
}

/**
 * Bridge the shared `magic-context.jsonc` (user + project) into the agent-plane
 * options. Pi loads the config per session (loadPiConfig); DSH previously ran
 * the agent plane on schema defaults only — the file was validated by doctor
 * but never consumed at runtime. Every mapping is a fallback: explicit row
 * config (preset/tests) still wins.
 */
export function bridgeMagicConfig(
  config: MagicAgentConfig,
  directory: string,
): MagicAgentConfig {
  let magic: MagicContextPluginConfig | undefined;
  try {
    magic = loadPluginConfig(directory);
  } catch {
    magic = undefined;
  }
  if (magic === undefined) return config;
  const cfg = magic;
  const thresholdRaw = cfg.execute_threshold_percentage;
  const threshold: number | undefined =
    typeof thresholdRaw === "number"
      ? thresholdRaw
      : typeof thresholdRaw === "object" && thresholdRaw !== null
        ? (typeof (thresholdRaw as { default?: unknown }).default === "number"
            ? (thresholdRaw as { default: number }).default
            : undefined)
        : undefined;
  const memoryCfg = cfg.memory;
  const dreamerCfg = cfg.dreamer;
  const compactionCfg = cfg.compaction;
  const muralCfg = cfg.mural;
  const commitCluster = cfg.commit_cluster_trigger;
  return {
    ...config,
    knowledge: {
      ...config.knowledge,
      injectDocs: config.knowledge?.injectDocs ?? dreamerCfg?.inject_docs ?? true,
      memoryInjectionBudgetTokens:
        config.knowledge?.memoryInjectionBudgetTokens ?? memoryCfg?.injection_budget_tokens,
      muralEnabled: config.knowledge?.muralEnabled ?? muralCfg?.enabled ?? false,
      cacheTtl: config.knowledge?.cacheTtl ?? (typeof cfg.cache_ttl === "string" ? cfg.cache_ttl : undefined),
    },
    context: {
      ...config.context,
      protectedTags: config.context?.protectedTags ?? cfg.protected_tags,
    },
    historian: {
      ...config.historian,
      executeThresholdPercentage: config.historian?.executeThresholdPercentage ?? threshold,
      commitClusterTrigger:
        config.historian?.commitClusterTrigger ??
        (commitCluster !== undefined
          ? { enabled: commitCluster.enabled ?? true, min_clusters: commitCluster.min_clusters ?? 3 }
          : undefined),
    },
    autoSearch: {
      ...config.autoSearch,
      enabled: config.autoSearch?.enabled ?? memoryCfg?.auto_search?.enabled ?? true,
    },
    tools: {
      ...config.tools,
      memoryToolEnabled: config.tools?.memoryToolEnabled ?? memoryCfg?.enabled !== false,
      dreamerEnabled: config.tools?.dreamerEnabled ?? isDreamerRunnable(cfg),
      compactionOff: config.tools?.compactionOff ?? !isCompactionEnabled(cfg),
      protectedTags: config.tools?.protectedTags ?? cfg.protected_tags,
    },
    commands: {
      ...config.commands,
      executeThresholdPercentage: config.commands?.executeThresholdPercentage ?? threshold,
      executeThresholdTokens: config.commands?.executeThresholdTokens ?? cfg.execute_threshold_tokens,
      historyBudgetPercentage: config.commands?.historyBudgetPercentage ?? cfg.history_budget_percentage,
      commitClusterTrigger:
        config.commands?.commitClusterTrigger ??
        (commitCluster !== undefined
          ? { enabled: commitCluster.enabled ?? true, min_clusters: commitCluster.min_clusters ?? 3 }
          : undefined),
      compactionOff: config.commands?.compactionOff ?? compactionCfg?.enabled === false,
    },
    dreamer: {
      ...config.dreamer,
      // 核心语义：dreamer 段存在且未 disable 即可运行（schema 无 enabled 键）
      enabled: config.dreamer?.enabled ?? isDreamerRunnable(cfg),
    },
    _dreamerCore: dreamerCfg,
  };
}

/** Raw `dreamer` section of the shared config (bridged by bridgeMagicConfig). */
export function dreamerCoreConfigOf(config: MagicAgentConfig): unknown {
  return (config as unknown as { _dreamerCore?: unknown })._dreamerCore;
}

export function apply(ctx: Context, config: MagicAgentConfig = {}): void {
  // The AGENT plane is a separate bundle from the host plane: each inlines its
  // own copy of the core's harness module, so the host's setDshHarness() never
  // reaches the storage calls this plane makes (session_meta / session_projects
  // / compartments…). Lock "dsh" HERE too, before any DB write — the core's
  // setHarness is idempotent for the same value and throws only on a mismatch.
  setDshHarness();
  config = bridgeMagicConfig(config, config.directory ?? process.cwd());
  const host = readMagicContextHost(ctx);
  if (!host) {
    throw new Error("magic-context-agent: magicContextHost service unavailable");
  }
  const log = (message: string) => ctx.logger?.info?.(message);
  const directory = config.directory ?? process.cwd();

  registerSystemGuidance(ctx, { config: config.guidance, log });

  registerSessionProjectTracking(ctx, {
    host,
    directory,
    config: config.sessionTracking,
    log,
  });

  // Context plane FIRST, so the knowledge gate below stays the outermost
  // pre-step listener (Phase 2 contract). The plane runs after it (inner):
  // outbox reconciliation + plan derivation + serialized surface application
  // + the historian context-pressure trigger (fire-and-forget background pass).
  registerContextPlane(ctx, {
    host,
    config: config.context,
    directory,
    historian: {
      config: config.historian,
      readPressure: readContextPressure(ctx),
      fire: ({ db, sessionId, directory: fireDirectory, provider }) => {
        // Fire-and-forget: the pass publishes atomically and only signals
        // deferred work; it must never block the pre-step chain.
        void runDshHistorian({
          db,
          sessionId,
          directory: fireDirectory,
          provider,
          summarize: createLlmSummarizeCall(ctx),
          model: currentModel(ctx),
          onPublished: () => {
            signalDshDeferredHistoryRefresh(sessionId);
            signalDshDeferredMaterialization(sessionId);
          },
          log,
        }).catch((error: unknown) => {
          log(`[magic-context] historian pass failed (background): ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    },
    log,
  });

  // Historian plane: the Magic compaction summarize hook (compartment digest
  // + sync mini-historian) registered on the host service, read back by the
  // compaction entry bundle at summarize() time (cross-bundle singleton).
  registerMagicHistorianPlane(ctx, {
    host,
    directory,
    log,
  });

  // Dreamer plane: per-project background scheduler (core lease/gate/telemetry
  // reused; self-built ctx timers — see dreamer.ts module doc for the
  // deviation from the core's process-singleton timer).
  registerDshDreamer(ctx, {
    host,
    directory,
    config: config.dreamer,
    coreConfig: dreamerCoreConfigOf(config),
    log,
  });

  registerKnowledgeGate(ctx, {
    host,
    config: { ...(config.knowledge ?? {}), directory },
    autoSearch: config.autoSearch ?? {},
    mural: createMuralWiring(ctx, config.knowledge?.muralEnabled === true),
    now: config.now,
    log,
  });

  // Tools + commands: registered on the agent plane (visible to every session
  // joining the magic-standard preset); the host service supplies the shared
  // DB and canonical session-key derivation.
  const runtime = {
    canonicalKey: (dshSessionId: string) => host.canonicalKey(dshSessionId),
    resolveProjectIdentity: undefined,
    log,
  };
  registerCtxTools(ctx, { ...runtime, ...(config.tools ?? {}) });

  // Phase 4 seams: dreamer / sidekick / recomp. The seam factories need the
  // shared DB, which the host bootstrap resolves asynchronously; fill the
  // seams lazily once `host.ready` settles (the commands read them at
  // invocation time and answer "not wired" until then).
  const seams = new Map<string, unknown>();
  void host.ready.then((bootstrap) => {
    if (bootstrap.kind !== "ok") return;
    seams.set(
      "dreamer",
      dshDreamSeams(ctx, {
        db: bootstrap.db,
        log,
        compactionOff: config.commands?.compactionOff === true,
      }),
    );
    seams.set("recomp", createRecompSeams({ ctx, host, directory, db: bootstrap.db, log }));
  });
  registerCtxCommands(ctx, {
    ...runtime,
    ...(config.commands ?? {}),
    get dreamer() {
      return seams.get("dreamer") as ReturnType<typeof dshDreamSeams> | undefined;
    },
    get runRecomp() {
      return (seams.get("recomp") as ReturnType<typeof createRecompSeams> | undefined)?.runRecomp;
    },
    get runWrapup() {
      return (seams.get("recomp") as ReturnType<typeof createRecompSeams> | undefined)?.runWrapup;
    },
    get runUpgrade() {
      return (seams.get("recomp") as ReturnType<typeof createRecompSeams> | undefined)?.runUpgrade;
    },
    // The sidekick seam resolves the DB itself at call time (host fallback).
    runSidekick: createSidekickSeam(ctx, {
      canonicalKey: (dshSessionId: string) => host.canonicalKey(dshSessionId),
      log,
    }),
    // The embed seam receives the DB at call time (no host dependency).
    runEmbedDrain: createEmbedSeam({ log }),
  });

  log(
    `[magic-context] agent plane ready: knowledge=${config.knowledge?.enabled !== false} ` +
      `guidance=${config.guidance?.enabled !== false} autoSearch=${config.autoSearch?.enabled !== false} ` +
      `sessionTracking=${config.sessionTracking?.enabled !== false} directory=${directory}`,
  );
}
