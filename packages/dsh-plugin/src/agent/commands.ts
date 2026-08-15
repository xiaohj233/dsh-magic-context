/**
 * DSH /ctx-* command registration (Phase 2 slice B).
 *
 * Mirrors the Pi adapter's `pi-plugin/src/commands/` registrations: every
 * command body resolves the receiving agent → canonical Magic session key +
 * project identity and calls the shared core execution functions
 * (executeStatus / executeFlush / runManualDream / formatEmbedStatusText /
 * runSidekick / executeContextRecompWithResult / wrapup + upgrade variants).
 *
 * Output channel (dsh-reference §B.6): the DSH command registry renders the
 * handler's `CommandResult` directly in the dispatching UI — it is
 * model-invisible, exactly like Pi's `appendEntry` status entries, and never
 * routes into the model context.
 *
 * LLM-dependent commands (ctx-dream / ctx-aug / ctx-recomp / ctx-wrapup /
 * ctx-session-upgrade) run their full guard/validation logic here and call the
 * core functions through seams (`dreamerExecutor`, `runSidekick`,
 * `runRecomp`, `runWrapup`, `runUpgrade`) that the historian/dreamer/subagent
 * slices wire in. Until wired, they answer with an explicit "not wired"
 * message instead of failing.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { DEFAULT_PROTECTED_TAGS } from "@magic-context/core/features/magic-context/defaults";
import { getMostRecentTaskRunAt } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "@magic-context/core/features/magic-context/dreamer/task-gates";
import {
  CANONICAL_DREAM_TASKS,
  type DreamTaskName,
  formatDreamTaskBacklogs,
  isCanonicalDreamTask,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import type {
  DreamTaskRuntimeConfig,
  TaskExecutor,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { runManualDream } from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { getMemoryCount } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getPendingOps, getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { getOverflowState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import { executeStatus } from "@magic-context/core/hooks/magic-context/execute-status";
import { formatEmbedStatusText } from "@magic-context/core/hooks/magic-context/format-embed-status";
import { describeError } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getEmbeddingCoverageStatus } from "@magic-context/core/features/magic-context/project-embedding-registry";
import {
  errorResult,
  registerCommand,
  successResult,
  type CommandDefinition,
  type CommandResult,
} from "../compat/dsh-0.1/commands";
import { magicUserMessage } from "../compat/dsh-0.1/session";
import {
  cwdOf,
  resolveCanonicalKey,
  resolveDb,
  resolveProjectIdentity,
  type CtxRuntimeOptions,
} from "./tools";

export type { CommandDefinition };

/** Compaction-off guard text (Pi `COMPACTION_OFF_COMMAND_UNAVAILABLE` parity). */
const COMPACTION_OFF_UNAVAILABLE =
  "Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).";

/** Magic-owned message source marker for /ctx-aug follow-ups. */
const MAGIC_SOURCE = { kind: "plugin", plugin: "magic-context" } as const;

