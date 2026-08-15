/**
 * DSH ctx_* tool registration (Phase 2 slice B).
 *
 * Mirrors the Pi adapter's `pi-plugin/src/tools/` thin wrappers: the shared
 * Magic core owns every business function (search / memory storage / notes /
 * expand rendering / pending-op queue), this module only
 *   1. declares the DSH `ToolDefinition` schemas (constants imported from the
 *      core tools/ctx-* constants modules, like Pi);
 *   2. resolves the calling agent → canonical Magic session key + project
 *      identity at execute time (see resolveAgentContext below);
 *   3. calls the core functions and projects the canonical `{text}` value
 *      through `output.render`.
 *
 * Registration goes through the compat `registerTool(ctx, tool)` seam; every
 * registered tool is scoped to the host plane and resolves its agent from
 * `exec.agent` per call. `ctx_reduce` is omitted when `compactionOff` is set
 * (parity with Pi tools/index.ts gating); `ctx_note`/`ctx_expand`/`ctx_reduce`
 * are session-scoped and omitted under `sessionScopedToolsDisabled`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { canonicalSessionKey } from "@xiao_hj909/magic-context-for-dsh-adapter";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
  archiveMemory,
  getMemoriesByIds,
  getMemoriesByProject,
  getMemoryByHash,
  getMemoryById,
  hasMemoryClassifiedAtColumn,
  hasMemoryShareableColumn,
  insertMemory,
  type Memory,
  type MemoryCategory,
  mergeMemoryStats,
  saveEmbedding,
  supersededMemory,
  updateMemoryContent,
  updateMemorySeenCount,
  V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
  embedTextForProject,
  getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateMemory } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
  normalizeStoredProjectPath,
  resolveProjectIdentityForSession,
  storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { getLastIndexedOrdinal } from "@magic-context/core/features/magic-context/message-index";
import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
  parseIdShapedQuery,
  resolveMemoriesByIdsForSearch,
  type UnifiedSearchResult,
  unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import {
  addNote,
  dismissNote,
  getNotes,
  getOrCreateSessionMeta,
  getPendingOps,
  getTagsBySession,
  queueMemoryMutation,
  queuePendingOp,
  setNoteLastReadAt,
  type ContextDatabase,
  type NoteStatus,
  updateNote,
  updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
  readSessionChunk,
  setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "@magic-context/core/tools/ctx-expand/constants";
import { renderMessageByOrdinal, renderVerboseRange } from "@magic-context/core/tools/ctx-expand/render";
import { CTX_MEMORY_DESCRIPTION } from "@magic-context/core/tools/ctx-memory/constants";
import { runImmediateTransaction } from "@magic-context/core/tools/ctx-memory/verification-recording";
import { CTX_NOTE_DESCRIPTION } from "@magic-context/core/tools/ctx-note/constants";
import { CTX_REDUCE_DESCRIPTION } from "@magic-context/core/tools/ctx-reduce/constants";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { registerTool } from "../compat/dsh-0.1/tools";
import { textBlock } from "../compat/dsh-0.1/session";
import { convertDshEventsToRawMessages } from "./transcript";

export type { ToolDefinition };

/* ────────────────────────── runtime resolution ────────────────────────── */

/**
 * Shared runtime options for the ctx_* tools (and, by extension, the /ctx-*
 * commands). Every LLM-independent input can be overridden in tests; the
 * production defaults resolve through the host's `magicContextHost` service.
 */
export interface CtxRuntimeOptions {
  /** Shared Magic SQLite. Defaults to the host bootstrap's DB (via `magicContextHost.ready`). */
  db?: Database | (() => Database | Promise<Database>);
  /** Canonical session-key derivation for a DSH session id. Defaults to `host.canonicalKey`. */
  canonicalKey?: (dshSessionId: string) => string | undefined;
  /** Home hash fallback when no host service is available (tests). */
  homeHash?: string;
  /** Project-identity resolution for a directory. Defaults to the core resolver. */
  resolveProjectIdentity?: (directory: string) => string | undefined;
  /** Allow the canonical home directory as a project identity (core resolver option). */
  allowHomeProject?: boolean;
  /** Embedding-provider registration for a directory (wired by a later slice). */
  ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
  /** Logger sink. */
  log?: (message: string) => void;
}

/** Options for {@link registerCtxTools}. */
export interface CtxToolsOptions extends CtxRuntimeOptions {
  memoryEnabled?: boolean;
  embeddingEnabled?: boolean;
  gitCommitsEnabled?: boolean;
  /** When false, omit ctx_memory from the registered surface (Pi parity). */
  memoryToolEnabled?: boolean;
  /** When true, omit session-scoped tools (ctx_note, ctx_expand, ctx_reduce). */
  sessionScopedToolsDisabled?: boolean;
  /** When true, omit ctx_reduce (compaction-off mode). */
  compactionOff?: boolean;
  /** Number of recent tags ctx_reduce treats as protected (deferred drops). */
  protectedTags?: number;
  /** When true, ctx_note accepts smart notes (dreamer will evaluate them). */
  dreamerEnabled?: boolean;
  /** When true, ctx_memory exposes the dreamer-only `list` action. */
  allowDreamerActions?: boolean;
  /** Raw-message source for ctx_expand. Defaults to the agent-session adapter below. */
  readRawMessages?: (agent: Agent) => RawMessage[];
}

/** Resolve the shared DB lazily (host bootstrap fallback). */
export async function resolveDb(ctx: Context, opts: CtxRuntimeOptions): Promise<Database> {
  if (opts.db !== undefined) {
    return typeof opts.db === "function" ? opts.db() : opts.db;
  }
  const host = ctx.get("magicContextHost") as
    | { ready?: Promise<{ kind: string; db?: Database }> }
    | undefined;
  const boot = await host?.ready;
  if (boot?.kind === "ok" && boot.db) return boot.db;
  throw new Error("Magic Context database is not available (host bootstrap not ready).");
}

