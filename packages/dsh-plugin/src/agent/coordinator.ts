/**
 * agent/coordinator — SurfaceMutationCoordinator (Phase 3, PLAN §3.1/§4).
 *
 * The single surface writer per session. Executes MutationPlans serially with
 * a three-part CAS:
 *
 *   opId         — never applied before (outbox primary key + in-process set);
 *   inputDigest  — the live transcript still matches the plan's input;
 *   generation   — the surface generation still matches the plan's snapshot.
 *
 * Each op becomes ONE official DSH surface transaction:
 * `session.append("user/message", magicUserMessage(replacement), {
 *    surfaceOp: { op: "replace", start: <seq>, end: <seq> },
 *    sourceEventSeqs: [...shadowedSeqs] })` — the official validator is the
 * ultimate fail-closed guard (range validity, shadow coverage, markers).
 *
 * Saga ordering (PLAN §3.2): SQLite pending → DSH append → SQLite
 * applied(ackSeq) → committed. Crash recovery is the outbox's job
 * (reconcileSessionOutbox classifies pending/applied records).
 *
 * Op geometry: op.start/end are SURFACE NODE INDICES (half-open) — the
 * transcript slice's convention (design §3). The coordinator resolves them to
 * event seqs against the LIVE surface at apply time.
 *
 * Temporal insertion ops (empty shadowedSeqs, start === end) have no pure
 * surface insert: the coordinator merges the marker into the node at
 * `start` (prepend), keeping the surface contiguous.
 */
import { randomUUID } from "node:crypto";
import type { Session } from "@deepseek-ai/dsh-session";
import {
  deriveEventMessage,
  magicUserMessage,
} from "../compat/dsh-0.1/session";
import { readDshTranscript, type MutationPlan } from "./transcript";
import {
  getOutboxRecord,
  insertOutboxPending,
  markOutboxAbandoned,
  markOutboxApplied,
  markOutboxCommitted,
} from "./outbox";
import type { Database } from "@magic-context/core/shared/sqlite";

export interface CoordinatorHostView {
  readonly db: Database;
  /** Canonical Magic session key for a DSH session id. */
  canonicalKey(dshSessionId: string): string;
  readonly log?: (message: string) => void;
}

export interface CoordinatorState {
  /** sessionId → serialized execution chain (in-process). */
  readonly queues: Map<string, Promise<unknown>>;
  /** sessionId → applied opIds (in-process cache; the outbox is authoritative). */
  readonly appliedOps: Map<string, Set<string>>;
}

export type ApplyOutcome =
  | { readonly status: "applied"; readonly ackSeq: number }
  | { readonly status: "already-applied" }
  | { readonly status: "stale-input" }
  | { readonly status: "generation-mismatch" }
  | { readonly status: "error"; readonly detail: string };

export function createCoordinatorState(): CoordinatorState {
  return { queues: new Map(), appliedOps: new Map() };
}

/**
 * Re-derive the plan CAS facts from the LIVE session through the SAME
 * transcript path the plan was derived from (digest must match byte-for-byte).
 */
function liveFacts(session: Session, canonicalSessionId: string): { digest: string; generation: number } {
  const view = readDshTranscript({
    session: {
      events: session.events,
      surface: session.surface,
      header: {},
    },
    canonicalSessionId,
  });
  return { digest: view.inputDigest, generation: view.generation };
}

/** Execute one plan's ops against the live surface (no serialization here). */
export function applyPlanOps(
  host: CoordinatorHostView,
  session: Session,
  plan: MutationPlan,
): { ackSeq: number } {
  const db = host.db;
  const nodes = session.surface.nodes;

  // Ops sort by node index; apply from the END so earlier indices stay valid.
  const ops = [...plan.ops].sort((a, b) => b.start - a.start || b.end - a.end);

  let ackSeq = -1;
  for (const op of ops) {
    if (op.shadowedSeqs.length === 0) {
      // Insertion ops are TEMPORAL markers only (no pure surface insert): merge
      // into the node at `start`. Any other kind with empty coverage is a
      // corrupt plan — fail closed below.
      if (op.kind === "temporal") {
        ackSeq = applyInsertionMerge(host, session, plan, op);
        continue;
      }
      throw new Error(
        `magic-context: plan op [${op.start}, ${op.end}) kind=${op.kind} carries no shadowedSeqs (corrupt plan)`,
      );
    }
    const startSeq = nodes[op.start];
    const endSeq = nodes[op.end - 1];
    if (startSeq === undefined || endSeq === undefined) {
      throw new Error(
        `magic-context: plan op range [${op.start}, ${op.end}) outside the live surface (${nodes.length} nodes)`,
      );
    }
    // Fail-closed shadow coverage check: the official validator checks source
    // coverage at FOLD time, not append time — the coordinator must reject a
    // corrupt plan before it lands (defense in depth).
    const expected = nodes.slice(op.start, op.end).sort((a, b) => a - b);
    const actual = [...op.shadowedSeqs].sort((a, b) => a - b);
    if (expected.length !== actual.length || expected.some((seq, i) => seq !== actual[i])) {
      throw new Error(
        `magic-context: plan op [${op.start}, ${op.end}) shadowedSeqs ${JSON.stringify(actual)} does not cover the live surface nodes ${JSON.stringify(expected)}`,
      );
    }
    const message = magicUserMessage(op.replacement, {
      kind: "plugin",
      plugin: "magic-context",
      messageId: `mc-op:${plan.opId}`,
      revision: String(plan.generation),
      digest: plan.inputDigest,
    });
    const event = session.append("user/message", message, {
      surfaceOp: { op: "replace", start: startSeq, end: endSeq },
      sourceEventSeqs: [...op.shadowedSeqs],
    });
    ackSeq = event.seq;
    void db;
  }
  return { ackSeq };
}