/** Seams wired by later slices (historian/dreamer/subagent). */
export interface CtxCommandSeams {
  /** Dreamer executor (dreamer slice): task configs + LLM executor for runManualDream. */
  dreamer?: {
    tasks: readonly DreamTaskRuntimeConfig[];
    executor: TaskExecutor;
    runnable?: boolean;
    scheduleSummary?: string;
  };
  /** Sidekick runner (subagent slice): run one augmentation prompt, return text. */
  runSidekick?: (deps: {
    agent: Agent;
    prompt: string;
    cwd?: string;
    projectIdentity?: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
  /** Recomp runner (historian slice): full/partial recomp; returns the status text. */
  runRecomp?: (deps: {
    agent: Agent;
    sessionId: string;
    cwd?: string;
    rawInput: string;
    signal: AbortSignal;
    db: Database;
  }) => Promise<string>;
  /** Wrapup runner (historian slice); returns the status text. */
  runWrapup?: (deps: {
    agent: Agent;
    sessionId: string;
    cwd?: string;
    messagesToKeep: number;
    signal: AbortSignal;
    db: Database;
  }) => Promise<string>;
  /** Session-upgrade runner (historian slice); returns the status text. */
  runUpgrade?: (deps: {
    agent: Agent;
    sessionId: string;
    cwd?: string;
    signal: AbortSignal;
    db: Database;
  }) => Promise<string>;
  /** Embedding drain runner for `/ctx-embed start|pause`. */
  runEmbedDrain?: (deps: {
    agent: Agent;
    sessionId: string;
    projectIdentity: string;
    cwd?: string;
    signal: AbortSignal;
    db: Database;
    action: "start" | "pause";
  }) => Promise<{ text: string; level: "success" | "info" | "error" }>;
}

/** Options for {@link registerCtxCommands}. */
export interface CtxCommandsOptions extends CtxRuntimeOptions, CtxCommandSeams {
  protectedTags?: number;
  executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
  executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
  historyBudgetPercentage?: number;
  commitClusterTrigger?: { enabled: boolean; min_clusters: number };
  compactionOff?: boolean;
  log?: (message: string) => void;
}

function modelKeyOf(agent: Agent): string | undefined {
  const { provider, model } = agent.options;
  if (provider && model) return `${provider}/${model}`;
  return undefined;
}

/** Read-only dreamer backlog for /ctx-status (best-effort). */
function dreamerBacklogFor(db: Database, projectIdentity: string | undefined) {
  if (!projectIdentity) return undefined;
  try {
    return getDreamTaskBacklogs(db, projectIdentity, CANONICAL_DREAM_TASKS);
  } catch {
    return undefined;
  }
}

/* ─────────────────────────────── /ctx-status ───────────────────────────── */

export function registerCtxStatusCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-status",
    description: "Show Magic Context status for the current DSH session",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        const meta = getOrCreateSessionMeta(db, sessionId);

        let detectedContextLimit: number | undefined;
        try {
          const detected = getOverflowState(db, sessionId).detectedContextLimit;
          if (detected > 0) detectedContextLimit = detected;
        } catch {
          // Status remains available when overflow metadata cannot be read.
        }

        const statusText = executeStatus(
          db,
          sessionId,
          opts.protectedTags ?? DEFAULT_PROTECTED_TAGS,
          opts.executeThresholdPercentage,
          modelKeyOf(agent),
          opts.historyBudgetPercentage,
          opts.commitClusterTrigger,
          opts.executeThresholdTokens,
          detectedContextLimit,
          { backlog: dreamerBacklogFor(db, projectIdentity) },
        );
        return successResult(statusText);
      } catch (error) {
        return errorResult(`## Magic Status — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

/* ─────────────────────────────── /ctx-flush ────────────────────────────── */

export function registerCtxFlushCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-flush",
    description: "Force pending Magic Context drops to materialize on the next provider call",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff) return errorResult(COMPACTION_OFF_UNAVAILABLE);
        const db = await resolveDb(ctx, opts);
        const pendingBefore = getPendingOps(db, sessionId).length;
        const result = executeFlush(db, sessionId);
        const text =
          pendingBefore > 0
            ? `## /ctx-flush\n\nFlushed ${pendingBefore} pending ops; next provider call will materialize.\n\n${result}`
            : `## /ctx-flush\n\n${result}`;
        return result.startsWith("Error:") ? errorResult(text) : successResult(text);
      } catch (error) {
        return errorResult(`## /ctx-flush — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

/* ─────────────────────────────── /ctx-dream ────────────────────────────── */

export function registerCtxDreamCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-dream",
    description: "Run Magic Context dreamer tasks for this project now",
    handler: async (invocation) => {
      const agent = invocation.agent;
      const requested = invocation.rawInput.trim();
      let task: DreamTaskName | undefined;
      if (requested) {
        if (!isCanonicalDreamTask(requested)) {
          return successResult(`## /ctx-dream\n\nUnknown task "${requested}".`);
        }
        task = requested;
      }
      if (opts.dreamer?.runnable === false) {
        return successResult(
          "## /ctx-dream\n\nDreamer is disabled for this project (`dreamer.disable=true`).",
        );
      }
      if (!opts.dreamer) {
        return successResult(
          "## /ctx-dream\n\nDreamer executor is not wired yet (Phase 2 slice C). The registered timer will run due tasks on its next tick.",
        );
      }
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        if (!projectIdentity) {
          return errorResult("## /ctx-dream\n\nCould not resolve project identity.");
        }

        const backlogTasks = task ? [task] : CANONICAL_DREAM_TASKS;
        const backlogBefore = getDreamTaskBacklogs(db, projectIdentity, backlogTasks);

        const result = await runManualDream({
          db,
          projectIdentity,
          tasks: opts.dreamer.tasks,
          executor: opts.dreamer.executor,
          ...(task ? { task } : {}),
        });

        const lines: string[] = ["## /ctx-dream", ""];
        if (result.ran.length > 0) lines.push(`Ran: ${result.ran.join(", ")}`);
        if (result.failed.length > 0) lines.push(`Failed: ${result.failed.join(", ")}`);
        if ((result.failureDetails?.length ?? 0) > 0) {
          lines.push(
            "Failure details:",
            ...(result.failureDetails ?? []).map((detail) => `- ${detail}`),
          );
        }
        if (result.skippedNoWork.length > 0) {
          lines.push(`Skipped (no work): ${result.skippedNoWork.join(", ")}`);
        }
        if (result.deferredBusy.length > 0) {
          lines.push(
            `Busy: ${result.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`,
          );
        }
        if (Object.keys(result.backlogAfter ?? {}).length > 0) {
          lines.push("", "Backlog at run end:", formatDreamTaskBacklogs(result.backlogAfter));
        }
        if (lines.length === 2) lines.push("No enabled dream tasks to run.");
        return successResult(lines.join("\n"));
      } catch (error) {
        return errorResult(
          `## /ctx-dream\n\nDream run failed: ${describeError(error).brief}\nThe registered timer will retry due tasks on its next tick.`,
        );
      }
    },
  });
}