/** Resolve the canonical Magic session key for an agent (see adapter-api harness.ts). */
export function resolveCanonicalKey(
  ctx: Context,
  opts: CtxRuntimeOptions,
  agent: Agent,
): string | undefined {
  const dshSessionId = String(agent.id);
  if (opts.canonicalKey !== undefined) return opts.canonicalKey(dshSessionId);
  const host = ctx.get("magicContextHost") as
    | { canonicalKey?: (id: string) => string }
    | undefined;
  const key = host?.canonicalKey?.(dshSessionId);
  if (key !== undefined) return key;
  if (opts.homeHash !== undefined && opts.homeHash.length > 0) {
    return canonicalSessionKey(opts.homeHash, dshSessionId);
  }
  return undefined;
}

/** Working directory of an agent's session (SessionHeader.cwd). */
export function cwdOf(agent: Agent): string | undefined {
  return agent.session?.header?.cwd;
}

/** Project identity for a directory (core resolver by default). */
export function resolveProjectIdentity(
  ctx: Context,
  opts: CtxRuntimeOptions,
  directory: string,
): string | undefined {
  if (opts.resolveProjectIdentity !== undefined) return opts.resolveProjectIdentity(directory);
  return resolveProjectIdentityForSession(directory, opts.allowHomeProject);
}

/** One resolved agent-execution context shared by every tool/command body. */
export interface AgentExecutionContext {
  readonly agent: Agent;
  /** Canonical Magic session key (dsh:<homeHash>:<id>) — the `session_id` written to the shared DB. */
  readonly sessionId: string | undefined;
  readonly nativeSessionId: string;
  readonly cwd: string | undefined;
  readonly projectIdentity: string | undefined;
}

/** Resolve everything a Magic tool call needs from the calling agent. */
export function resolveAgentContext(
  ctx: Context,
  opts: CtxRuntimeOptions,
  agent: Agent,
): AgentExecutionContext {
  return {
    agent,
    sessionId: resolveCanonicalKey(ctx, opts, agent),
    nativeSessionId: String(agent.id),
    cwd: cwdOf(agent),
    projectIdentity: cwdOf(agent)
      ? resolveProjectIdentity(ctx, opts, cwdOf(agent) as string)
      : undefined,
  };
}

/* ────────────────────────────── output shape ───────────────────────────── */

/** Canonical tool output: a single model-facing text projection. */
const TEXT_OUTPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", required: true } },
  additionalProperties: false,
} as const;

function renderTextOutput(_args: unknown, value: { text: string }): ContentBlock[] {
  return [textBlock(value.text)];
}

/** Strip the leading "Error: " prefix so the DSH registry renders exactly one. */
function toolError(message: string): Error {
  return new Error(message.replace(/^Error:\s*/, ""));
}

/* ─────────────────────────────── ctx_search ────────────────────────────── */

const DEFAULT_SEARCH_LIMIT = 10;
const NOTE_EXPAND_HINT =
  "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

interface CtxSearchArgs {
  query?: string;
  limit?: number;
  sources?: Array<"memory" | "message" | "git_commit" | "primer" | "note">;
}

function normalizeLimit(limit?: number, fallback = DEFAULT_SEARCH_LIMIT): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.floor(limit));
}

function formatAge(committedAtMs: number): string {
  const ageMs = Date.now() - committedAtMs;
  if (ageMs < 0) return "future";
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1mo ago";
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatSearchResult(
  result: UnifiedSearchResult,
  index: number,
  currentSessionId: string,
): string {
  if (result.source === "memory") {
    const source = result.sourceName ? ` source=${result.sourceName}` : "";
    return [
      `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category}${source} match=${result.matchType}`,
      result.content,
    ].join("\n");
  }
  if (result.source === "git_commit") {
    return [
      `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatAge(result.committedAtMs)} match=${result.matchType}`,
      result.content,
    ].join("\n");
  }
  if (result.source === "primer") {
    return [
      `[${index}] [primer] score=${result.score.toFixed(2)} id=${result.primerId} support=${result.support} match=${result.matchType}`,
      result.content,
    ].join("\n");
  }
  if (result.source === "note") {
    const anchor =
      result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId
        ? ` @msg ${result.anchorOrdinal}`
        : "";
    return [
      `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatAge(result.createdAt)}${anchor}`,
      result.content,
    ].join("\n");
  }
  if (result.source === "compartment") {
    return [
      `[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
      result.snippet ? `Snippet: ${result.snippet}` : result.content,
    ].join("\n");
  }
  const expandStart = Math.max(1, result.messageOrdinal - 3);
  const expandEnd = result.messageOrdinal + 3;
  return [
    `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
    result.content,
  ].join("\n");
}

function formatSearchResults(
  query: string,
  results: UnifiedSearchResult[],
  currentSessionId: string,
): string {
  if (results.length === 0) {
    return `No results found for "${query}" across notes, memories, primers, git commits, or message history.`;
  }
  const bodyParts = results.map((result, index) =>
    formatSearchResult(result, index + 1, currentSessionId),
  );
  if (
    results.some(
      (result) => result.source === "message" || result.source === "compartment",
    )
  ) {
    bodyParts.push(
      "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
    );
  }
  if (
    results.some(
      (result) =>
        result.source === "note" &&
        result.anchorOrdinal !== null &&
        result.sourceSessionId === currentSessionId,
    )
  ) {
    bodyParts.push(NOTE_EXPAND_HINT);
  }
  const body = bodyParts.join("\n\n");
  return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

export function createCtxSearchTool(ctx: Context, opts: CtxToolsOptions): ToolDefinition {
  return defineTool({
    name: "ctx_search",
    description: CTX_SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: "string",
        description:
          "Search query. Matches against memory content, Primers, git commit messages, and raw user/assistant message text.",
      },
      limit: {
        type: "integer",
        description: "Maximum results to return (default: 10)",
      },
      sources: {
        type: "array",
        items: {
          type: "string",
          enum: ["memory", "message", "git_commit", "primer", "note"],
        },
        description:
          'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["memory"] for naming conventions, ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups. Omit for a broad search across all enabled sources.',
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextOutput },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw toolError("'ctx_search' requires an agent execution context.");
      const params = unwrapImitatedReducedArgs(args as Record<string, unknown>, ["query"], {
        query: "string",
        limit: "number",
        sources: {
          type: "array",
          items: "string",
          maxItems: 5,
          values: ["memory", "message", "git_commit", "primer", "note"],
        },
      }) as CtxSearchArgs;
      const query = params.query?.trim();
      if (!query) throw toolError("'query' is required.");

      const runtime = resolveAgentContext(ctx, opts, agent);
      if (!runtime.sessionId) throw toolError("Could not resolve the canonical session id for this agent.");
      if (!runtime.cwd) throw toolError("Could not resolve the working directory for this agent.");
      if (!runtime.projectIdentity) {
        throw toolError("Could not resolve project identity for search.");
      }
      const db = await resolveDb(ctx, opts);
      await opts.ensureProjectRegistered?.(runtime.cwd, db);

      const snapshot = getProjectEmbeddingSnapshot(runtime.projectIdentity);
      const memoryEnabled =
        snapshot?.features.memoryEnabled ?? opts.memoryEnabled;
      const embeddingEnabled = snapshot
        ? snapshot.enabled || snapshot.gitCommitEnabled
        : opts.embeddingEnabled;
      const gitCommitsEnabled =
        snapshot?.gitCommitEnabled ?? opts.gitCommitsEnabled ?? false;

      // Search message history only up to the last compartment boundary; the
      // live tail (including the current turn) is already visible to the agent.
      const lastCompartmentEnd = getLastCompartmentEndMessage(db, runtime.sessionId);
      const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

      const visibleMemoryIds = getVisibleMemoryIds(db, runtime.sessionId);

      // ID-shaped short-circuit (parity with OpenCode/Pi ctx_search).
      const idShape = parseIdShapedQuery(query);
      if (idShape && memoryEnabled) {
        const idResults = resolveMemoriesByIdsForSearch({
          db,
          projectPath: runtime.projectIdentity,
          ids: idShape,
          limit: Math.max(normalizeLimit(params.limit), idShape.length),
          visibleMemoryIds,
        });
        if (idResults !== null) {
          return { text: formatSearchResults(query, idResults, runtime.sessionId) };
        }
      }

      const results = await unifiedSearch(db, runtime.sessionId, runtime.projectIdentity, query, {
        limit: normalizeLimit(params.limit),
        memoryEnabled,
        embeddingEnabled,
        embedQuery: async (text, signal) => {
          const result = await embedTextForProject(runtime.projectIdentity as string, text, signal, "query");
          return result?.vector ?? null;
        },
        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
        maxMessageOrdinal: messageOrdinalCutoff,
        gitCommitsEnabled,
        sources: params.sources,
        visibleMemoryIds,
        explicitSearch: true,
      });
      return { text: formatSearchResults(query, results, runtime.sessionId) };
    },
  });
}

/* ─────────────────────────────── ctx_memory ────────────────────────────── */

const ALL_ACTIONS = ["write", "archive", "update", "merge", "get", "list"] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];
const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["list"]);
const GET_MAX_IDS = 20;
const DEFAULT_LIST_LIMIT = 10;