/** Merge a temporal marker into the node at `start` (prepend). */
function applyInsertionMerge(
  host: CoordinatorHostView,
  session: Session,
  plan: MutationPlan,
  op: MutationPlan["ops"][number],
): number {
  const nodes = session.surface.nodes;
  const nodeSeq = nodes[op.start];
  if (nodeSeq === undefined) {
    throw new Error(`magic-context: insertion op at ${op.start} outside the live surface`);
  }
  const event = session.events[nodeSeq];
  const existing = deriveEventMessage(event);
  const originalText = existing?.content
    ?.map((block) => (block.type === "text" ? block.text : ""))
    .join("\n") ?? "";
  const merged = `${op.replacement}\n${originalText}`;
  const message = magicUserMessage(merged, {
    kind: "plugin",
    plugin: "magic-context",
    messageId: `mc-op:${plan.opId}:temporal`,
    revision: String(plan.generation),
    digest: plan.inputDigest,
  });
  const appended = session.append("user/message", message, {
    surfaceOp: { op: "replace", start: nodeSeq, end: nodeSeq },
    sourceEventSeqs: [nodeSeq],
  });
  return appended.seq;
}

/**
 * Enqueue one plan for serialized execution on its session. The CAS checks run
 * inside the queue (so concurrent enqueues see each other's effects).
 */
export function enqueuePlan(
  state: CoordinatorState,
  host: CoordinatorHostView,
  session: Session,
  plan: MutationPlan,
): Promise<ApplyOutcome> {
  const sessionId = host.canonicalKey(session.id);
  const previous = state.queues.get(sessionId) ?? Promise.resolve();
  const run = previous.then(() =>
    executePlan(state, host, session, plan, sessionId),
  );
  // Keep the chain alive even when this plan fails.
  state.queues.set(sessionId, run.catch(() => {}));
  return run;
}

async function executePlan(
  state: CoordinatorState,
  host: CoordinatorHostView,
  session: Session,
  plan: MutationPlan,
  sessionId: string,
): Promise<ApplyOutcome> {
  const db = host.db;
  const log = host.log ?? (() => {});

  // CAS 1: opId — never applied before.
  const applied = state.appliedOps.get(sessionId) ?? new Set<string>();
  if (applied.has(plan.opId)) return { status: "already-applied" };
  const existing = getOutboxRecord(db, plan.opId);
  if (existing !== undefined && existing.status !== "abandoned") {
    applied.add(plan.opId);
    state.appliedOps.set(sessionId, applied);
    return { status: "already-applied" };
  }

  // CAS 2+3: the live session still matches the plan's input snapshot.
  const facts = liveFacts(session, sessionId);
  if (facts.generation !== plan.generation) {
    return { status: "generation-mismatch" };
  }
  if (facts.digest !== plan.inputDigest) {
    return { status: "stale-input" };
  }

  // Saga: SQLite pending → DSH append → applied(ackSeq) → committed.
  insertOutboxPending(db, {
    opId: plan.opId,
    sessionId,
    kind: plan.ops[0]?.kind ?? "drops",
    sourceWatermark: plan.sourceWatermark,
    inputDigest: plan.inputDigest,
    generation: plan.generation,
  });
  try {
    const { ackSeq } = applyPlanOps(host, session, plan);
    markOutboxApplied(db, plan.opId, ackSeq);
    markOutboxCommitted(db, plan.opId);
    applied.add(plan.opId);
    state.appliedOps.set(sessionId, applied);
    log(
      `[magic-context] applied plan ${plan.opId} (${plan.ops.length} op(s)) at seq ${ackSeq} for ${sessionId}`,
    );
    return { status: "applied", ackSeq };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    markOutboxAbandoned(db, plan.opId, detail);
    log(`[magic-context] plan ${plan.opId} failed (abandoned): ${detail}`);
    return { status: "error", detail };
  }
}

/** Convenience: a fresh plan id for coordinator-driven materializations. */
export function newOpId(): string {
  return randomUUID();
}