/* ─────────────────────────────── /ctx-embed ────────────────────────────── */

export function registerCtxEmbedCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-embed",
    description: "Embedding status, or start/pause history compartment embedding (start | pause)",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        if (!projectIdentity) {
          return errorResult("## /ctx-embed\n\nCould not resolve project identity.");
        }
        const sub = invocation.rawInput.trim().toLowerCase();

        if (sub === "pause" || sub === "start") {
          if (!opts.runEmbedDrain) {
            return successResult(
              "## /ctx-embed\n\nThe embedding drain runner is not wired yet (Phase 2 slice C).",
            );
          }
          const { text, level } = await opts.runEmbedDrain({
            agent,
            sessionId,
            projectIdentity,
            cwd,
            signal: invocation.signal,
            db,
            action: sub === "pause" ? "pause" : "start",
          });
          return level === "error" ? errorResult(text) : successResult(text);
        }

        if (sub !== "") {
          return errorResult(
            "## /ctx-embed\n\nUsage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.",
          );
        }

        await opts.ensureProjectRegistered?.(cwd as string, db);
        const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
        const statusText = formatEmbedStatusText(coverage, { status: "idle" });
        return successResult(`## Embedding Status\n\n${statusText}`);
      } catch (error) {
        return errorResult(`## /ctx-embed — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

/* ──────────────────────────────── /ctx-aug ─────────────────────────────── */

export function registerCtxAugCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-aug",
    description: "Augment your prompt with relevant project context (sidekick)",
    handler: async (invocation) => {
      const agent = invocation.agent;
      const prompt = invocation.rawInput.trim();
      if (prompt.length === 0) {
        return errorResult(
          "/ctx-aug: Usage `/ctx-aug <your prompt>` — provide a prompt to augment with project memory context.",
        );
      }
      if (!opts.runSidekick) {
        return successResult(
          "/ctx-aug: Sidekick runner is not wired yet (Phase 2 slice C). Add `sidekick.model` to your magic-context.jsonc to enable this command.",
        );
      }
      try {
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        const sidekickText = await opts.runSidekick({
          agent,
          prompt,
          cwd,
          projectIdentity,
          signal: invocation.signal,
        });
        if (!sidekickText) {
          agent.followup(magicUserMessage(prompt, MAGIC_SOURCE));
          return successResult(
            "/ctx-aug: sidekick returned no augmentation; the prompt was sent unchanged.",
          );
        }
        const augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickText}\n</sidekick-augmentation>`;
        agent.followup(magicUserMessage(augmentedPrompt, MAGIC_SOURCE));
        return successResult(
          "/ctx-aug: augmentation queued as the next user message.",
        );
      } catch (error) {
        agent.followup(magicUserMessage(prompt, MAGIC_SOURCE));
        return successResult(
          `/ctx-aug: sidekick failed (${describeError(error).brief}). Sending prompt without augmentation.`,
        );
      }
    },
  });
}