const MEMORY_CATEGORIES = new Set<string>(V2_MEMORY_CATEGORIES);

/** Narrow a caller-supplied category to the core's closed MemoryCategory union. */
function asMemoryCategory(value: string | undefined): MemoryCategory | undefined {
  return value !== undefined && MEMORY_CATEGORIES.has(value) ? (value as MemoryCategory) : undefined;
}

interface CtxMemoryArgs {
  action?: CtxMemoryAction;
  content?: string;
  category?: string;
  ids?: number[];
  limit?: number;
  reason?: string;
}

function formatMemoryList(memories: Memory[]): string {
  if (memories.length === 0) return "No active memories found.";
  const rows = memories.map((m) => ({
    id: String(m.id),
    category: m.category,
    status: m.status,
    verification: m.verificationStatus,
    updated: new Date(m.updatedAt).toISOString(),
    content: m.content.replace(/\s+/g, " ").trim(),
  }));
  const headers = {
    id: "ID",
    category: "CATEGORY",
    status: "STATUS",
    verification: "VERIFY",
    updated: "UPDATED",
    content: "CONTENT",
  };
  const widths = {
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    category: Math.max(headers.category.length, ...rows.map((r) => r.category.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    verification: Math.max(headers.verification.length, ...rows.map((r) => r.verification.length)),
    updated: Math.max(headers.updated.length, ...rows.map((r) => r.updated.length)),
  };
  const fmt = (r: (typeof rows)[number] | typeof headers) =>
    [
      r.id.padEnd(widths.id),
      r.category.padEnd(widths.category),
      r.status.padEnd(widths.status),
      r.verification.padEnd(widths.verification),
      r.updated.padEnd(widths.updated),
      r.content,
    ].join(" | ");
  return [
    `Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
    "",
    fmt(headers),
    [
      "-".repeat(widths.id),
      "-".repeat(widths.category),
      "-".repeat(widths.status),
      "-".repeat(widths.verification),
      "-".repeat(widths.updated),
      "-------",
    ].join("-+-"),
    ...rows.map(fmt),
  ].join("\n");
}

function isPrimaryMutableMemory(memory: Memory): boolean {
  return (
    (memory.status === "active" || memory.status === "permanent") &&
    memory.supersededByMemoryId === null
  );
}

function inactiveMemoryError(id: number, action: "updating" | "merging" | "archiving"): string {
  return `Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

function formatGetOutput(args: { requestedIds: number[]; memoriesById: Map<number, Memory> }): string {
  const parts: string[] = [];
  for (const id of args.requestedIds) {
    const memory = args.memoriesById.get(id);
    parts.push(memory ? formatMemoryList([memory]) : `id ${id}: not found or not visible from this project`);
  }
  return parts.join("\n\n");
}

function updateMemoryContentInCurrentTransaction(
  db: ContextDatabase,
  memory: Memory,
  content: string,
  normalizedHash: string,
): void {
  db.prepare(
    "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
  ).run(content, normalizedHash, Date.now(), memory.id);
  if (hasMemoryShareableColumn(db)) {
    db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
  }
  if (hasMemoryClassifiedAtColumn(db)) {
    db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
  }
  db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
  invalidateMemory(memory.projectPath, memory.id);
}

function queueEmbedding(args: {
  db: ContextDatabase;
  projectIdentity: string;
  memoryId: number;
  content: string;
}): void {
  const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
  if (!snapshot?.enabled) return;
  void (async () => {
    try {
      const result = await embedTextForProject(args.projectIdentity, args.content);
      if (!result) return;
      saveEmbedding(args.db, args.memoryId, result.vector, result.modelId);
    } catch {
      // Best-effort background embedding; the next backfill pass retries.
    }
  })();
}

export function createCtxMemoryTool(ctx: Context, opts: CtxToolsOptions): ToolDefinition {
  const dreamerAllowed = opts.allowDreamerActions === true;
  return defineTool({
    name: "ctx_memory",
    description: dreamerAllowed
      ? `${CTX_MEMORY_DESCRIPTION}\n- list: enumerate stored memories (maintenance sessions).`
      : CTX_MEMORY_DESCRIPTION,
    parameters: {
      action: {
        type: "string",
        enum: [...ALL_ACTIONS],
        description: "What to do: write, update, archive, merge, get, or list",
      },
      content: {
        type: "string",
        description: "The memory text — one standalone fact (required for write, update, merge)",
      },
      category: {
        type: "string",
        enum: [...V2_MEMORY_CATEGORIES],
        description: "What kind of fact this is (required for write; optional merge override)",
      },
      ids: {
        type: "array",
        items: { type: "integer" },
        description:
          "Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more, get one to twenty",
      },
      limit: { type: "integer", description: "Max results for list (default: 10)" },
      reason: {
        type: "string",
        description: "Why the memory is being archived (optional, recommended)",
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextOutput },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw toolError("'ctx_memory' requires an agent execution context.");
      const params = unwrapImitatedReducedArgs(args as Record<string, unknown>, ["action"], {
        action: { type: "enum", values: ALL_ACTIONS },
        content: "string",
        category: { type: "enum", values: V2_MEMORY_CATEGORIES },
        ids: { type: "array", items: "number", maxItems: 100 },
        limit: "number",
        reason: "string",
      }) as CtxMemoryArgs;
      if (params.action === undefined) {
        throw toolError("Action 'undefined' is not allowed in this context.");
      }
      if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
        throw toolError(`Action '${params.action}' is not allowed in this context.`);
      }

      const runtime = resolveAgentContext(ctx, opts, agent);
      if (!runtime.sessionId) throw toolError("Could not resolve the canonical session id for this agent.");
      if (!runtime.cwd) throw toolError("Could not resolve the working directory for this agent.");
      if (!runtime.projectIdentity) {
        throw toolError("Could not resolve project identity for memory action.");
      }
      const projectIdentity = runtime.projectIdentity;
      const db = await resolveDb(ctx, opts);
      await opts.ensureProjectRegistered?.(runtime.cwd, db);

      const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
      if (snapshot ? !snapshot.features.memoryEnabled : opts.memoryEnabled === false) {
        throw toolError("Cross-session memory is disabled for this project.");
      }

      // Single-identity ownership (workspace multi-identity expansion is a
      // later slice; the default single-project path matches Pi/OpenCode).
      const memoryOwnedByTool = (memory: Memory): boolean =>
        storedPathBelongsToIdentity(memory.projectPath, projectIdentity);

      const { action } = params;

      if (action === "write") {
        const content = params.content?.trim();
        if (!content) throw toolError("'content' is required when action is 'write'.");
        const rawCategory = asMemoryCategory(params.category);
        if (!rawCategory) throw toolError("'category' is required when action is 'write'.");

        const existing = getMemoryByHash(db, projectIdentity, rawCategory, computeNormalizedHash(content));
        if (existing) {
          updateMemorySeenCount(db, existing.id);
          return {
            text: `Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`,
          };
        }
        const memory = insertMemory(db, {
          projectPath: projectIdentity,
          category: rawCategory,
          content,
          sourceSessionId: runtime.sessionId,
          sourceType: dreamerAllowed ? "dreamer" : "agent",
        });
        queueEmbedding({ db, projectIdentity, memoryId: memory.id, content });
        return { text: `Saved memory [ID: ${memory.id}] in ${rawCategory}.` };
      }

      if (action === "list") {
        const limit = normalizeLimit(params.limit, DEFAULT_LIST_LIMIT);
        const filtered = getMemoriesByProject(db, projectIdentity);
        const category = params.category;
        const filtered2 = category ? filtered.filter((m) => m.category === category) : filtered;
        return { text: formatMemoryList(filtered2.slice(0, limit)) };
      }

      if (action === "get") {
        const getIds = params.ids;
        if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
          throw toolError("'ids' must contain at least one integer memory ID when action is 'get'.");
        }
        if (getIds.length > GET_MAX_IDS) {
          throw toolError(`'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`);
        }
        const uniqueIds = [...new Set(getIds)];
        const fetched = getMemoriesByIds(db, uniqueIds);
        const memoriesById = new Map<number, Memory>(
          fetched.filter((memory) => memoryOwnedByTool(memory)).map((memory) => [memory.id, memory]),
        );
        return { text: formatGetOutput({ requestedIds: uniqueIds, memoriesById }) };
      }

      if (action === "update") {
        const updateIds = params.ids;
        if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
          throw toolError("'ids' must contain exactly one integer memory ID when action is 'update'.");
        }
        const updateId = updateIds[0];
        const content = params.content?.trim();
        if (!content) throw toolError("'content' is required when action is 'update'.");

        const memory = getMemoryById(db, updateId);
        if (!memory || !memoryOwnedByTool(memory)) {
          throw toolError(`Memory with ID ${updateId} was not found.`);
        }
        if (!isPrimaryMutableMemory(memory)) {
          throw toolError(inactiveMemoryError(updateId, "updating"));
        }
        const normalizedHash = computeNormalizedHash(content);
        const duplicate = getMemoryByHash(db, projectIdentity, memory.category, normalizedHash);
        if (duplicate && duplicate.id !== memory.id) {
          throw toolError(
            `Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
          );
        }
        runImmediateTransaction(db, () => {
          updateMemoryContentInCurrentTransaction(db, memory, content, normalizedHash);
          queueMemoryMutation(db, {
            projectPath: normalizeStoredProjectPath(projectIdentity),
            mutationType: "update",
            targetMemoryId: memory.id,
            category: memory.category,
            newContent: content,
          });
        });
        queueEmbedding({ db, projectIdentity, memoryId: memory.id, content });
        return { text: `Updated memory [ID: ${memory.id}] in ${memory.category}.` };
      }

      if (action === "merge") {
        const ids = params.ids;
        if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
          throw toolError("'ids' must include at least two integer memory IDs when action is 'merge'.");
        }
        if (new Set(ids).size !== ids.length) {
          throw toolError("'ids' must include at least two distinct memory IDs when action is 'merge'.");
        }
        const content = params.content?.trim();
        if (!content) throw toolError("'content' is required when action is 'merge'.");

        const sourceMemories = ids
          .map((id) => getMemoryById(db, id))
          .filter((memory): memory is Memory => Boolean(memory));
        if (sourceMemories.length !== ids.length) {
          throw toolError("One or more source memories were not found.");
        }
        const foreign = sourceMemories.find((memory) => !memoryOwnedByTool(memory));
        if (foreign) throw toolError(`Memory with ID ${foreign.id} was not found.`);
        const inactive = sourceMemories.find((memory) => !isPrimaryMutableMemory(memory));
        if (inactive) throw toolError(inactiveMemoryError(inactive.id, "merging"));

        const sourceCategories = new Set(sourceMemories.map((memory) => memory.category));
        if (sourceCategories.size > 1) {
          throw toolError(
            `Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
          );
        }
        const category: MemoryCategory | undefined =
          asMemoryCategory(params.category) ?? sourceMemories[0]?.category;
        if (!category) throw toolError("A valid category is required when action is 'merge'.");

        const normalizedHash = computeNormalizedHash(content);
        const duplicate = getMemoryByHash(db, projectIdentity, category, normalizedHash);
        const canonicalExisting = duplicate && ids.includes(duplicate.id) ? duplicate : null;
        if (duplicate && !canonicalExisting) {
          throw toolError(
            `Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`,
          );
        }

        const mergedSeenCount = sourceMemories.reduce((sum, memory) => sum + memory.seenCount, 0);
        const mergedRetrievalCount = sourceMemories.reduce(
          (sum, memory) => sum + memory.retrievalCount,
          0,
        );
        const mergedFromIds = Array.from(
          new Set(
            sourceMemories.flatMap((memory) => {
              let parsed: unknown[] = [];
              try {
                parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
              } catch {
                parsed = [];
              }
              const priorIds = Array.isArray(parsed)
                ? parsed.filter((value): value is number => typeof value === "number")
                : [];
              return [memory.id, ...priorIds];
            }),
          ),
        ).sort((left, right) => left - right);
        const mergedFrom = JSON.stringify(mergedFromIds);
        const mergedStatus: "active" | "permanent" = sourceMemories.some(
          (memory) => memory.status === "permanent",
        )
          ? "permanent"
          : "active";

        let canonicalMemory!: Memory;
        db.transaction(() => {
          let canonicalContentChanged = false;
          if (canonicalExisting) {
            canonicalMemory = canonicalExisting;
            canonicalContentChanged =
              canonicalMemory.content !== content || canonicalMemory.normalizedHash !== normalizedHash;
            if (canonicalContentChanged) {
              updateMemoryContent(db, canonicalMemory.id, content, normalizedHash);
            }
          } else {
            canonicalMemory = insertMemory(db, {
              projectPath: projectIdentity,
              category,
              content,
              sourceSessionId: runtime.sessionId,
              sourceType: dreamerAllowed ? "dreamer" : "agent",
            });
          }
          mergeMemoryStats(
            db,
            canonicalMemory.id,
            mergedSeenCount,
            mergedRetrievalCount,
            mergedFrom,
            mergedStatus,
          );
          for (const memory of sourceMemories) {
            if (memory.id === canonicalMemory.id) continue;
            supersededMemory(db, memory.id, canonicalMemory.id);
            queueMemoryMutation(db, {
              projectPath: normalizeStoredProjectPath(memory.projectPath),
              mutationType: "superseded",
              targetMemoryId: memory.id,
              supersededById: canonicalMemory.id,
            });
          }
          if (canonicalExisting && canonicalContentChanged) {
            queueMemoryMutation(db, {
              projectPath: normalizeStoredProjectPath(canonicalMemory.projectPath),
              mutationType: "update",
              targetMemoryId: canonicalMemory.id,
              category,
              newContent: content,
            });
          }
        })();

        queueEmbedding({ db, projectIdentity, memoryId: canonicalMemory.id, content });
        const supersededIds = sourceMemories
          .map((memory) => memory.id)
          .filter((id) => id !== canonicalMemory.id);
        return {
          text: `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`,
        };
      }

      if (action === "archive") {
        const rawArchiveIds = params.ids;
        if (!rawArchiveIds || rawArchiveIds.length === 0 || !rawArchiveIds.every(Number.isInteger)) {
          throw toolError("'ids' must contain at least one integer memory ID when action is 'archive'.");
        }
        const archiveIds = [...new Set(rawArchiveIds)];
        for (const memoryId of archiveIds) {
          const memory = getMemoryById(db, memoryId);
          if (!memory || !memoryOwnedByTool(memory)) {
            throw toolError(`Memory with ID ${memoryId} was not found.`);
          }
          if (!isPrimaryMutableMemory(memory)) {
            throw toolError(inactiveMemoryError(memoryId, "archiving"));
          }
        }
        runImmediateTransaction(db, () => {
          for (const memoryId of archiveIds) {
            archiveMemory(db, memoryId, params.reason);
            queueMemoryMutation(db, {
              projectPath: normalizeStoredProjectPath(projectIdentity),
              mutationType: "archive",
              targetMemoryId: memoryId,
            });
          }
        });
        const reasonSuffix = params.reason ? ` (${params.reason})` : "";
        const idList = archiveIds.join(", ");
        const plural = archiveIds.length > 1 ? "memories" : "memory";
        return { text: `Archived ${plural} [ID: ${idList}]${reasonSuffix}.` };
      }

      throw toolError("Unknown action.");
    },
  });
}

/* ──────────────────────────────── ctx_note ─────────────────────────────── */

const FILTER_VALUES = ["active", "pending", "ready", "dismissed", "all"] as const;
type CtxNoteReadFilter = (typeof FILTER_VALUES)[number];
const DEFAULT_READ_LIMIT = 25;
const DISMISS_FOOTER =
  '\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

interface CtxNoteArgs {
  action?: "write" | "read" | "dismiss" | "update";
  content?: string;
  surface_condition?: string;
  note_id?: number;
  filter?: CtxNoteReadFilter;
  limit?: number;
  offset?: number;
}

/** Capture the live-tail message ordinal so a note can be traced back (best-effort). */
function captureAnchorOrdinal(db: ContextDatabase, sessionId: string): number | null {
  try {
    const ordinal = getLastIndexedOrdinal(db, sessionId);
    return ordinal > 0 ? ordinal : null;
  } catch {
    return null;
  }
}

function anchorSuffix(note: { anchorOrdinal: number | null }): string {
  return note.anchorOrdinal !== null ? ` ↳ @msg ${note.anchorOrdinal}` : "";
}

function formatNoteLine(note: {
  id: number;
  type: string;
  status: string;
  content: string;
  anchorOrdinal: number | null;
  readyReason: string | null;
  surfaceCondition: string | null;
}): string {
  if (note.type === "smart") {
    const conditionLine =
      note.status === "ready"
        ? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
        : (note.surfaceCondition ?? "No condition recorded");
    const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
    return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}\n  *Condition*: ${conditionLine}`;
  }
  const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
  return `- **#${note.id}**${statusSuffix}: ${note.content}${anchorSuffix(note)}`;
}

function paginateNewestFirst<T extends { id: number }>(
  notes: T[],
  limit: number,
  offset: number,
): { page: T[]; total: number; footer: string | null } {
  const total = notes.length;
  const newestFirst = [...notes].reverse();
  const page = newestFirst.slice(offset, offset + limit);
  const remaining = total - offset - page.length;
  const footer =
    remaining > 0
      ? `Showing ${page.length} of ${total} (newest first) — ${remaining} older: ctx_note(action="read", offset=${offset + page.length})`
      : null;
  return { page, total, footer };
}

interface NoteRowLike {
  id: number;
  type: string;
  status: string;
  content: string;
  anchorOrdinal: number | null;
  readyReason: string | null;
  surfaceCondition: string | null;
}

/** Read session + smart notes for the current project (Pi `readNotes` parity). */
function readNotes(args: {
  db: ContextDatabase;
  sessionId: string;
  projectIdentity: string | undefined;
  filter: CtxNoteReadFilter | undefined;
  limit: number;
  offset: number;
}): string[] {
  const { db, sessionId, projectIdentity, filter, limit, offset } = args;

  if (filter === undefined) {
    const sessionNotes = getNotes(db, {
      sessionId,
      type: "session",
      status: "active",
    }) as unknown as NoteRowLike[];
    const readySmartNotes = projectIdentity
      ? (getNotes(db, {
          projectPath: projectIdentity,
          type: "smart",
          status: "ready",
        }) as unknown as NoteRowLike[])
      : [];
    const sections: string[] = [];
    if (sessionNotes.length > 0) {
      const { page, footer } = paginateNewestFirst(sessionNotes, limit, offset);
      sections.push(
        `## Session Notes\n\n${page.map(formatNoteLine).join("\n")}${footer ? `\n\n${footer}` : ""}`,
      );
    }
    if (readySmartNotes.length > 0) {
      sections.push(
        `## 🔔 Ready Smart Notes\n\n${readySmartNotes.map(formatNoteLine).join("\n\n")}`,
      );
    }
    return sections;
  }

  const statusByFilter: Record<CtxNoteReadFilter, NoteStatus | NoteStatus[]> = {
    active: "active",
    all: ["active", "pending", "ready", "dismissed"],
    dismissed: "dismissed",
    pending: "pending",
    ready: "ready",
  };
  const status = statusByFilter[filter];
  const sessionNotes = getNotes(db, { sessionId, type: "session", status }) as unknown as NoteRowLike[];
  const smartNotes = projectIdentity
    ? (getNotes(db, { projectPath: projectIdentity, type: "smart", status }) as unknown as NoteRowLike[])
    : [];
  const sections: string[] = [];
  if (sessionNotes.length > 0) {
    const { page, footer } = paginateNewestFirst(sessionNotes, limit, offset);
    sections.push(
      `## Session Notes\n\n${page.map(formatNoteLine).join("\n")}${footer ? `\n\n${footer}` : ""}`,
    );
  }
  if (smartNotes.length > 0) {
    const { page, footer } = paginateNewestFirst(smartNotes, limit, offset);
    sections.push(`## Smart Notes\n\n${page.map(formatNoteLine).join("\n\n")}${footer ? `\n\n${footer}` : ""}`);
  }
  return sections;
}

export function createCtxNoteTool(ctx: Context, opts: CtxToolsOptions): ToolDefinition {
  return defineTool({
    name: "ctx_note",
    description: CTX_NOTE_DESCRIPTION,
    parameters: {
      action: {
        type: "string",
        enum: ["write", "read", "dismiss", "update"],
        description: "Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
      },
      content: { type: "string", description: "Note text to store when action is 'write'." },
      surface_condition: {
        type: "string",
        description:
          "Externally verifiable condition for smart notes. A background checker verifies it using ONLY outside signals (GitHub state via gh, files on disk, git history, web) — it cannot see this conversation. Use for PR/issue state, release tags, file contents, workflow runs. NOT for 'when the user mentions X' / 'when we revisit Y' — write a regular note instead.",
      },
      note_id: { type: "integer", description: "Note ID (required for 'dismiss' and 'update' actions)." },
      filter: {
        type: "string",
        enum: [...FILTER_VALUES],
        description:
          "Optional read filter. Defaults to active session notes + ready smart notes. Use 'all' to inspect every status or 'pending' to inspect unsurfaced smart notes.",
      },
      limit: { type: "integer", description: "Max notes per section for read, newest first (default: 25)" },
      offset: { type: "integer", description: "Skip this many newest notes for read — page older ones (default: 0)" },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextOutput },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw toolError("'ctx_note' requires an agent execution context.");
      const params = unwrapImitatedReducedArgs(args as Record<string, unknown>, ["action", "content"], {
        action: { type: "enum", values: ["write", "read", "dismiss", "update"] },
        content: "string",
        surface_condition: "string",
        note_id: "number",
        filter: { type: "enum", values: FILTER_VALUES },
        limit: "number",
        offset: "number",
      }) as CtxNoteArgs;

      const runtime = resolveAgentContext(ctx, opts, agent);
      if (!runtime.sessionId) throw toolError("Could not resolve the canonical session id for this agent.");
      const sessionId = runtime.sessionId;
      const db = await resolveDb(ctx, opts);
      const dreamerEnabled = opts.dreamerEnabled;

      const action = params.action ?? (params.content?.trim() ? "write" : "read");

      if (action === "write") {
        const content = params.content?.trim();
        if (!content) throw toolError("'content' is required when action is 'write'.");
        const anchorOrdinal = captureAnchorOrdinal(db, sessionId);
        const surfaceCondition = params.surface_condition?.trim();
        if (surfaceCondition) {
          if (dreamerEnabled !== true) {
            throw toolError(
              "Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.",
            );
          }
          if (!runtime.cwd) throw toolError("Could not resolve the working directory for this agent.");
          if (!runtime.projectIdentity) {
            throw toolError("Could not resolve project identity for smart note.");
          }
          const note = addNote(db, "smart", {
            content,
            sessionId,
            projectPath: runtime.projectIdentity,
            surfaceCondition,
            anchorOrdinal,
          });
          return {
            text: `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${surfaceCondition}`,
          };
        }
        const note = addNote(db, "session", { sessionId, content, anchorOrdinal });
        return { text: `Saved session note #${note.id}.` };
      }

      if (action === "dismiss") {
        if (typeof params.note_id !== "number") {
          throw toolError("'note_id' is required when action is 'dismiss'.");
        }
        if (!runtime.cwd) throw toolError("Could not resolve the working directory for this agent.");
        if (!runtime.projectIdentity) {
          throw toolError("Could not resolve project identity for note dismiss.");
        }
        const dismissed = dismissNote(db, params.note_id, {
          projectPath: runtime.projectIdentity,
          sessionId,
        });
        if (!dismissed) {
          throw toolError(`Note #${params.note_id} not found in your session/project or already dismissed.`);
        }
        return { text: `Note #${params.note_id} dismissed.` };
      }

      if (action === "update") {
        if (typeof params.note_id !== "number") {
          throw toolError("'note_id' is required when action is 'update'.");
        }
        const updates: {
          content?: string;
          surfaceCondition?: string;
        } = {};
        if (params.content?.trim()) updates.content = params.content.trim();
        if (params.surface_condition?.trim()) updates.surfaceCondition = params.surface_condition.trim();
        if (!updates.content && !updates.surfaceCondition) {
          throw toolError("Provide 'content' and/or 'surface_condition' to update.");
        }
        if (!runtime.cwd) throw toolError("Could not resolve the working directory for this agent.");
        if (!runtime.projectIdentity) {
          throw toolError("Could not resolve project identity for note update.");
        }
        const updated = updateNote(db, params.note_id, updates, {
          projectPath: runtime.projectIdentity,
          sessionId,
        });
        if (!updated) throw toolError(`Note #${params.note_id} not found in your session/project.`);
        const parts: string[] = [];
        if (updates.content) parts.push(`content: ${updates.content}`);
        if (updates.surfaceCondition) parts.push(`condition: ${updates.surfaceCondition}`);
        return { text: `Updated note #${params.note_id}\n- ${parts.join("\n- ")}` };
      }

      const limit =
        typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : DEFAULT_READ_LIMIT;
      const offset =
        typeof params.offset === "number" && params.offset > 0 ? Math.floor(params.offset) : 0;
      const sections = readNotes({
        db,
        sessionId,
        projectIdentity: runtime.projectIdentity,
        filter: params.filter,
        limit,
        offset,
      });
      try {
        setNoteLastReadAt(db, sessionId);
      } catch {
        // Watermark is a hint, not correctness.
      }
      if (sections.length === 0) return { text: "## Notes\n\nNo session notes or smart notes." };
      const body = sections.join("\n\n");
      const anchorHint = body.includes("↳ @msg ")
        ? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
        : "";
      return { text: `${body}${anchorHint}${DISMISS_FOOTER}` };
    },
  });
}

/* ─────────────────────────────── ctx_expand ────────────────────────────── */

interface CtxExpandArgs {
  start?: number;
  end?: number;
  verbose?: boolean;
  message?: number;
}

/**
 * Default DSH session → core RawMessage adapter: the transcript mapping
 * (Phase 3 slice) — OpenCode-shaped parts with tool-result folding, walking
 * the WHOLE log so ctx_expand can recover shadowed/compacted content.
 */
function readRawMessagesFromAgent(agent: Agent): RawMessage[] {
  return convertDshEventsToRawMessages(agent.session.events);
}

export function createCtxExpandTool(ctx: Context, opts: CtxToolsOptions): ToolDefinition {
  const readRawMessages = opts.readRawMessages ?? readRawMessagesFromAgent;
  return defineTool({
    name: "ctx_expand",
    description: CTX_EXPAND_DESCRIPTION,
    parameters: {
      start: {
        type: "integer",
        description:
          'First message ordinal to expand — a compartment\'s start="N" attribute, or an ordinal from a ctx_search message hit',
      },
      end: { type: "integer", description: 'Last message ordinal to expand (inclusive) — a compartment\'s end="M" attribute' },
      verbose: {
        type: "boolean",
        description:
          "With start/end: list each message separately with its ordinal [N] and per-part preview, so you can recover one in full by ordinal.",
      },
      message: {
        type: "integer",
        description:
          "Full untruncated recovery of ONE message by its ordinal (every text part + every tool call's complete input/output). Use an ordinal from a compartment, ctx_search hit, or verbose range. Recovers a tool output you dropped with ctx_reduce.",
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextOutput },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw toolError("'ctx_expand' requires an agent execution context.");
      const params = unwrapImitatedReducedArgs(args as Record<string, unknown>, ["message", "start"], {
        start: "number",
        end: "number",
        verbose: "boolean",
        message: "number",
      }) as CtxExpandArgs;

      const runtime = resolveAgentContext(ctx, opts, agent);
      if (!runtime.sessionId) throw toolError("Could not resolve the canonical session id for this agent.");
      const sessionId = runtime.sessionId;
      const db = await resolveDb(ctx, opts);

      // Register the DSH raw-message source for the duration of this one call.
      const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => readRawMessages(agent),
      });
      try {
        if (typeof params.message === "number" && params.message >= 1) {
          return { text: renderMessageByOrdinal(sessionId, params.message) };
        }
        if (
          typeof params.start !== "number" ||
          typeof params.end !== "number" ||
          params.start < 1 ||
          params.end < params.start
        ) {
          throw toolError(
            "provide either message=<ordinal>, or start and end (positive integers, start <= end).",
          );
        }
        const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
        if (lastCompartmentEnd >= 0 && params.start > lastCompartmentEnd) {
          return {
            text: `Range ${params.start}-${params.end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`,
          };
        }
        const effectiveEnd =
          lastCompartmentEnd >= 0 ? Math.min(params.end, lastCompartmentEnd) : params.end;

        if (params.verbose === true) {
          const v = renderVerboseRange(sessionId, params.start, effectiveEnd, CTX_EXPAND_TOKEN_BUDGET);
          if (!v.text) {
            return {
              text: `No messages found in range ${params.start}-${effectiveEnd}. The range may be outside this session's history.`,
            };
          }
          const out = [
            `Messages ${params.start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
            "",
            v.text,
          ];
          if (v.truncated) {
            out.push(
              "",
              `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
            );
          }
          return { text: out.join("\n") };
        }

        const chunk = readSessionChunk(sessionId, CTX_EXPAND_TOKEN_BUDGET, params.start, effectiveEnd + 1);
        if (!chunk.text || chunk.messageCount === 0) {
          return {
            text: `No messages found in range ${params.start}-${params.end}. The range may be outside this session's history.`,
          };
        }
        const lines: string[] = [];
        lines.push(
          `Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
        );
        lines.push("");
        lines.push(chunk.text);
        if (chunk.endIndex < effectiveEnd) {
          lines.push(
            "",
            `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
          );
        }
        return { text: lines.join("\n") };
      } finally {
        unregister();
      }
    },
  });
}