/* ─────────────────────────────── /ctx-recomp ───────────────────────────── */

type RecompArgs =
  | { kind: "full" }
  | { kind: "partial"; range: { start: number; end: number } }
  | { kind: "upgrade" }
  | { kind: "error"; message: string };

const RECOMP_USAGE = [
  "Usage:",
  "- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
  "- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
  "- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout (Wave 3 runner)",
].join("\n");

/** Parse `/ctx-recomp` args (Pi `parseRecompArgs` parity). */
export function parseRecompArgs(raw: string): RecompArgs {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "full" };
  if (trimmed === "--upgrade") return { kind: "upgrade" };
  const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return { kind: "error", message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}` };
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (start < 1) return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
  if (end < start) return { kind: "error", message: `End must be >= start (got ${start}-${end}).` };
  return { kind: "partial", range: { start, end } };
}

interface RecompConfirmation {
  timestamp: number;
  argsKey: string;
}

const confirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

function buildConfirmationWarning(
  db: Database,
  sessionId: string,
  parsed: { kind: "full" } | { kind: "partial"; range: { start: number; end: number } },
): { text: string; confirmable: boolean } {
  const compartments = getCompartments(db, sessionId);
  if (parsed.kind === "partial") {
    return {
      confirmable: true,
      text: [
        "## ⚠️ Partial Recomp Confirmation Required",
        "",
        `Requested range: \`${parsed.range.start}-${parsed.range.end}\``,
        `This will rebuild ${compartments.length} compartment(s) (range snapping runs inside the recomp runner).`,
        "Facts will not be re-extracted.",
        "",
        `**To confirm, run \`/ctx-recomp ${parsed.range.start}-${parsed.range.end}\` again within 60 seconds.**`,
      ].join("\n"),
    };
  }
  return {
    confirmable: true,
    text: [
      "## ⚠️ Recomp Confirmation Required",
      "",
      `You currently have **${compartments.length}** compartments.`,
      "Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
      "",
      "This operation may take a long time and will consume historian-model tokens.",
      "",
      "**To confirm, run `/ctx-recomp` again within 60 seconds.**",
    ].join("\n"),
  };
}

export function registerCtxRecompCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-recomp",
    description: "Rebuild Magic Context compartments from raw DSH session history",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff) return errorResult(COMPACTION_OFF_UNAVAILABLE);

        const parsed = parseRecompArgs(invocation.rawInput);
        if (parsed.kind === "error") {
          return errorResult(`## Magic Recomp — Invalid Arguments\n\n${parsed.message}`);
        }

        const db = await resolveDb(ctx, opts);

        if (parsed.kind === "upgrade") {
          const legacyCount = getCompartments(db, sessionId).filter(
            (compartment) => compartment.legacy === 1,
          ).length;
          if (legacyCount === 0) {
            return successResult(
              "## Magic Recomp Upgrade\n\nNothing to upgrade: this session has no legacy compartments.",
            );
          }
          return successResult(
            [
              "## Magic Recomp Upgrade",
              "",
              `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
              "The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session.",
            ].join("\n"),
          );
        }

        if (!opts.runRecomp) {
          return successResult(
            "## Magic Recomp\n\nThe recomp runner is not wired yet (Phase 2 slice C).",
          );
        }

        const argsKey = parsed.kind === "partial" ? `${parsed.range.start}-${parsed.range.end}` : "";
        const now = Date.now();
        const confirmation = confirmationBySession.get(sessionId);
        const confirmed =
          confirmation !== undefined &&
          now - confirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS &&
          confirmation.argsKey === argsKey;

        if (!confirmed) {
          const warning = buildConfirmationWarning(db, sessionId, parsed);
          if (!warning.confirmable) confirmationBySession.delete(sessionId);
          else confirmationBySession.set(sessionId, { timestamp: now, argsKey });
          return warning.confirmable
            ? { kind: "success", text: warning.text }
            : errorResult(warning.text);
        }

        confirmationBySession.delete(sessionId);
        const cwd = cwdOf(agent);
        const result = await opts.runRecomp({
          agent,
          sessionId,
          cwd,
          rawInput: invocation.rawInput,
          signal: invocation.signal,
          db,
        });
        return inferCommandLevel(result);
      } catch (error) {
        return errorResult(`## Magic Recomp — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

function inferCommandLevel(text: string): CommandResult {
  const lower = text.toLowerCase();
  if (lower.includes("failed") || lower.includes("error") || lower.includes("incomplete")) {
    return errorResult(text);
  }
  return successResult(text);
}

/* ─────────────────────────────── /ctx-wrapup ───────────────────────────── */

const DEFAULT_MESSAGES_TO_KEEP = 20;

/** Parse `/ctx-wrapup [messages_to_keep]` (Pi `parseWrapupArgs` parity). */
export function parseWrapupArgs(
  raw: string,
): { ok: true; messagesToKeep: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, messagesToKeep: DEFAULT_MESSAGES_TO_KEEP };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message:
        "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
    };
  }
  const messagesToKeep = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
    return { ok: false, message: "messages_to_keep must be a positive integer." };
  }
  return { ok: true, messagesToKeep };
}