/* ─────────────────────────────── ctx_reduce ────────────────────────────── */

interface CtxReduceArgs {
  drop?: string;
}

function formatIds(ids: number[]): string {
  return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTool(ctx: Context, opts: CtxToolsOptions): ToolDefinition {
  return defineTool({
    name: "ctx_reduce",
    description: CTX_REDUCE_DESCRIPTION,
    parameters: {
      drop: {
        type: "string",
        description: "Tag IDs to drop entirely. Ranges: '3-5', '1,2,9'",
      },
    },
    output: { schema: TEXT_OUTPUT_SCHEMA, render: renderTextOutput },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw toolError("'ctx_reduce' requires an agent execution context.");
      const params = unwrapImitatedReducedArgs(args as Record<string, unknown>, ["drop"], {
        drop: "string",
      }) as CtxReduceArgs;

      const runtime = resolveAgentContext(ctx, opts, agent);
      if (!runtime.sessionId) throw toolError("Could not resolve the canonical session id for this agent.");
      const sessionId = runtime.sessionId;
      const protectedTags = Math.max(0, Math.floor(opts.protectedTags ?? 20));

      if (!params.drop) throw toolError("'drop' must be provided.");

      let dropIds: number[] = [];
      try {
        dropIds = parseRangeString(params.drop);
      } catch (error) {
        throw toolError(`Invalid range syntax. ${getErrorMessage(error)}`);
      }
      const allIds = [...new Set(dropIds)];
      const db = await resolveDb(ctx, opts);

      const allTags = getTagsBySession(db, sessionId);
      const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
      const unknownIds = allIds.filter((id) => !foundSet.has(id));
      if (unknownIds.length > 0) {
        throw toolError(
          `Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`,
        );
      }

      const activeTags = allTags.filter((tag) => tag.status === "active");
      const protectedTagIds = activeTags
        .map((tag) => tag.tagNumber)
        .sort((left, right) => right - left)
        .slice(0, protectedTags);
      const protectedSet = new Set(protectedTagIds);

      const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
      const pendingOps = getPendingOps(db, sessionId);
      const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

      const conflicts: string[] = [];
      for (const id of dropIds) {
        if (tagStatusMap.get(id) === "compacted") {
          conflicts.push(`§${id}§ is from before compaction`);
        }
      }
      if (conflicts.length > 0) {
        throw toolError(`Conflicting operations — ${conflicts.join("; ")}.`);
      }

      const preFilterDropCount = dropIds.length;
      dropIds = dropIds.filter(
        (id) => tagStatusMap.get(id) !== "dropped" && pendingMap.get(id) !== "drop",
      );
      const skippedCount = preFilterDropCount - dropIds.length;

      if (dropIds.length === 0) {
        return {
          text: "All requested tags were already queued or processed. No new action is needed.",
        };
      }

      try {
        db.transaction(() => {
          const now = Date.now();
          for (const id of dropIds) {
            queuePendingOp(db, sessionId, id, "drop", now);
          }
        })();
      } catch (error) {
        throw toolError(`Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`);
      }

      const currentInputTokens =
        getOrCreateSessionMeta(db, sessionId).lastInputTokens;
      updateSessionMeta(db, sessionId, {
        lastNudgeTokens: currentInputTokens,
      });

      const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
      const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
      const skippedNote =
        skippedCount > 0
          ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
          : "";
      const parts: string[] = [];
      if (immediateDropIds.length > 0) parts.push(`drop ${formatIds(immediateDropIds)}`);
      if (deferredDropIds.length > 0) parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
      return { text: `Queued: ${parts.join(", ")}.${skippedNote}` };
    },
  });
}

/* ─────────────────────────────── registration ──────────────────────────── */

/**
 * Register the five ctx_* tools against the DSH tools runtime and return the
 * combined disposer. Omissions follow Pi parity:
 *   - `memoryToolEnabled === false` → no ctx_memory;
 *   - `sessionScopedToolsDisabled` → no ctx_note / ctx_expand / ctx_reduce;
 *   - `compactionOff` → no ctx_reduce.
 */
export function registerCtxTools(ctx: Context, opts: CtxToolsOptions = {}): () => void {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(registerTool(ctx, createCtxSearchTool(ctx, opts)));
    if (opts.memoryToolEnabled !== false) {
      disposers.push(registerTool(ctx, createCtxMemoryTool(ctx, opts)));
    }
    if (!opts.sessionScopedToolsDisabled) {
      disposers.push(registerTool(ctx, createCtxNoteTool(ctx, opts)));
      disposers.push(registerTool(ctx, createCtxExpandTool(ctx, opts)));
    }
    if (!opts.sessionScopedToolsDisabled && !opts.compactionOff) {
      disposers.push(registerTool(ctx, createCtxReduceTool(ctx, opts)));
    }
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Best-effort rollback.
      }
    }
    throw error;
  }
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