export function registerCtxWrapupCommand(ctx: Context, opts: CtxCommandsOptions): () => void {
  return registerCommand(ctx, {
    name: "ctx-wrapup",
    description: "Compact older Magic Context history while keeping the newest messages raw",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff) return errorResult(COMPACTION_OFF_UNAVAILABLE);

        const parsed = parseWrapupArgs(invocation.rawInput);
        if (!parsed.ok) {
          return errorResult(`## Magic Wrapup — Invalid Arguments\n\n${parsed.message}`);
        }
        if (!opts.runWrapup) {
          return successResult(
            "## Magic Wrapup\n\nThe wrapup runner is not wired yet (Phase 2 slice C).",
          );
        }
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const result = await opts.runWrapup({
          agent,
          sessionId,
          cwd,
          messagesToKeep: parsed.messagesToKeep,
          signal: invocation.signal,
          db,
        });
        return result.includes("Failed") || result.includes("Partial")
          ? errorResult(result)
          : successResult(result);
      } catch (error) {
        return errorResult(`## Magic Wrapup — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

/* ──────────────────────────── /ctx-session-upgrade ─────────────────────── */

export function registerCtxSessionUpgradeCommand(
  ctx: Context,
  opts: CtxCommandsOptions,
): () => void {
  return registerCommand(ctx, {
    name: "ctx-session-upgrade",
    description:
      "Upgrade this session to the current Magic Context history format and re-organize project memories",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId) return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff) return errorResult(COMPACTION_OFF_UNAVAILABLE);
        if (!opts.runUpgrade) {
          return successResult(
            "## Session Upgrade\n\nThe upgrade runner is not wired yet (Phase 2 slice C).",
          );
        }
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const result = await opts.runUpgrade({
          agent,
          sessionId,
          cwd,
          signal: invocation.signal,
          db,
        });
        return inferCommandLevel(result);
      } catch (error) {
        return errorResult(`## Session Upgrade — Failed\n\n${describeError(error).brief}`);
      }
    },
  });
}

/* ─────────────────────────────── registration ──────────────────────────── */

/**
 * Register all eight /ctx-* commands and return the combined disposer.
 * Every registration is reversible through `ctx.commands.register`'s disposer.
 */
export function registerCtxCommands(ctx: Context, opts: CtxCommandsOptions = {}): () => void {
  const disposers = [
    registerCtxStatusCommand(ctx, opts),
    registerCtxFlushCommand(ctx, opts),
    registerCtxDreamCommand(ctx, opts),
    registerCtxEmbedCommand(ctx, opts),
    registerCtxAugCommand(ctx, opts),
    registerCtxRecompCommand(ctx, opts),
    registerCtxWrapupCommand(ctx, opts),
    registerCtxSessionUpgradeCommand(ctx, opts),
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Best-effort unregistration.
      }
    }
  };
}
