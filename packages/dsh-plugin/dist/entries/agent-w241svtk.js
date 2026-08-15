import {
  DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
  DEFAULT_PROTECTED_TAGS,
  MAX_EXECUTE_THRESHOLD,
  buildToolArcs,
  buildTrueRawTokenIndex,
  completedToolArcCrossesBoundary,
  computeRawRangeFingerprint,
  countPrimerCandidatesForProject,
  cwdOf,
  escalationBands,
  fenceBoundaryForToolArcs,
  formatWindowDerivationLine,
  getActivePrimers,
  getAllStatusTagTokenTotalsFlat,
  getCachedAbsoluteMessageCount,
  getCompartments,
  getEmbeddingCoverageStatus,
  getLastCompartmentEndMessage,
  getLegacyProtectedTailStartOrdinal,
  getOrCreateSessionMeta,
  getOverflowState,
  getPendingOps,
  getPendingSmartNotes,
  getTagsBySession,
  getUserMemoryCandidates,
  hasMemoryClassifiedAtColumn,
  hasMuralCueColumns,
  loadProtectedTailMeta,
  magicUserMessage,
  markProtectedTailPolicyV3Seeded,
  nextDueAtMs,
  readRawSessionMessages,
  recordProtectedTailNoEligibleHead,
  removePendingOp,
  resolveCanonicalKey,
  resolveDb,
  resolveModelConfigOrDefault,
  resolveProjectIdentity,
  updateTagStatus
} from "./agent-4mykhdm0.js";
import {
  describeError,
  estimateTokens,
  getErrorMessage,
  hasMeaningfulUserText
} from "./agent-hb5apgm1.js";
import {
  log,
  sessionLog
} from "./agent-amr6x35h.js";

// ../plugin/src/features/magic-context/smart-notes/types.ts
var SMART_NOTE_CHECK_POLICY_VERSION = 1;
var SMART_NOTE_CHECK_FLOOR_MS = 5 * 60 * 1000;
var SMART_NOTE_CHECK_CEILING_MS = 24 * 60 * 60 * 1000;
var SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
var SMART_NOTE_CHECK_MAX_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;
var SMART_NOTE_CHECK_LIVENESS_RECHECK_MS = 24 * 60 * 60 * 1000;

class SmartNoteNetworkError extends Error {
  isSmartNoteNetworkError = true;
  terminal;
  constructor(message, options = {}) {
    super(message);
    this.name = "SmartNoteNetworkError";
    this.terminal = options.terminal ?? false;
  }
}

class SmartNoteSecurityError extends Error {
  isSmartNoteSecurityError = true;
  constructor(message) {
    super(message);
    this.name = "SmartNoteSecurityError";
  }
}
function isSmartNoteNetworkError(error) {
  return error instanceof SmartNoteNetworkError || error instanceof Error && (error.name === "SmartNoteNetworkError" || error.message.includes("SmartNoteNetworkError") || error.message.includes("SMART_NOTE_NETWORK"));
}
function isTerminalSmartNoteNetworkError(error) {
  return error instanceof SmartNoteNetworkError && error.terminal;
}
function parseSmartNoteManifest(json) {
  if (!json)
    return { capabilities: [] };
  try {
    const parsed = JSON.parse(json);
    const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((c) => ["readFile", "gitHeadSha", "gitTag", "gitLog", "httpGet"].includes(String(c))) : [];
    return {
      capabilities,
      readFiles: stringArray(parsed.readFiles),
      hosts: stringArray(parsed.hosts),
      urls: stringArray(parsed.urls),
      signals: stringArray(parsed.signals),
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined
    };
  } catch {
    return { capabilities: [] };
  }
}
function stringArray(value) {
  if (!Array.isArray(value))
    return;
  const arr = value.filter((item) => typeof item === "string");
  return arr.length > 0 ? arr : undefined;
}

// ../plugin/src/features/magic-context/smart-notes/storage.ts
function toSmartNote(note) {
  return {
    ...note,
    checkStatus: note.checkStatus ?? "uncompiled",
    checkFailureCount: note.checkFailureCount ?? 0,
    checkNetworkFailureCount: note.checkNetworkFailureCount ?? 0,
    policyVersion: note.policyVersion ?? 0
  };
}
function commitSmartNoteState(db, args) {
  db.exec("BEGIN IMMEDIATE");
  let leaseLost = false;
  let committed = false;
  try {
    if (args.leaseHeld && !args.leaseHeld()) {
      leaseLost = true;
    } else if (claimExpectedState(db, args.expected)) {
      args.write();
      committed = true;
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  if (leaseLost) {
    throw new Error(`Dream lease lost during smart-note ${args.phase} commit`);
  }
  if (!committed) {
    log(`[debug] smart note #${args.expected.noteId}: discarded stale ${args.phase} result`);
  }
  return committed;
}
function claimExpectedState(db, expected) {
  if (expected.kind === "compiled-check") {
    return db.prepare(`UPDATE notes SET id = id
                     WHERE id = ? AND type = 'smart' AND status = 'pending'
                       AND check_status = 'compiled' AND compiled_check = ?
                       AND check_hash IS ? AND check_compiled_at IS ?`).run(expected.noteId, expected.compiledCheck, expected.checkHash, expected.checkCompiledAt).changes > 0;
  }
  const statusClause = expected.checkStatus ? " AND check_status = ?" : "";
  const params = [
    expected.noteId,
    expected.content,
    expected.surfaceCondition,
    expected.updatedAt
  ];
  if (expected.checkStatus)
    params.push(expected.checkStatus);
  return db.prepare(`UPDATE notes SET id = id
                 WHERE id = ? AND type = 'smart' AND status = 'pending'
                   AND content = ? AND surface_condition IS ? AND updated_at = ?${statusClause}`).run(...params).changes > 0;
}
function getDueCompiledSmartNoteChecks(db, projectPath, now, limit, retinaHandoff = false) {
  return getPendingSmartNotes(db, projectPath).filter((note) => !retinaHandoff || note.compileStatus !== "compiled").map(toSmartNote).filter((note) => note.checkStatus === "compiled" && note.compiledCheck !== null && note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION && (note.checkQuarantinedUntil === null || note.checkQuarantinedUntil <= now) && (note.checkNextDueAt === null || note.checkNextDueAt <= now)).sort((a, b) => (a.checkNextDueAt ?? 0) - (b.checkNextDueAt ?? 0) || a.id - b.id).slice(0, Math.max(1, limit));
}
function getSmartNotesNeedingCompilation(db, projectPath, now, limit, retinaHandoff = false) {
  return getPendingSmartNotes(db, projectPath).filter((note) => !retinaHandoff || note.compileStatus !== "compiled").map(toSmartNote).filter((note) => (note.checkNextDueAt === null || note.checkNextDueAt <= now) && (note.checkStatus === "uncompiled" || note.checkStatus === "failing" || note.compiledCheck === null || note.policyVersion !== SMART_NOTE_CHECK_POLICY_VERSION)).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).slice(0, Math.max(1, limit));
}
function getStaleCompiledSmartNotes(db, projectPath, now, limit, retinaHandoff = false) {
  const staleBefore = now - SMART_NOTE_CHECK_MAX_STALENESS_MS;
  const livenessBefore = now - SMART_NOTE_CHECK_LIVENESS_RECHECK_MS;
  return getPendingSmartNotes(db, projectPath).filter((note) => !retinaHandoff || note.compileStatus !== "compiled").map(toSmartNote).filter((note) => note.checkStatus === "compiled" && note.compiledCheck !== null && note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION && note.checkFalseSinceAt !== null && note.checkFalseSinceAt <= staleBefore && (note.checkLastLivenessAt === null || note.checkLastLivenessAt <= livenessBefore)).sort((a, b) => (a.checkFalseSinceAt ?? 0) - (b.checkFalseSinceAt ?? 0) || a.id - b.id).slice(0, Math.max(1, limit));
}
function storeCompiledSmartNoteCheck(db, args) {
  db.prepare(`UPDATE notes
         SET compiled_check = ?,
             manifest_json = ?,
             check_hash = ?,
             check_cron = ?,
             check_version = 1,
             check_status = 'compiled',
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_quarantined_until = NULL,
             check_next_due_at = ?,
             check_compiled_at = ?,
             check_false_since_at = COALESCE(check_false_since_at, ?),
             check_last_liveness_at = NULL,
             policy_version = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`).run(args.compiledCheck, JSON.stringify(args.manifest), args.checkHash, args.checkCron, args.nextDueAt, args.now, args.now, SMART_NOTE_CHECK_POLICY_VERSION, args.now, args.noteId);
}
function markCompiledCheckFalse(db, noteId, nextDueAt, now) {
  db.prepare(`UPDATE notes
         SET last_checked_at = ?,
             updated_at = ?,
             check_next_due_at = ?,
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_false_since_at = COALESCE(check_false_since_at, ?)
         WHERE id = ? AND type = 'smart'`).run(now, now, nextDueAt, now, noteId);
}
function markCompiledCheckLogicFailure(db, noteId, now, maxFailures) {
  const failureCount = readFailureCount(db, noteId, "check_failure_count") + 1;
  const status = failureCount >= maxFailures ? "failing" : "compiled";
  db.prepare(`UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`).run(failureCount, status, now + backoffMs(failureCount), now, noteId);
}
function markCompiledCheckNetworkFailure(db, noteId, now, maxFailures) {
  const failureCount = readFailureCount(db, noteId, "check_network_failure_count") + 1;
  const quarantinedUntil = now + backoffMs(failureCount);
  const status = failureCount >= maxFailures ? "failing" : "compiled";
  db.prepare(`UPDATE notes
         SET check_network_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             check_quarantined_until = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`).run(failureCount, status, quarantinedUntil, quarantinedUntil, now, noteId);
}
function markSmartNoteLivenessChecked(db, noteId, now) {
  db.prepare(`UPDATE notes
         SET check_last_liveness_at = ?, updated_at = ?
         WHERE id = ? AND type = 'smart'`).run(now, now, noteId);
}
function markSmartNoteCheckStatus(db, noteId, status, now) {
  db.prepare(`UPDATE notes SET check_status = ?, updated_at = ? WHERE id = ? AND type = 'smart'`).run(status, now, noteId);
}
function markSmartNoteCompilationFailure(db, noteId, now, maxFailures) {
  const failureCount = readFailureCount(db, noteId, "check_failure_count") + 1;
  const status = failureCount >= maxFailures ? "fallback" : "uncompiled";
  db.prepare(`UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`).run(failureCount, status, now + backoffMs(failureCount), now, noteId);
}
function readFailureCount(db, noteId, column) {
  if (column !== "check_failure_count" && column !== "check_network_failure_count")
    return 0;
  const row = db.prepare(`SELECT ${column} AS count FROM notes WHERE id = ?`).get(noteId);
  return row?.count ?? 0;
}
function backoffMs(failureCount) {
  const minutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, failureCount - 1));
  return minutes * 60 * 1000;
}

// ../plugin/src/features/magic-context/dreamer/storage-task-schedule.ts
function toRow(r) {
  return {
    projectPath: r.project_path,
    task: r.task,
    lastRunAt: r.last_run_at,
    nextDueAt: r.next_due_at,
    schedule: r.schedule ?? null,
    lastStatus: r.last_status ?? null,
    lastError: r.last_error,
    retryCount: r.retry_count ?? 0,
    lastCheckedCommit: r.last_checked_commit ?? null,
    lastBroadRunAt: r.last_broad_run_at ?? null,
    retrospectiveWatermarkMs: r.retrospective_watermark_ms ?? null
  };
}
var SELECT_COLUMNS = "project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count, last_checked_commit, last_broad_run_at, retrospective_watermark_ms";
function getTaskScheduleState(db, projectPath, task) {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM task_schedule_state WHERE project_path = ? AND task = ?`).get(projectPath, task);
  return row ? toRow(row) : null;
}
function pruneNonCanonicalTaskRows(db, projectPath, canonicalTasks) {
  if (canonicalTasks.length === 0)
    return 0;
  const placeholders = canonicalTasks.map(() => "?").join(", ");
  const result = db.prepare(`DELETE FROM task_schedule_state WHERE project_path = ? AND task NOT IN (${placeholders})`).run(projectPath, ...canonicalTasks);
  return Number(result.changes ?? 0);
}
function seedTaskScheduleState(db, projectPath, task, nextDueAt, lastRunAt, schedule) {
  db.prepare("INSERT INTO task_schedule_state (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0) ON CONFLICT(project_path, task) DO NOTHING").run(projectPath, task, lastRunAt, nextDueAt, schedule);
}
function writeTaskScheduleState(db, row) {
  const broadCycleUpdate = row.lastBroadRunAt === undefined ? "last_broad_run_at = task_schedule_state.last_broad_run_at" : "last_broad_run_at = excluded.last_broad_run_at";
  db.prepare(`INSERT INTO task_schedule_state
           (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count, last_checked_commit, last_broad_run_at, retrospective_watermark_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, task) DO UPDATE SET
           last_run_at          = excluded.last_run_at,
           next_due_at          = excluded.next_due_at,
           schedule             = excluded.schedule,
           last_status          = excluded.last_status,
           last_error           = excluded.last_error,
           retry_count          = excluded.retry_count,
           last_checked_commit  = COALESCE(excluded.last_checked_commit, task_schedule_state.last_checked_commit),
           ${broadCycleUpdate},
           retrospective_watermark_ms = COALESCE(excluded.retrospective_watermark_ms, task_schedule_state.retrospective_watermark_ms)`).run(row.projectPath, row.task, row.lastRunAt, row.nextDueAt, row.schedule, row.lastStatus, row.lastError, row.retryCount, row.lastCheckedCommit ?? null, row.lastBroadRunAt ?? null, row.retrospectiveWatermarkMs ?? null);
}
function isRetrospectiveWindowProcessed(db, projectPath, windowKey) {
  const row = db.prepare("SELECT 1 AS one FROM retrospective_processed_windows WHERE project_path = ? AND window_key = ?").get(projectPath, windowKey);
  return row != null;
}
function recordRetrospectiveWindowProcessed(db, projectPath, windowKey) {
  db.prepare("INSERT INTO retrospective_processed_windows (project_path, window_key, processed_at) VALUES (?, ?, ?) ON CONFLICT(project_path, window_key) DO NOTHING").run(projectPath, windowKey, Date.now());
}

// ../plugin/src/features/magic-context/dreamer/task-registry.ts
var CANONICAL_DREAM_TASKS = [
  "map-memories",
  "verify",
  "verify-broad",
  "curate",
  "compress-cues",
  "classify-memories",
  "retrospective",
  "maintain-docs",
  "evaluate-smart-notes",
  "review-user-memories",
  "promote-primers",
  "refresh-primers"
];
function formatDreamTaskBacklogs(backlogs, tasks = CANONICAL_DREAM_TASKS) {
  return tasks.filter((task) => backlogs[task] !== undefined).map((task) => {
    const backlog = backlogs[task];
    return `- ${task}: ${backlog?.pending ?? 0} pending / ${backlog?.total ?? 0} total`;
  }).join(`
`);
}
function processedDreamTaskItems(startPending, endPending) {
  return Math.max(0, startPending - endPending);
}
var MEMORY_DOMAIN_TASKS = [
  "map-memories",
  "verify",
  "verify-broad",
  "curate",
  "compress-cues",
  "classify-memories",
  "retrospective",
  "promote-primers",
  "refresh-primers"
];
var MEMORY_DOMAIN_SET = new Set(MEMORY_DOMAIN_TASKS);
function leaseKindFor(task) {
  if (MEMORY_DOMAIN_SET.has(task))
    return "memory";
  switch (task) {
    case "review-user-memories":
      return "user-memories";
    case "promote-primers":
    case "refresh-primers":
      return "memory";
    case "maintain-docs":
      return "maintain-docs";
    case "evaluate-smart-notes":
      return "evaluate-smart-notes";
    default:
      return "memory";
  }
}
function leaseKeyFor(task, projectIdentity) {
  const kind = leaseKindFor(task);
  return kind === "user-memories" ? "user-memories" : `${kind}:${projectIdentity}`;
}
function isCanonicalDreamTask(value) {
  return CANONICAL_DREAM_TASKS.includes(value);
}
function compareTaskOrder(a, b) {
  return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b);
}

// ../plugin/src/features/magic-context/dreamer/task-gates.ts
function countActiveMemories(db, projectPath) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM memories WHERE project_path = ? AND status IN ('active','permanent')").get(projectPath);
  return row?.cnt ?? 0;
}
function countUnmappedActiveMemories(db, projectPath) {
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND NOT EXISTS (
                    SELECT 1 FROM memory_verifications v WHERE v.memory_id = m.id
                )`).get(projectPath);
  return row?.cnt ?? 0;
}
function countCompartmentsSince(db, projectPath, since) {
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ? AND c.created_at > ?`).get(projectPath, since);
  return row?.cnt ?? 0;
}
function countProjectSessionsSince(db, projectPath, since) {
  const row = since === null ? db.prepare("SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?").get(projectPath) : db.prepare("SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ? AND updated_at > ?").get(projectPath, since);
  return row?.cnt ?? 0;
}
function countMappedMemories(db, projectPath) {
  const row = db.prepare(`SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND v.file_path <> ''`).get(projectPath);
  return row?.cnt ?? 0;
}
function countUnverifiedMappedMemories(db, projectPath) {
  const row = db.prepare(`SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND v.file_path <> ''
                AND v.verified_at = 0`).get(projectPath);
  return row?.cnt ?? 0;
}
function countBroadCycleCandidates(db, projectPath, cycleStartAt) {
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (
                    SELECT MAX(v.verified_at)
                      FROM memory_verifications v
                     WHERE v.memory_id = m.id
                       AND v.file_path <> ''
                ) < ?`).get(projectPath, cycleStartAt);
  return row?.cnt ?? 0;
}
function countCueCandidates(db, projectPath) {
  if (!hasMuralCueColumns(db))
    return countActiveMemories(db, projectPath);
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM memories
              WHERE project_path = ?
                AND status IN ('active','permanent')
                AND (mural_cue IS NULL OR mural_cue_hash IS NULL OR updated_at > mural_cue_at)`).get(projectPath);
  return row?.cnt ?? 0;
}
function countStalePrimers(db, projectPath) {
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM primers
              WHERE project_path = ?
                AND status = 'active'
                AND (answer IS NULL OR TRIM(answer) = '' OR answer_refreshed_at IS NULL
                     OR last_observed_at > answer_refreshed_at)`).get(projectPath);
  return row?.cnt ?? 0;
}
function countUnclassifiedActiveMemories(db, projectPath) {
  if (!hasMemoryClassifiedAtColumn(db))
    return countActiveMemories(db, projectPath);
  const row = db.prepare(`SELECT COUNT(*) AS cnt
               FROM memories
              WHERE project_path = ?
                AND status IN ('active','permanent')
                AND classified_at IS NULL`).get(projectPath);
  return row?.cnt ?? 0;
}
function countPendingSmartNotes(db, projectPath) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'pending'").get(projectPath);
  return row?.cnt ?? 0;
}
function countUserMemoryCandidates(db) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM user_memory_candidates").get();
  return row?.cnt ?? 0;
}
function countActivePrimers(db, projectPath) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM primers WHERE project_path = ? AND status = 'active'").get(projectPath);
  return row?.cnt ?? 0;
}
function getDreamTaskBacklog(db, projectPath, task, options = {}) {
  switch (task) {
    case "map-memories": {
      const total = countActiveMemories(db, projectPath);
      return { pending: countUnmappedActiveMemories(db, projectPath), total };
    }
    case "verify": {
      return {
        pending: countUnverifiedMappedMemories(db, projectPath),
        total: countMappedMemories(db, projectPath)
      };
    }
    case "verify-broad": {
      const total = countMappedMemories(db, projectPath);
      const cycleStartAt = getTaskScheduleState(db, projectPath, "verify-broad")?.lastBroadRunAt;
      const pending = cycleStartAt == null ? total : countBroadCycleCandidates(db, projectPath, cycleStartAt);
      return { pending, total };
    }
    case "curate": {
      const total = countActiveMemories(db, projectPath);
      return { pending: total, total };
    }
    case "compress-cues": {
      const total = countActiveMemories(db, projectPath);
      return { pending: countCueCandidates(db, projectPath), total };
    }
    case "classify-memories": {
      const total = countActiveMemories(db, projectPath);
      return { pending: countUnclassifiedActiveMemories(db, projectPath), total };
    }
    case "retrospective": {
      const pending = countProjectSessionsSince(db, projectPath, options.retrospectiveWatermarkMs ?? null);
      return { pending, total: pending };
    }
    case "maintain-docs": {
      const total = countCompartmentsSince(db, projectPath, 0);
      const pending = countCompartmentsSince(db, projectPath, options.lastRunAt ?? 0);
      return { pending, total };
    }
    case "evaluate-smart-notes": {
      const pending = countPendingSmartNotes(db, projectPath);
      return { pending, total: pending };
    }
    case "review-user-memories": {
      const pending = countUserMemoryCandidates(db);
      return { pending, total: pending };
    }
    case "promote-primers": {
      const pending = countPrimerCandidatesForProject(db, projectPath);
      return { pending, total: pending };
    }
    case "refresh-primers": {
      const total = countActivePrimers(db, projectPath);
      return { pending: countStalePrimers(db, projectPath), total };
    }
    default: {
      const _exhaustive = task;
      return _exhaustive;
    }
  }
}
function getDreamTaskBacklogs(db, projectPath, tasks = CANONICAL_DREAM_TASKS, options = {}) {
  const result = {};
  for (const task of tasks)
    result[task] = getDreamTaskBacklog(db, projectPath, task, options);
  return result;
}
function evaluateTaskGate(task, ctx) {
  const { db, projectIdentity: project, lastRunAt } = ctx;
  switch (task) {
    case "map-memories":
      return countUnmappedActiveMemories(db, project) > 0;
    case "verify":
      return countActiveMemories(db, project) > 0;
    case "verify-broad":
      return getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt != null || countActiveMemories(db, project) > 0;
    case "curate":
      return countActiveMemories(db, project) > 0;
    case "compress-cues":
      return countActiveMemories(db, project) > 0;
    case "classify-memories":
      return countActiveMemories(db, project) > 0;
    case "retrospective":
      return countProjectSessionsSince(db, project, ctx.retrospectiveWatermarkMs ?? null) > 0;
    case "maintain-docs":
      return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;
    case "evaluate-smart-notes":
      return getSmartNotesNeedingCompilation(db, project, Date.now(), 1).length > 0 || getStaleCompiledSmartNotes(db, project, Date.now(), 1).length > 0 || getPendingSmartNotes(db, project).some((note) => note.checkStatus === "fallback");
    case "review-user-memories":
      return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;
    case "promote-primers":
      return countPrimerCandidatesForProject(db, project) >= (ctx.promotionThreshold ?? 2);
    case "refresh-primers":
      return getActivePrimers(db, project).some((primer) => !primer.answer.trim() || primer.answerRefreshedAt == null || (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt);
    default: {
      const _exhaustive = task;
      return Boolean(_exhaustive);
    }
  }
}

// ../plugin/src/features/magic-context/dreamer/storage-dream-state.ts
var getDreamStateStatements = new WeakMap;
var setDreamStateStatements = new WeakMap;
var deleteDreamStateStatements = new WeakMap;
function getGetDreamStateStatement(db) {
  let stmt = getDreamStateStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT value FROM dream_state WHERE key = ?");
    getDreamStateStatements.set(db, stmt);
  }
  return stmt;
}
function getSetDreamStateStatement(db) {
  let stmt = setDreamStateStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("INSERT INTO dream_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    setDreamStateStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteDreamStateStatement(db) {
  let stmt = deleteDreamStateStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM dream_state WHERE key = ?");
    deleteDreamStateStatements.set(db, stmt);
  }
  return stmt;
}
function getDreamState(db, key) {
  const row = getGetDreamStateStatement(db).get(key);
  return typeof row?.value === "string" ? row.value : null;
}
function setDreamState(db, key, value) {
  getSetDreamStateStatement(db).run(key, value);
}
function deleteDreamState(db, key) {
  getDeleteDreamStateStatement(db).run(key);
}

// ../plugin/src/features/magic-context/dreamer/lease.ts
var LEASE_DURATION_MS = 2 * 60 * 1000;
var DREAMING_LEASE_KEY = "dreaming";
function rowKeys(leaseKey) {
  if (leaseKey === DREAMING_LEASE_KEY) {
    return {
      holder: "dreaming_lease_holder",
      heartbeat: "dreaming_lease_heartbeat",
      expiry: "dreaming_lease_expiry",
      generation: "dreaming_lease_generation"
    };
  }
  return {
    holder: `lease:${leaseKey}:holder`,
    heartbeat: `lease:${leaseKey}:heartbeat`,
    expiry: `lease:${leaseKey}:expiry`,
    generation: `lease:${leaseKey}:generation`
  };
}
function getLeaseExpiry(db, keys) {
  const value = getDreamState(db, keys.expiry);
  if (!value) {
    return null;
  }
  const expiry = Number(value);
  return Number.isFinite(expiry) ? expiry : null;
}
function isLeaseActive(db, leaseKey = DREAMING_LEASE_KEY) {
  const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
  return expiry !== null && expiry > Date.now();
}
function getLeaseHolder(db, leaseKey = DREAMING_LEASE_KEY) {
  return getDreamState(db, rowKeys(leaseKey).holder);
}
function getLeaseGeneration(db, leaseKey = DREAMING_LEASE_KEY) {
  const value = getDreamState(db, rowKeys(leaseKey).generation);
  if (!value)
    return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}
function peekLeaseHolderAndExpiry(db, expectedHolder, leaseKey = DREAMING_LEASE_KEY) {
  const keys = rowKeys(leaseKey);
  const holder = getDreamState(db, keys.holder);
  if (holder !== expectedHolder)
    return false;
  const expiryStr = getDreamState(db, keys.expiry);
  if (!expiryStr)
    return false;
  const expiry = Number(expiryStr);
  return Number.isFinite(expiry) && expiry >= Date.now();
}
function leaseOwnershipMatches(db, expectedHolder, expectedGeneration, leaseKey = DREAMING_LEASE_KEY) {
  return getLeaseGeneration(db, leaseKey) === expectedGeneration && peekLeaseHolderAndExpiry(db, expectedHolder, leaseKey);
}
function runImmediate(db, body) {
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = body();
    db.exec("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
  }
}
function acquireLeaseWithAcquisition(db, holderId, leaseKey = DREAMING_LEASE_KEY) {
  const keys = rowKeys(leaseKey);
  return runImmediate(db, () => {
    const existingHolder = getLeaseHolder(db, leaseKey);
    if (isLeaseActive(db, leaseKey) && existingHolder && existingHolder !== holderId) {
      return null;
    }
    const now = Date.now();
    const priorGeneration = getLeaseGeneration(db, leaseKey) ?? 0;
    const generation = existingHolder === holderId ? Math.max(1, priorGeneration) : priorGeneration + 1;
    setDreamState(db, keys.holder, holderId);
    setDreamState(db, keys.heartbeat, String(now));
    setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
    setDreamState(db, keys.generation, String(generation));
    return { acquiredAt: now, generation };
  });
}
function renewLease(db, holderId, leaseKey = DREAMING_LEASE_KEY, expectedGeneration) {
  const keys = rowKeys(leaseKey);
  return runImmediate(db, () => {
    if (getLeaseHolder(db, leaseKey) !== holderId || !isLeaseActive(db, leaseKey) || expectedGeneration !== undefined && getLeaseGeneration(db, leaseKey) !== expectedGeneration) {
      return false;
    }
    const now = Date.now();
    setDreamState(db, keys.heartbeat, String(now));
    setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
    return true;
  });
}
function runLeaseGuardedWrite(db, holderId, leaseKey, fn) {
  return runImmediate(db, () => {
    if (!peekLeaseHolderAndExpiry(db, holderId, leaseKey)) {
      throw new Error("Dream lease lost before guarded write");
    }
    return fn();
  });
}
var LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
function startLeaseHeartbeat(db, holderId, leaseKey, onLost, intervalOrAcquisition = LEASE_HEARTBEAT_INTERVAL_MS) {
  const intervalMs = typeof intervalOrAcquisition === "number" ? intervalOrAcquisition : LEASE_HEARTBEAT_INTERVAL_MS;
  const acquisition = typeof intervalOrAcquisition === "number" ? undefined : intervalOrAcquisition;
  let lost = false;
  let expectedGeneration = acquisition?.generation ?? getLeaseGeneration(db, leaseKey);
  let lastConfirmedAt = acquisition?.acquiredAt ?? Date.now();
  const declareLost = (reason) => {
    if (lost)
      return;
    lost = true;
    onLost(reason);
  };
  const beat = () => {
    if (lost)
      return;
    try {
      if (renewLease(db, holderId, leaseKey, expectedGeneration === null ? undefined : expectedGeneration)) {
        lastConfirmedAt = Date.now();
        return;
      }
      if (expectedGeneration !== null && getLeaseGeneration(db, leaseKey) !== expectedGeneration) {
        declareLost("lease generation changed — another holder acquired it");
        return;
      }
      if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
        declareLost("lease lapsed past TTL — another holder may have run");
        return;
      }
      const reacquired = acquireLeaseWithAcquisition(db, holderId, leaseKey);
      if (reacquired) {
        if (expectedGeneration !== null && reacquired.generation !== expectedGeneration) {
          declareLost("lease generation changed during reacquisition");
          return;
        }
        expectedGeneration = reacquired.generation;
        lastConfirmedAt = Date.now();
        return;
      }
      declareLost("lease acquired by another holder");
    } catch {
      if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
        declareLost("lease renewal unconfirmed past TTL");
      }
    }
  };
  beat();
  const timer = lost ? undefined : setInterval(beat, intervalMs);
  return {
    stop: () => {
      if (timer)
        clearInterval(timer);
    },
    get lost() {
      return lost;
    }
  };
}
function releaseLease(db, holderId, leaseKey = DREAMING_LEASE_KEY) {
  const keys = rowKeys(leaseKey);
  runImmediate(db, () => {
    if (getLeaseHolder(db, leaseKey) !== holderId) {
      return;
    }
    deleteDreamState(db, keys.holder);
    deleteDreamState(db, keys.heartbeat);
    deleteDreamState(db, keys.expiry);
  });
}

// ../plugin/src/features/magic-context/dreamer/task-scheduler.ts
var MAX_TASK_RETRIES = 3;
function ensureSeeded(db, projectIdentity, config, now) {
  if (getTaskScheduleState(db, projectIdentity, config.task))
    return;
  const legacy = getDreamState(db, `last_dream_at:${projectIdentity}`);
  const legacyLastRun = legacy ? Number(legacy) : null;
  const lastRunAt = legacyLastRun && Number.isFinite(legacyLastRun) ? legacyLastRun : null;
  const nextDueAt = nextDueAtMs(config.schedule, now);
  seedTaskScheduleState(db, projectIdentity, config.task, nextDueAt, lastRunAt, config.schedule);
}
function reconcileSchedule(db, projectIdentity, config, now) {
  ensureSeeded(db, projectIdentity, config, now);
  const stored = getTaskScheduleState(db, projectIdentity, config.task);
  if (!stored || stored.schedule === config.schedule)
    return;
  if (config.schedule.trim() === "") {
    writeTaskScheduleState(db, { ...stored, schedule: config.schedule, nextDueAt: null });
    return;
  }
  if (stored.schedule === null && stored.nextDueAt !== null) {
    writeTaskScheduleState(db, { ...stored, schedule: config.schedule });
    return;
  }
  writeTaskScheduleState(db, {
    ...stored,
    schedule: config.schedule,
    nextDueAt: nextDueAtMs(config.schedule, now),
    retryCount: 0
  });
}
function planDueTasks(db, projectIdentity, tasks, now) {
  const pruned = pruneNonCanonicalTaskRows(db, projectIdentity, tasks.map((t) => t.task));
  if (pruned > 0) {
    log(`[dreamer] pruned ${pruned} retired task row(s) for ${projectIdentity}`);
  }
  const due = [];
  for (const config of tasks) {
    reconcileSchedule(db, projectIdentity, config, now);
    const state = getTaskScheduleState(db, projectIdentity, config.task);
    if (!state || state.nextDueAt === null)
      continue;
    if (now >= state.nextDueAt) {
      due.push({ config, scheduledAt: state.nextDueAt });
    }
  }
  return due;
}
function advanceAfterRun(db, projectIdentity, due, finishedAt, status, error, schedulePatch) {
  writeTaskScheduleState(db, {
    projectPath: projectIdentity,
    task: due.config.task,
    lastRunAt: status === "completed" ? finishedAt : readLastRunAt(db, projectIdentity, due.config.task),
    nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
    schedule: due.config.schedule,
    lastStatus: status,
    lastError: error,
    retryCount: 0,
    retrospectiveWatermarkMs: schedulePatch?.retrospectiveWatermarkMs
  });
}
function readLastRunAt(db, projectIdentity, task) {
  return getTaskScheduleState(db, projectIdentity, task)?.lastRunAt ?? null;
}
function readRetrospectiveWatermark(db, projectIdentity, task) {
  return getTaskScheduleState(db, projectIdentity, task)?.retrospectiveWatermarkMs ?? null;
}
function recordTransientFailure(db, projectIdentity, due, finishedAt, error) {
  const prior = getTaskScheduleState(db, projectIdentity, due.config.task);
  const retryCount = (prior?.retryCount ?? 0) + 1;
  const priorLastRun = prior?.lastRunAt ?? null;
  if (retryCount > MAX_TASK_RETRIES) {
    writeTaskScheduleState(db, {
      projectPath: projectIdentity,
      task: due.config.task,
      lastRunAt: priorLastRun,
      nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
      schedule: due.config.schedule,
      lastStatus: "failed",
      lastError: error,
      retryCount: 0
    });
  } else {
    const disabled = due.config.schedule.trim() === "";
    writeTaskScheduleState(db, {
      projectPath: projectIdentity,
      task: due.config.task,
      lastRunAt: priorLastRun,
      nextDueAt: disabled ? null : prior?.nextDueAt ?? due.scheduledAt,
      schedule: due.config.schedule,
      lastStatus: "failed",
      lastError: error,
      retryCount
    });
  }
}
var LEASE_WAIT_POLL_MS = 2000;
var MANUAL_RUN_LEASE_WAIT_MS = 60000;
async function runDomainGroup(deps, group, cb) {
  const { db, projectIdentity, executor } = deps;
  const leaseKey = leaseKeyFor(group[0].config.task, projectIdentity);
  const holderId = crypto.randomUUID();
  let acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
  if (!acquisition && cb?.leaseWaitMs) {
    const deadline = Date.now() + cb.leaseWaitMs;
    while (!acquisition && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_POLL_MS));
      acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
    }
  }
  if (!acquisition) {
    log(`[dreamer] domain lease busy (${leaseKey}) — deferring ${group.length} task(s)`);
    for (const due of group)
      cb?.onBusy?.(due.config.task);
    return;
  }
  try {
    for (const due of [...group].sort((a, b) => compareTaskOrder(a.config.task, b.config.task))) {
      if (!leaseOwnershipMatches(db, holderId, acquisition.generation, leaseKey)) {
        log(`[dreamer] domain lease lost (${leaseKey}) — stopping remaining task(s)`);
        break;
      }
      if (!cb?.forceGate) {
        const gatePass = evaluateTaskGate(due.config.task, {
          db,
          projectIdentity,
          lastRunAt: readLastRunAt(db, projectIdentity, due.config.task),
          retrospectiveWatermarkMs: readRetrospectiveWatermark(db, projectIdentity, due.config.task),
          promotionThreshold: due.config.promotionThreshold ?? 3
        });
        if (!gatePass) {
          advanceAfterRun(db, projectIdentity, due, Date.now(), "skipped", null);
          continue;
        }
      }
      let outcome;
      try {
        outcome = await executor(due.config, {
          db,
          projectIdentity,
          holderId,
          leaseKey,
          leaseAcquisition: acquisition
        });
      } catch (error) {
        outcome = { status: "failed", transient: true, error: String(error) };
      }
      const finishedAt = Date.now();
      if (outcome.status === "completed") {
        advanceAfterRun(db, projectIdentity, due, finishedAt, "completed", null, outcome.schedulePatch);
        cb?.onRan?.(due.config.task);
      } else if (outcome.transient) {
        recordTransientFailure(db, projectIdentity, due, finishedAt, outcome.error ?? null);
        cb?.onFailed?.(due.config.task, outcome.error);
      } else {
        advanceAfterRun(db, projectIdentity, due, finishedAt, "failed", outcome.error ?? null);
        cb?.onFailed?.(due.config.task, outcome.error);
      }
    }
  } finally {
    releaseLease(db, holderId, leaseKey);
  }
}
async function runManualDream(deps) {
  const now = Date.now();
  const result = {
    ran: [],
    skippedNoWork: [],
    deferredBusy: [],
    failed: [],
    failureDetails: [],
    backlogBefore: {},
    backlogAfter: {}
  };
  let selected;
  let forceGate = false;
  if (deps.task) {
    const cfg = deps.tasks.find((t) => t.task === deps.task);
    if (!cfg)
      return result;
    selected = [cfg];
    forceGate = true;
  } else {
    selected = deps.tasks.filter((t) => t.schedule.trim() !== "");
  }
  if (selected.length === 0)
    return result;
  const selectedTaskNames = selected.map((config) => config.task);
  result.backlogBefore = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
  result.backlogAfter = { ...result.backlogBefore };
  for (const cfg of selected)
    ensureSeeded(deps.db, deps.projectIdentity, cfg, now);
  const dueAll = selected.map((config) => ({ config, scheduledAt: now }));
  const gated = [];
  for (const d of dueAll) {
    if (forceGate) {
      gated.push(d);
      continue;
    }
    const pass = evaluateTaskGate(d.config.task, {
      db: deps.db,
      projectIdentity: deps.projectIdentity,
      lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
      retrospectiveWatermarkMs: readRetrospectiveWatermark(deps.db, deps.projectIdentity, d.config.task),
      promotionThreshold: d.config.promotionThreshold ?? 3
    });
    if (pass)
      gated.push(d);
    else
      result.skippedNoWork.push(d.config.task);
  }
  if (gated.length === 0) {
    result.backlogAfter = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
    return result;
  }
  const groups = new Map;
  for (const d of gated) {
    const kind = leaseKindFor(d.config.task);
    const arr = groups.get(kind) ?? [];
    arr.push(d);
    groups.set(kind, arr);
  }
  await Promise.all([...groups.values()].map((group) => runDomainGroup({ ...deps, executor: deps.executor }, group, {
    forceGate,
    leaseWaitMs: MANUAL_RUN_LEASE_WAIT_MS,
    onRan: (t) => result.ran.push(t),
    onFailed: (task, error) => {
      result.failed.push(task);
      if (error)
        result.failureDetails?.push(`${task}: ${error}`);
    },
    onBusy: (t) => result.deferredBusy.push(t)
  })));
  result.backlogAfter = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
  return result;
}
async function runDueTasksForProject(deps) {
  const now = deps.now ?? Date.now();
  const due = planDueTasks(deps.db, deps.projectIdentity, deps.tasks, now);
  if (due.length === 0)
    return 0;
  const gated = [];
  for (const d of due) {
    const pass = evaluateTaskGate(d.config.task, {
      db: deps.db,
      projectIdentity: deps.projectIdentity,
      lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
      retrospectiveWatermarkMs: readRetrospectiveWatermark(deps.db, deps.projectIdentity, d.config.task),
      promotionThreshold: d.config.promotionThreshold ?? 3
    });
    if (pass) {
      gated.push(d);
    } else {
      advanceAfterRun(deps.db, deps.projectIdentity, d, now, "skipped", null);
    }
  }
  if (gated.length === 0)
    return 0;
  const groups = new Map;
  for (const d of gated) {
    const kind = leaseKindFor(d.config.task);
    const arr = groups.get(kind) ?? [];
    arr.push(d);
    groups.set(kind, arr);
  }
  await Promise.all([...groups.values()].map((group) => runDomainGroup(deps, group)));
  return gated.length;
}

// ../plugin/src/hooks/magic-context/execute-flush.ts
function executeFlush(db, sessionId) {
  try {
    const pendingOps = getPendingOps(db, sessionId);
    if (pendingOps.length === 0) {
      return "No pending operations to flush.";
    }
    let dropped = 0;
    db.transaction(() => {
      for (const op of pendingOps) {
        updateTagStatus(db, sessionId, op.tagId, "dropped");
        removePendingOp(db, sessionId, op.tagId);
        dropped++;
      }
    })();
    const parts = [];
    if (dropped > 0)
      parts.push(`${dropped} dropped`);
    return `Flushed: ${parts.join(", ")}. Changes take effect on next message.`;
  } catch (error) {
    sessionLog(sessionId, "ctx-flush failed:", error);
    return `Error: Failed to flush context operations. ${getErrorMessage(error)}`;
  }
}

// ../plugin/src/hooks/magic-context/event-resolvers.ts
function resolveCacheTtl(cacheTtl, modelKey) {
  if (typeof cacheTtl === "string") {
    return cacheTtl;
  }
  return resolveModelConfigOrDefault(cacheTtl, modelKey, cacheTtl.default ?? "5m");
}
var clampWarnSeen = new Set;
function isFinitePositive(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
function* modelKeyLookupOrder(modelKey) {
  const slash = modelKey.indexOf("/");
  const provider = slash >= 0 ? modelKey.slice(0, slash) : "";
  let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
  while (modelId.length > 0) {
    if (provider)
      yield `${provider}/${modelId}`;
    yield modelId;
    const lastDash = modelId.lastIndexOf("-");
    if (lastDash <= 0)
      break;
    modelId = modelId.slice(0, lastDash);
  }
}
function resolveExecuteThresholdDetail(config, modelKey, fallback, options) {
  if (options?.tokensConfig && isFinitePositive(options.contextLimit)) {
    const contextLimit = options.contextLimit;
    const tokenMatch = resolveTokensMatchWithKey(options.tokensConfig, modelKey);
    if (tokenMatch && isFinitePositive(tokenMatch.value)) {
      const cap = contextLimit * (MAX_EXECUTE_THRESHOLD / 100);
      const effectiveTokens = Math.min(tokenMatch.value, cap);
      if (effectiveTokens < tokenMatch.value) {
        const dedupeKey = `${options.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${tokenMatch.value}|${cap}`;
        if (!clampWarnSeen.has(dedupeKey)) {
          clampWarnSeen.add(dedupeKey);
          const msg = `execute_threshold_tokens clamped: ${tokenMatch.value} → ${effectiveTokens} (${MAX_EXECUTE_THRESHOLD}% of ${contextLimit}) for ${modelKey ?? "default"}`;
          if (options.sessionId) {
            sessionLog(options.sessionId, `WARN: ${msg}`);
          } else {
            log(`[magic-context] WARN: ${msg}`);
          }
        }
      }
      const percentage = effectiveTokens / contextLimit * 100;
      const detail2 = {
        percentage: Math.min(percentage, MAX_EXECUTE_THRESHOLD),
        mode: "tokens",
        absoluteTokens: Math.floor(effectiveTokens),
        matchedKey: tokenMatch.matchedKey
      };
      if (effectiveTokens < tokenMatch.value) {
        detail2.clamped = true;
        detail2.configuredValue = tokenMatch.value;
      }
      return detail2;
    }
  }
  let resolved;
  let matchedKey;
  if (typeof config === "number") {
    resolved = config;
  } else if (modelKey) {
    let matched;
    for (const candidate of modelKeyLookupOrder(modelKey)) {
      if (typeof config[candidate] === "number") {
        matched = config[candidate];
        matchedKey = candidate;
        break;
      }
    }
    if (matched === undefined && typeof config.default === "number") {
      resolved = config.default;
      matchedKey = "default";
    } else {
      resolved = matched ?? fallback;
    }
  } else if (typeof config.default === "number") {
    resolved = config.default;
    matchedKey = "default";
  } else {
    resolved = fallback;
  }
  if (!Number.isFinite(resolved) || resolved < 0) {
    resolved = fallback;
  }
  const cappedPercentage = Math.min(resolved, MAX_EXECUTE_THRESHOLD);
  const percentageClamped = cappedPercentage < resolved;
  if (percentageClamped) {
    const dedupeKey = `pct|${options?.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${resolved}`;
    if (!clampWarnSeen.has(dedupeKey)) {
      clampWarnSeen.add(dedupeKey);
      const msg = `execute_threshold clamped ${resolved}% → ${MAX_EXECUTE_THRESHOLD}% for ${modelKey ?? "default"} (capped against the output-reserved safe window; 10% remains for mid-turn growth before the absolute 95% wall)`;
      if (options?.sessionId) {
        sessionLog(options.sessionId, `WARN: ${msg}`);
      } else {
        log(`[magic-context] WARN: ${msg}`);
      }
    }
  }
  const detail = {
    percentage: cappedPercentage,
    mode: "percentage",
    matchedKey
  };
  if (percentageClamped) {
    detail.clamped = true;
    detail.configuredValue = resolved;
  }
  return detail;
}
function resolveTokensMatchWithKey(tokensConfig, modelKey) {
  if (!tokensConfig) {
    return;
  }
  if (modelKey) {
    for (const candidate of modelKeyLookupOrder(modelKey)) {
      const value = tokensConfig[candidate];
      if (typeof value === "number") {
        return { value, matchedKey: candidate };
      }
    }
  }
  if (typeof tokensConfig.default === "number") {
    return { value: tokensConfig.default, matchedKey: "default" };
  }
  return;
}

// ../plugin/src/features/magic-context/scheduler.ts
var TTL_PATTERN = /^(\d+)([smh])$/;
var NUMERIC_PATTERN = /^\d+$/;
var UNIT_TO_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000
};
function parseCacheTtl(ttl) {
  const normalizedTtl = ttl.trim();
  if (normalizedTtl.toLowerCase() === "never") {
    return Number.POSITIVE_INFINITY;
  }
  if (NUMERIC_PATTERN.test(normalizedTtl)) {
    return Number(normalizedTtl);
  }
  const match = normalizedTtl.match(TTL_PATTERN);
  if (!match) {
    throw new Error(`Invalid cache TTL format: ${ttl}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  return value * UNIT_TO_MS[unit];
}

// ../plugin/src/shared/format-threshold.ts
function formatThresholdClampNote(opts) {
  if (!opts.clamped || opts.configuredValue === undefined)
    return "";
  if (opts.mode === "tokens" && opts.contextLimit > 0) {
    return ` [clamped: ${opts.configuredValue.toLocaleString()} > ${opts.maxPercentage}% of ${opts.contextLimit.toLocaleString()}]`;
  }
  return ` [clamped: ${opts.configuredValue}% > ${opts.maxPercentage}%]`;
}

// ../plugin/src/hooks/magic-context/derive-budgets.ts
var TRIGGER_BUDGET_PERCENTAGE = 0.05;
var TRIGGER_BUDGET_MIN = 5000;
var TRIGGER_BUDGET_MAX = 50000;
function deriveTriggerBudget(mainContextLimit, executeThresholdPercentage) {
  if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
    return TRIGGER_BUDGET_MIN;
  }
  const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
  const usable = mainContextLimit * thresholdFraction;
  const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
  return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

// ../plugin/src/hooks/magic-context/protected-tail-boundary.ts
var ALPHA = 0.3;
var FLOOR_RATIO = 0.08;
var FLOOR_MIN = 2000;
var FLOOR_MAX = 12000;
var ABS_CAP = 96000;
var MAX_USABLE_RATIO = 0.4;
var RESERVED_HEADROOM_MIN = 1000;
var RESERVED_HEADROOM_RATIO = 0.02;
var NON_EMERGENCY_MAX_CAP = 250000;
var FORCE80_MAX_CAP = 500000;
var FORCE95_MAX_CAP = 750000;
var NORMAL_HYSTERESIS_TOKENS = 256;
var MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1000;
function deriveMinForceEligibleTokens(scaledN) {
  return Math.min(MIN_FORCE_ELIGIBLE_TOKENS_CAP, Math.max(1, Math.floor(scaledN / 8)));
}
function clampPercentage(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.max(0, Math.min(100, value));
}
function clampOrdinal(value, rawMessageCount) {
  return Math.max(1, Math.min(rawMessageCount + 1, Math.floor(value)));
}
function deriveProtectedTailTokenTarget(args) {
  const safeContextLimit = Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128000;
  const safeThreshold = Number.isFinite(args.executeThresholdPercentage) ? Math.max(0, args.executeThresholdPercentage) : 65;
  const usable = Math.max(1, Math.round(safeContextLimit * safeThreshold / 100));
  const usage = clampPercentage(args.usagePercentage);
  const triggerBudget = args.triggerBudget ?? deriveTriggerBudget(safeContextLimit, safeThreshold);
  const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
  const rawN = Math.round(usable * ALPHA * (1 - usage / 100));
  const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
  const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5));
  const ceilingN = Math.max(1, Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom));
  const effectiveFloor = Math.min(floorN, ceilingN);
  const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN));
  return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve };
}
function nonEmergencyPerRunCap(usable, N) {
  return Math.min(NON_EMERGENCY_MAX_CAP, Math.max(2 * N, Math.min(Math.round(0.25 * usable), 1e5)));
}
function force80PerRunCap(usable, N) {
  return Math.min(FORCE80_MAX_CAP, Math.max(3 * N, Math.min(Math.round(0.35 * usable), 150000)));
}
function force95PerRunCap(usable, N) {
  return Math.min(FORCE95_MAX_CAP, Math.max(4 * N, Math.min(Math.round(0.5 * usable), 250000)));
}
function selectPerRunCap(snapshot) {
  const usable = Math.max(1, Math.round(snapshot.contextLimit * snapshot.executeThresholdPercentage / 100));
  if (snapshot.usagePercentage >= 95)
    return force95PerRunCap(usable, snapshot.N);
  if (snapshot.usagePercentage >= 80)
    return force80PerRunCap(usable, snapshot.N);
  return nonEmergencyPerRunCap(usable, snapshot.N);
}
function boundaryMessageId(index, ordinal) {
  if (ordinal < 1 || ordinal > index.rawMessageCount)
    return null;
  return index.messageIdAtOrdinal(ordinal);
}
function isSemanticBoundaryCandidate(messageParts, role) {
  if (role === "user" && hasMeaningfulUserText(messageParts))
    return true;
  if (messageParts.some((part) => String(typeof part === "object" && part !== null && "type" in part ? part.type : "") === "tool")) {
    return true;
  }
  return false;
}
function semanticSnapBoundary(args) {
  const { messages, index, candidate, scaledN, lastCompartmentEndOrdinal } = args;
  let snapped = candidate;
  for (const message of messages) {
    if (message.ordinal > candidate)
      break;
    if (message.ordinal < lastCompartmentEndOrdinal + 1)
      continue;
    if (!isSemanticBoundaryCandidate(message.parts, message.role))
      continue;
    snapped = message.ordinal;
  }
  if (snapped === candidate)
    return candidate;
  const extraTokens = index.suffixTokensFromOrdinal(snapped) - index.suffixTokensFromOrdinal(candidate);
  if (extraTokens > Math.min(Math.round(1.5 * scaledN), 48000))
    return candidate;
  const snappedMessage = messages.find((message) => message.ordinal === snapped);
  if (snappedMessage?.role === "user" && index.tokenForOrdinal(snapped) > Math.max(2 * scaledN, 64000)) {
    return candidate;
  }
  return snapped;
}
function snapWrapupBoundaryToUser(args) {
  const { messages, index, candidate, offset, triggerBudget } = args;
  if (candidate <= offset)
    return candidate;
  const snapTokenLimit = Math.min(Math.max(triggerBudget, 2000), 48000);
  for (let ordinal = candidate;ordinal >= offset; ordinal -= 1) {
    const message = messages.find((m) => m.ordinal === ordinal);
    if (!message)
      continue;
    if (message.role !== "user" || !hasMeaningfulUserText(message.parts))
      continue;
    const extraTokens = index.rangeTokens(ordinal, candidate);
    if (extraTokens <= snapTokenLimit)
      return ordinal;
    return candidate;
  }
  return candidate;
}
function fenceWrapupBoundaryForToolArcs(args) {
  let boundary = args.candidate;
  const maxPasses = args.arcs.length + 1;
  for (let pass = 0;pass < maxPasses; pass += 1) {
    let next = boundary;
    for (const arc of args.arcs) {
      if (arc.resOrdinal === null) {
        continue;
      }
      if (arc.invOrdinal >= args.lastCompartmentEndOrdinal + 1 && completedToolArcCrossesBoundary(arc.invOrdinal, arc.resOrdinal, next)) {
        next = arc.invOrdinal;
      }
    }
    if (next === boundary)
      return boundary;
    boundary = next;
  }
  return boundary;
}
function applyHeadCap(args) {
  const { index, protectedTailStart, offset, arcs, capTokens, recentOpenArcCutoff } = args;
  if (offset >= protectedTailStart)
    return { eligibleEndOrdinal: offset, oversizeAtomicUnit: false };
  let end = index.findHeadEndForCap(offset, protectedTailStart, capTokens);
  let oversizeAtomicUnit = end === offset + 1 && index.tokenForOrdinal(offset) > capTokens;
  for (const arc of arcs) {
    const resOrdinal = arc.resOrdinal;
    if (resOrdinal === null) {
      if (arc.invOrdinal >= recentOpenArcCutoff && arc.invOrdinal >= offset && arc.invOrdinal < end) {
        end = Math.min(end, arc.invOrdinal);
      }
      continue;
    }
    if (arc.invOrdinal < end && end <= resOrdinal) {
      end = Math.min(protectedTailStart, resOrdinal + 1);
      if (index.rangeTokens(Math.max(offset, arc.invOrdinal), end) > capTokens)
        oversizeAtomicUnit = true;
    }
  }
  if (end <= offset && offset < protectedTailStart) {
    return { eligibleEndOrdinal: offset, oversizeAtomicUnit };
  }
  return { eligibleEndOrdinal: Math.min(end, protectedTailStart), oversizeAtomicUnit };
}
function resolveProtectedTailBoundary(ctx) {
  const createdAt = ctx.createdAt ?? Date.now();
  const messages = readRawSessionMessages(ctx.sessionId);
  const storedTotals = ctx.storedTokenTotals;
  const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
  const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
    providerShapeVersion: ctx.providerShapeVersion,
    cacheNamespace: ctx.cacheNamespace,
    absoluteMessageCount,
    storedTotalForMessage: storedTotals ? (m) => {
      const v = storedTotals.get(m.id);
      return v === undefined ? null : v;
    } : undefined
  });
  const rawMessageCount = index.rawMessageCount;
  const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
  const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
  const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));
  if (rawMessageCount === 0) {
    return {
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      offset,
      offsetMessageId: null,
      protectedTailStart: 1,
      protectedTailStartMessageId: null,
      eligibleEndOrdinal: 1,
      eligibleEndMessageId: null,
      rawMessageCountAtTrigger: 0,
      rawLastMessageIdAtTrigger: null,
      N: 0,
      usagePercentage,
      usageInputTokens,
      usageSource: ctx.usageSource,
      contextLimit: ctx.contextLimit,
      executeThresholdPercentage: ctx.executeThresholdPercentage,
      triggerBudget: ctx.triggerBudget,
      priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
      migrationFloorActive: ctx.migrationFloorActive,
      emergencyTailScale: ctx.emergencyTailScale,
      providerShapeVersion: ctx.providerShapeVersion,
      cacheNamespace: ctx.cacheNamespace,
      createdAt,
      rawRangeFingerprint: "",
      trueRawEligibleTokens: 0,
      oversizeAtomicUnit: false,
      boundaryReason: "empty-session"
    };
  }
  if (ctx.mode === "manual-full-recomp") {
    const arcs2 = buildToolArcs(messages);
    const recompTarget = deriveProtectedTailTokenTarget({
      contextLimit: ctx.contextLimit,
      executeThresholdPercentage: ctx.executeThresholdPercentage,
      usagePercentage: 0,
      triggerBudget: ctx.triggerBudget
    });
    const recentOpenArcCutoff2 = index.findSuffixStartForTokens(recompTarget.N);
    const firstOpenArc = arcs2.find((arc) => arc.resOrdinal === null && arc.invOrdinal >= offset && arc.invOrdinal >= recentOpenArcCutoff2);
    const protectedTailStart2 = firstOpenArc?.invOrdinal ?? rawMessageCount + 1;
    const rawRangeFingerprint2 = computeRawRangeFingerprint(messages, offset, protectedTailStart2);
    return {
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      offset,
      offsetMessageId: boundaryMessageId(index, offset),
      protectedTailStart: protectedTailStart2,
      protectedTailStartMessageId: null,
      eligibleEndOrdinal: protectedTailStart2,
      eligibleEndMessageId: boundaryMessageId(index, protectedTailStart2 - 1),
      rawMessageCountAtTrigger: rawMessageCount,
      rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
      N: 0,
      usagePercentage: 0,
      usageInputTokens: 0,
      usageSource: "manual-none",
      contextLimit: ctx.contextLimit,
      executeThresholdPercentage: ctx.executeThresholdPercentage,
      triggerBudget: ctx.triggerBudget,
      priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
      migrationFloorActive: false,
      emergencyTailScale: ctx.emergencyTailScale,
      providerShapeVersion: ctx.providerShapeVersion,
      cacheNamespace: ctx.cacheNamespace,
      createdAt,
      rawRangeFingerprint: rawRangeFingerprint2,
      trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart2),
      oversizeAtomicUnit: false,
      boundaryReason: firstOpenArc ? "open-tool-arc" : "manual-full-recomp"
    };
  }
  const target = deriveProtectedTailTokenTarget({
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage,
    usagePercentage,
    triggerBudget: ctx.triggerBudget
  });
  const scaledN = ctx.emergencyTailScale ? Math.max(1, Math.floor(target.N * ctx.emergencyTailScale)) : target.N;
  const arcs = buildToolArcs(messages);
  let boundary = index.findSuffixStartForTokens(scaledN);
  const recentOpenArcCutoff = boundary;
  let boundaryReason = boundary === 1 ? "whole-session-smaller-than-tail" : "size-walk";
  const tokenAtBoundary = index.tokenForOrdinal(boundary);
  if (boundary <= rawMessageCount && tokenAtBoundary > Math.max(2 * scaledN, 64000) && boundary < rawMessageCount) {
    boundary += 1;
    boundaryReason = "huge-message-exception";
  }
  boundary = fenceBoundaryForToolArcs(boundary, arcs, ctx.lastCompartmentEndOrdinal, recentOpenArcCutoff);
  const snapped = semanticSnapBoundary({
    messages,
    index,
    candidate: boundary,
    scaledN,
    lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal
  });
  if (snapped !== boundary)
    boundaryReason = "semantic-snap";
  boundary = fenceBoundaryForToolArcs(snapped, arcs, ctx.lastCompartmentEndOrdinal, recentOpenArcCutoff);
  let runtimeFloor = offset;
  if (ctx.migrationFloorActive)
    runtimeFloor = Math.max(runtimeFloor, ctx.priorBoundaryOrdinal);
  let protectedTailStart = Math.max(boundary, runtimeFloor);
  const forceMaterializationPercentage = escalationBands(ctx.executeThresholdPercentage).forceMaterializationPercentage;
  if (!ctx.emergencyTailScale && usagePercentage < forceMaterializationPercentage) {
    let lastMeaningfulUserOrdinal = 0;
    for (let i = messages.length - 1;i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user")
        continue;
      if (!hasMeaningfulUserText(message.parts))
        continue;
      lastMeaningfulUserOrdinal = message.ordinal;
      break;
    }
    if (lastMeaningfulUserOrdinal >= offset) {
      protectedTailStart = Math.min(protectedTailStart, lastMeaningfulUserOrdinal);
    }
  }
  if (protectedTailStart > offset && index.rangeTokens(offset, protectedTailStart) <= NORMAL_HYSTERESIS_TOKENS) {
    protectedTailStart = offset;
  }
  protectedTailStart = clampOrdinal(protectedTailStart, rawMessageCount);
  const perRunCap = selectPerRunCap({
    usagePercentage,
    N: scaledN,
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage
  });
  const head = applyHeadCap({
    index,
    protectedTailStart,
    offset,
    arcs,
    lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
    capTokens: perRunCap,
    recentOpenArcCutoff
  });
  const rawRangeFingerprint = computeRawRangeFingerprint(messages, offset, head.eligibleEndOrdinal);
  return {
    sessionId: ctx.sessionId,
    mode: ctx.mode,
    offset,
    offsetMessageId: boundaryMessageId(index, offset),
    protectedTailStart,
    protectedTailStartMessageId: boundaryMessageId(index, protectedTailStart),
    eligibleEndOrdinal: head.eligibleEndOrdinal,
    eligibleEndMessageId: boundaryMessageId(index, head.eligibleEndOrdinal - 1),
    rawMessageCountAtTrigger: rawMessageCount,
    rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
    N: scaledN,
    usagePercentage,
    usageInputTokens,
    usageSource: ctx.usageSource,
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage,
    triggerBudget: ctx.triggerBudget,
    priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
    migrationFloorActive: ctx.migrationFloorActive,
    emergencyTailScale: ctx.emergencyTailScale,
    providerShapeVersion: ctx.providerShapeVersion,
    cacheNamespace: ctx.cacheNamespace,
    createdAt,
    rawRangeFingerprint,
    trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart),
    oversizeAtomicUnit: head.oversizeAtomicUnit,
    boundaryReason
  };
}
function resolveBoundaryContext(args) {
  const lastCompartmentEndOrdinal = getLastCompartmentEndMessage(args.db, args.sessionId);
  const triggerBudget = deriveTriggerBudget(args.contextLimit, args.executeThresholdPercentage);
  let meta = loadProtectedTailMeta(args.db, args.sessionId);
  let migrationFloorActive = false;
  if (meta.protectedTailPolicyVersion < 3) {
    let legacyBoundary = 1;
    try {
      legacyBoundary = getLegacyProtectedTailStartOrdinal(args.sessionId);
    } catch (error) {
      sessionLog(args.sessionId, "protected-tail migration seed fell back to ordinal 1:", error);
    }
    const seedResult = markProtectedTailPolicyV3Seeded(args.db, args.sessionId, Math.max(1, legacyBoundary));
    meta = seedResult;
    migrationFloorActive = seedResult.seeded;
  }
  let storedTokenTotals;
  try {
    storedTokenTotals = getAllStatusTagTokenTotalsFlat(args.db, args.sessionId, args.taggerFloor ?? 0).totals;
  } catch (error) {
    sessionLog(args.sessionId, "protected-tail stored-token map unavailable (live fallback):", error);
  }
  return {
    sessionId: args.sessionId,
    mode: args.mode,
    contextLimit: args.contextLimit,
    executeThresholdPercentage: args.executeThresholdPercentage,
    triggerBudget,
    usage: args.usage ?? null,
    usageSource: args.usageSource ?? (args.usage ? "live" : "provisional-zero"),
    lastCompartmentEndOrdinal,
    priorBoundaryOrdinal: meta.priorBoundaryOrdinal,
    protectedTailPolicyVersion: meta.protectedTailPolicyVersion,
    migrationFloorActive,
    emergencyTailScale: args.emergencyTailScale,
    providerShapeVersion: args.providerShapeVersion ?? "opencode-v1",
    cacheNamespace: args.cacheNamespace ?? `opencode:${args.sessionId}`,
    storedTokenTotals
  };
}
function resolveOpenCodeProtectedTailBoundary(args) {
  return resolveProtectedTailBoundary(resolveBoundaryContext(args));
}
function resolveWrapupProtectedTailBoundary(args) {
  const ctx = resolveBoundaryContext({ ...args, mode: "manual-wrapup" });
  const createdAt = ctx.createdAt ?? Date.now();
  const messages = readRawSessionMessages(ctx.sessionId);
  const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
  const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
    providerShapeVersion: ctx.providerShapeVersion,
    cacheNamespace: ctx.cacheNamespace,
    absoluteMessageCount,
    storedTotalForMessage: ctx.storedTokenTotals ? (m) => {
      const value = ctx.storedTokenTotals?.get(m.id);
      return value === undefined ? null : value;
    } : undefined
  });
  const rawMessageCount = index.rawMessageCount;
  const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
  const anchorRawMessageCount = Math.max(0, Math.min(rawMessageCount, Math.floor(args.anchorRawMessageCount ?? rawMessageCount)));
  const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
  const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));
  const rawMessagesAboveLastCompartment = Math.max(0, anchorRawMessageCount - offset + 1);
  const keep = Math.max(1, Math.floor(args.messagesToKeep));
  let targetProtectedTailStart = offset;
  let boundaryReason = "manual-wrapup-empty";
  if (rawMessageCount === 0 || rawMessagesAboveLastCompartment <= keep) {
    targetProtectedTailStart = offset;
    boundaryReason = rawMessageCount === 0 ? "manual-wrapup-empty" : "manual-wrapup-within-keep";
  } else {
    targetProtectedTailStart = anchorRawMessageCount - keep + 1;
    boundaryReason = "manual-wrapup-keep-watermark";
    const arcs = buildToolArcs(messages);
    const fenced = fenceWrapupBoundaryForToolArcs({
      candidate: targetProtectedTailStart,
      arcs,
      lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal
    });
    if (fenced !== targetProtectedTailStart)
      boundaryReason = "manual-wrapup-tool-arc";
    targetProtectedTailStart = fenced;
    const snapped = snapWrapupBoundaryToUser({
      messages,
      index,
      candidate: targetProtectedTailStart,
      offset,
      triggerBudget: ctx.triggerBudget
    });
    if (snapped !== targetProtectedTailStart)
      boundaryReason = "manual-wrapup-user-snap";
    targetProtectedTailStart = snapped;
    const refenced = fenceWrapupBoundaryForToolArcs({
      candidate: targetProtectedTailStart,
      arcs,
      lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal
    });
    if (refenced !== targetProtectedTailStart)
      boundaryReason = "manual-wrapup-tool-arc";
    targetProtectedTailStart = refenced;
  }
  targetProtectedTailStart = clampOrdinal(targetProtectedTailStart, rawMessageCount);
  const target = deriveProtectedTailTokenTarget({
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage,
    usagePercentage,
    triggerBudget: ctx.triggerBudget
  });
  const perRunCap = selectPerRunCap({
    usagePercentage,
    N: target.N,
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage
  });
  const head = applyHeadCap({
    index,
    protectedTailStart: targetProtectedTailStart,
    offset,
    arcs: buildToolArcs(messages),
    lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
    capTokens: perRunCap,
    recentOpenArcCutoff: targetProtectedTailStart
  });
  const eligibleEndOrdinal = Math.min(head.eligibleEndOrdinal, targetProtectedTailStart);
  const rawRangeFingerprint = computeRawRangeFingerprint(messages, offset, eligibleEndOrdinal);
  const snapshot = {
    sessionId: ctx.sessionId,
    mode: "manual-wrapup",
    offset,
    offsetMessageId: boundaryMessageId(index, offset),
    protectedTailStart: targetProtectedTailStart,
    protectedTailStartMessageId: boundaryMessageId(index, targetProtectedTailStart),
    eligibleEndOrdinal,
    eligibleEndMessageId: boundaryMessageId(index, eligibleEndOrdinal - 1),
    rawMessageCountAtTrigger: rawMessageCount,
    rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
    N: keep,
    usagePercentage,
    usageInputTokens,
    usageSource: ctx.usageSource,
    contextLimit: ctx.contextLimit,
    executeThresholdPercentage: ctx.executeThresholdPercentage,
    triggerBudget: ctx.triggerBudget,
    priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
    migrationFloorActive: ctx.migrationFloorActive,
    emergencyTailScale: ctx.emergencyTailScale,
    providerShapeVersion: ctx.providerShapeVersion,
    cacheNamespace: ctx.cacheNamespace,
    createdAt,
    rawRangeFingerprint,
    trueRawEligibleTokens: index.rangeTokens(offset, targetProtectedTailStart),
    oversizeAtomicUnit: head.oversizeAtomicUnit,
    boundaryReason
  };
  return {
    snapshot,
    rawMessagesAboveLastCompartment,
    anchorRawMessageCount,
    targetProtectedTailStart,
    targetEligibleEndOrdinal: targetProtectedTailStart
  };
}
function hasRunnableCompartmentWindow(snapshot) {
  if (snapshot.offset >= snapshot.protectedTailStart)
    return false;
  const forceMaterializationPercentage = escalationBands(snapshot.executeThresholdPercentage).forceMaterializationPercentage;
  if (snapshot.usagePercentage >= forceMaterializationPercentage || snapshot.emergencyTailScale) {
    return snapshot.trueRawEligibleTokens >= deriveMinForceEligibleTokens(snapshot.N) || snapshot.eligibleEndOrdinal > snapshot.offset;
  }
  return snapshot.eligibleEndOrdinal > snapshot.offset;
}
function validateBoundarySnapshot(args) {
  const { snapshot } = args;
  if (args.currentContextLimit && args.currentContextLimit !== snapshot.contextLimit) {
    return {
      ok: false,
      reason: "model_or_limit_changed",
      detail: `context limit changed from ${snapshot.contextLimit} to ${args.currentContextLimit}`
    };
  }
  const messages = readRawSessionMessages(snapshot.sessionId);
  const currentRawMessageCount = messages.reduce((max, message) => Math.max(max, message.ordinal), messages.length);
  if (snapshot.rawMessageCountAtTrigger > currentRawMessageCount) {
    return { ok: false, reason: "stale_snapshot", detail: "raw message count shrank" };
  }
  const idsByOrdinal = new Map(messages.map((message) => [message.ordinal, message.id]));
  const idAt = (ordinal) => idsByOrdinal.get(ordinal) ?? null;
  const checks = [
    [snapshot.offset, snapshot.offsetMessageId, "offset"],
    [snapshot.rawMessageCountAtTrigger, snapshot.rawLastMessageIdAtTrigger, "last"]
  ];
  if (snapshot.protectedTailStart <= snapshot.rawMessageCountAtTrigger) {
    checks.push([
      snapshot.protectedTailStart,
      snapshot.protectedTailStartMessageId,
      "protectedTailStart"
    ]);
  }
  if (snapshot.eligibleEndOrdinal > snapshot.offset) {
    checks.push([
      snapshot.eligibleEndOrdinal - 1,
      snapshot.eligibleEndMessageId,
      "eligibleEnd"
    ]);
  }
  for (const [ordinal, expected, label] of checks) {
    if (expected !== idAt(ordinal)) {
      return {
        ok: false,
        reason: "stale_snapshot",
        detail: `${label} ordinal ${ordinal} id changed`
      };
    }
  }
  const expectedOffset = Math.max(1, getLastCompartmentEndMessage(args.db, snapshot.sessionId) + 1);
  if (expectedOffset !== snapshot.offset) {
    return {
      ok: false,
      reason: "stale_snapshot",
      detail: `last compartment moved: offset ${snapshot.offset} -> ${expectedOffset}`
    };
  }
  const fingerprint = computeRawRangeFingerprint(messages, snapshot.offset, snapshot.eligibleEndOrdinal);
  if (fingerprint !== snapshot.rawRangeFingerprint) {
    return { ok: false, reason: "stale_snapshot", detail: "raw range fingerprint changed" };
  }
  return { ok: true };
}
function recordHighPressureNoEligibleHead(db, snapshot) {
  const forceMaterializationPercentage = escalationBands(snapshot.executeThresholdPercentage).forceMaterializationPercentage;
  if (snapshot.usagePercentage < forceMaterializationPercentage && !snapshot.emergencyTailScale) {
    return 0;
  }
  return recordProtectedTailNoEligibleHead(db, snapshot.sessionId);
}
function createDefaultBoundarySnapshotForTests(sessionId) {
  const messages = readRawSessionMessages(sessionId);
  const rawMessageCount = messages.length;
  const protectedTailStart = Math.max(1, Math.min(rawMessageCount + 1, getLegacyProtectedTailStartOrdinal(sessionId)));
  const index = buildTrueRawTokenIndex(sessionId, messages, {
    providerShapeVersion: "opencode-v1",
    cacheNamespace: `test:${sessionId}`
  });
  const trueRawEligibleTokens = index.rangeTokens(1, protectedTailStart);
  const messageIdAt = (ordinal) => messages.find((message) => message.ordinal === ordinal)?.id ?? null;
  return {
    sessionId,
    mode: "incremental-runner",
    offset: 1,
    offsetMessageId: messageIdAt(1),
    protectedTailStart,
    protectedTailStartMessageId: messageIdAt(protectedTailStart),
    eligibleEndOrdinal: protectedTailStart,
    eligibleEndMessageId: messageIdAt(protectedTailStart - 1),
    rawMessageCountAtTrigger: rawMessageCount,
    rawLastMessageIdAtTrigger: messageIdAt(rawMessageCount),
    N: 0,
    usagePercentage: 0,
    usageInputTokens: 0,
    usageSource: "provisional-zero",
    contextLimit: 128000,
    executeThresholdPercentage: 65,
    triggerBudget: deriveTriggerBudget(128000, 65),
    priorBoundaryOrdinal: protectedTailStart,
    migrationFloorActive: false,
    providerShapeVersion: "opencode-v1",
    cacheNamespace: `test:${sessionId}`,
    createdAt: Date.now(),
    rawRangeFingerprint: "",
    trueRawEligibleTokens,
    oversizeAtomicUnit: false,
    boundaryReason: "test-legacy"
  };
}

// ../plugin/src/hooks/magic-context/compartment-trigger.ts
var PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2;
var POST_DROP_TARGET_RATIO = 0.75;
function getProactiveCompartmentTriggerPercentage(executeThresholdPercentage) {
  return Math.max(0, executeThresholdPercentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE);
}

// ../plugin/src/shared/format-bytes.ts
function formatBytes(bytes) {
  if (bytes < 1024)
    return `${bytes}B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
// ../plugin/src/hooks/magic-context/execute-status.ts
function formatExecuteThreshold(detail, contextLimit) {
  const { percentage, mode } = detail;
  const clampNote = formatThresholdClampNote({
    clamped: detail.clamped,
    mode,
    configuredValue: detail.configuredValue,
    contextLimit,
    maxPercentage: MAX_EXECUTE_THRESHOLD
  });
  if (mode === "tokens" && contextLimit > 0) {
    const tokens = Math.floor(percentage / 100 * contextLimit);
    return `${tokens.toLocaleString()} tokens (${percentage.toFixed(1)}% of ${contextLimit.toLocaleString()}) [token-mode]${clampNote}`;
  }
  if (contextLimit > 0) {
    const tokens = Math.floor(percentage / 100 * contextLimit);
    return `${percentage}% (${tokens.toLocaleString()} of ${contextLimit.toLocaleString()})${clampNote}`;
  }
  return `${percentage}%${clampNote}`;
}
function executeStatus(db, sessionId, protectedTags, executeThresholdPercentageConfig = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE, liveModelKey, historyBudgetPercentage, commitClusterTrigger, executeThresholdTokens, contextLimit, dreamer, windowGeometry) {
  const thresholdDetail = resolveExecuteThresholdDetail(executeThresholdPercentageConfig, liveModelKey, DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE, {
    tokensConfig: executeThresholdTokens,
    contextLimit,
    sessionId
  });
  const executeThresholdPercentage = thresholdDetail.percentage;
  try {
    const meta = getOrCreateSessionMeta(db, sessionId);
    const tags = getTagsBySession(db, sessionId);
    const pendingOps = getPendingOps(db, sessionId);
    const activeTags = tags.filter((t) => t.status === "active");
    const droppedTags = tags.filter((t) => t.status === "dropped");
    const totalBytes = activeTags.reduce((sum, t) => sum + t.byteSize, 0);
    let ttlMs;
    try {
      ttlMs = parseCacheTtl(meta.cacheTtl);
    } catch (error) {
      sessionLog(sessionId, `invalid cache_ttl "${meta.cacheTtl}" in ctx-status; falling back to default 5m`, error);
      ttlMs = parseCacheTtl("5m");
    }
    const elapsed = Date.now() - meta.lastResponseTime;
    const remainingMs = Math.max(0, ttlMs - elapsed);
    const cacheExpired = remainingMs === 0 && meta.lastResponseTime > 0;
    const proactiveCompartmentTrigger = getProactiveCompartmentTriggerPercentage(executeThresholdPercentage);
    const displayContextLimit = contextLimit && contextLimit > 0 ? contextLimit : meta.lastContextPercentage > 0 ? Math.round(meta.lastInputTokens / (meta.lastContextPercentage / 100)) : 0;
    const lines = [
      "## Magic Status",
      "",
      `**Session:** ${sessionId}`,
      `**Tag counter:** ${meta.counter}`,
      "",
      "### Tags",
      `- Active: ${activeTags.length} (~${formatBytes(totalBytes)})`,
      `- Dropped: ${droppedTags.length}`,
      `- Total: ${tags.length}`,
      "",
      "### Pending Queue",
      `- Drops: ${pendingOps.length}`,
      `- Total queued: ${pendingOps.length}`,
      "",
      ...meta.lastTransformError ? ["### Last Transform Error", `- ${meta.lastTransformError}`, ""] : [],
      "### Cache TTL",
      `- Configured: ${meta.cacheTtl}`,
      `- Last response: ${meta.lastResponseTime > 0 ? `${Math.round(elapsed / 1000)}s ago` : "never"}`,
      `- Remaining: ${cacheExpired ? "expired" : ttlMs === Number.POSITIVE_INFINITY ? "never expires (always-warm lane)" : `${Math.round(remainingMs / 1000)}s`}`,
      `- Queue will auto-execute: ${cacheExpired ? "yes (cache expired)" : ttlMs === Number.POSITIVE_INFINITY ? `when context >= ${executeThresholdPercentage}%` : `when TTL expires or context >= ${executeThresholdPercentage}%`}`,
      "",
      "### Execute Threshold",
      `- Execute threshold: ${formatExecuteThreshold(thresholdDetail, displayContextLimit)}`,
      `- Last input tokens: ${meta.lastInputTokens.toLocaleString()} tokens`,
      "",
      `**Protected tags:** ${protectedTags}`,
      `**Subagent session:** ${meta.isSubagent}`
    ];
    if (dreamer?.backlog && Object.keys(dreamer.backlog).length > 0) {
      lines.push("", "### Dreamer", ...dreamer.progress ? [
        `- Running: ${dreamer.progress.task} — ${dreamer.progress.processed}/${dreamer.progress.total} processed`
      ] : [], ...formatDreamTaskBacklogs(dreamer.backlog).split("\\n"));
    }
    if (meta.lastContextPercentage > 0 || meta.lastInputTokens > 0) {
      lines.push("", "### Context Usage", `- Last percentage: ${meta.lastContextPercentage.toFixed(1)}%`, `- Last input tokens: ${meta.lastInputTokens.toLocaleString()}`, `- Resolved context limit: ${displayContextLimit > 0 ? displayContextLimit.toLocaleString() : "unknown"}`, ...windowGeometry ? [`- ${formatWindowDerivationLine(meta.lastInputTokens, windowGeometry)}`] : [], `- Proactive compartment evaluation: ${proactiveCompartmentTrigger}%`, `- Post-drop target for historian: ${(executeThresholdPercentage * POST_DROP_TARGET_RATIO).toFixed(0)}% (${executeThresholdPercentage}% * ${POST_DROP_TARGET_RATIO})`, `- Commit cluster trigger: ${commitClusterTrigger?.enabled !== false ? `enabled (min ${commitClusterTrigger?.min_clusters ?? 3} clusters)` : "disabled"}, tail-size trigger: > 3x compartment budget`);
    }
    const compartments = getCompartments(db, sessionId);
    let historyBlockTokens = 0;
    for (const c of compartments) {
      historyBlockTokens += estimateTokens(`## ${c.startMessage}-${c.endMessage} · ${c.title}
${c.content}
`);
    }
    const budgetTokens = historyBudgetPercentage && displayContextLimit > 0 ? Math.floor(displayContextLimit * (Math.min(executeThresholdPercentage, 80) / 100) * historyBudgetPercentage) : null;
    const budgetUsage = budgetTokens ? (historyBlockTokens / budgetTokens * 100).toFixed(0) : null;
    lines.push("", "### History Compression", `- Compartments: ${compartments.length}`, `- History block: ~${historyBlockTokens.toLocaleString()} tokens`, ...budgetTokens ? [
      `- History budget: ~${budgetTokens.toLocaleString()} tokens (${budgetUsage}% used)`,
      `- Older compartments demote tiers automatically at render time to fit the budget`
    ] : [`- History budget: not configured (history_budget_percentage not set)`]);
    if (pendingOps.length > 0) {
      lines.push("", "### Queued Operations");
      for (const op of pendingOps) {
        lines.push(`- §${op.tagId}§ → ${op.operation}`);
      }
    }
    if (dreamer?.backlog && Object.keys(dreamer.backlog).length > 0) {
      lines.push("", "### Dreamer Backlog", formatDreamTaskBacklogs(dreamer.backlog));
    }
    if (dreamer?.progress) {
      lines.push("", "### Dreamer Progress", `- ${dreamer.progress.task}: ${dreamer.progress.processed}/${dreamer.progress.total} processed this run`);
    }
    return lines.join(`
`);
  } catch (error) {
    sessionLog(sessionId, "ctx-status failed:", error);
    return `Error: Failed to read context status. ${getErrorMessage(error)}`;
  }
}

// ../plugin/src/hooks/magic-context/format-embed-status.ts
function formatEmbedStatusText(coverage, drain) {
  if (!coverage.enabled) {
    return "Embedding is off (no provider configured).";
  }
  const lines = [];
  lines.push(`Embedding — model: ${coverage.model} (${coverage.provider})`);
  lines.push(`This session:  ${coverage.session.embedded} / ${coverage.session.total} compartments embedded`);
  lines.push(`Project memories:  ${coverage.memories.embedded} / ${coverage.memories.total} embedded`);
  if (coverage.commits.gitEnabled) {
    lines.push(`Git commits:  ${coverage.commits.embedded} / ${coverage.commits.total}`);
  } else {
    lines.push("Git commits:  0 / 0 (git indexing off)");
  }
  let drainLine = "Drain: idle";
  switch (drain.status) {
    case "running": {
      const e = drain.embedded ?? coverage.session.embedded;
      const t = drain.total ?? coverage.session.total;
      const failedSuffix = drain.failed && drain.failed > 0 ? ` (${drain.failed} failed)` : "";
      drainLine = `Drain: running ${e}/${t}${failedSuffix}`;
      break;
    }
    case "paused": {
      const e = drain.embedded ?? coverage.session.embedded;
      const t = drain.total ?? coverage.session.total;
      drainLine = `Drain: paused ${e}/${t}`;
      break;
    }
    case "stopped":
      drainLine = "Drain: stopped (provider down)";
      break;
    default:
      drainLine = "Drain: idle";
  }
  lines.push(drainLine);
  return lines.join(`
`);
}

// src/compat/dsh-0.1/commands.ts
function registerCommand(ctx, definition) {
  const commands = ctx.get("commands");
  if (commands === undefined)
    throw new Error("commands service unavailable");
  return commands.register(definition);
}
function successResult(text) {
  return { kind: "success", text };
}
function errorResult(text) {
  return { kind: "error", text };
}

// src/agent/commands.ts
var COMPACTION_OFF_UNAVAILABLE = "Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).";
var MAGIC_SOURCE = { kind: "plugin", plugin: "magic-context" };
function modelKeyOf(agent) {
  const { provider, model } = agent.options;
  if (provider && model)
    return `${provider}/${model}`;
  return;
}
function dreamerBacklogFor(db, projectIdentity) {
  if (!projectIdentity)
    return;
  try {
    return getDreamTaskBacklogs(db, projectIdentity, CANONICAL_DREAM_TASKS);
  } catch {
    return;
  }
}
function registerCtxStatusCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-status",
    description: "Show Magic Context status for the current DSH session",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        const meta = getOrCreateSessionMeta(db, sessionId);
        let detectedContextLimit;
        try {
          const detected = getOverflowState(db, sessionId).detectedContextLimit;
          if (detected > 0)
            detectedContextLimit = detected;
        } catch {}
        const statusText = executeStatus(db, sessionId, opts.protectedTags ?? DEFAULT_PROTECTED_TAGS, opts.executeThresholdPercentage, modelKeyOf(agent), opts.historyBudgetPercentage, opts.commitClusterTrigger, opts.executeThresholdTokens, detectedContextLimit, { backlog: dreamerBacklogFor(db, projectIdentity) });
        return successResult(statusText);
      } catch (error) {
        return errorResult(`## Magic Status — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function registerCtxFlushCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-flush",
    description: "Force pending Magic Context drops to materialize on the next provider call",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff)
          return errorResult(COMPACTION_OFF_UNAVAILABLE);
        const db = await resolveDb(ctx, opts);
        const pendingBefore = getPendingOps(db, sessionId).length;
        const result = executeFlush(db, sessionId);
        const text = pendingBefore > 0 ? `## /ctx-flush

Flushed ${pendingBefore} pending ops; next provider call will materialize.

${result}` : `## /ctx-flush

${result}`;
        return result.startsWith("Error:") ? errorResult(text) : successResult(text);
      } catch (error) {
        return errorResult(`## /ctx-flush — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function registerCtxDreamCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-dream",
    description: "Run Magic Context dreamer tasks for this project now",
    handler: async (invocation) => {
      const agent = invocation.agent;
      const requested = invocation.rawInput.trim();
      let task;
      if (requested) {
        if (!isCanonicalDreamTask(requested)) {
          return successResult(`## /ctx-dream

Unknown task "${requested}".`);
        }
        task = requested;
      }
      if (opts.dreamer?.runnable === false) {
        return successResult("## /ctx-dream\n\nDreamer is disabled for this project (`dreamer.disable=true`).");
      }
      if (!opts.dreamer) {
        return successResult(`## /ctx-dream

Dreamer executor is not wired yet (Phase 2 slice C). The registered timer will run due tasks on its next tick.`);
      }
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        if (!projectIdentity) {
          return errorResult(`## /ctx-dream

Could not resolve project identity.`);
        }
        const backlogTasks = task ? [task] : CANONICAL_DREAM_TASKS;
        const backlogBefore = getDreamTaskBacklogs(db, projectIdentity, backlogTasks);
        const result = await runManualDream({
          db,
          projectIdentity,
          tasks: opts.dreamer.tasks,
          executor: opts.dreamer.executor,
          ...task ? { task } : {}
        });
        const lines = ["## /ctx-dream", ""];
        if (result.ran.length > 0)
          lines.push(`Ran: ${result.ran.join(", ")}`);
        if (result.failed.length > 0)
          lines.push(`Failed: ${result.failed.join(", ")}`);
        if ((result.failureDetails?.length ?? 0) > 0) {
          lines.push("Failure details:", ...(result.failureDetails ?? []).map((detail) => `- ${detail}`));
        }
        if (result.skippedNoWork.length > 0) {
          lines.push(`Skipped (no work): ${result.skippedNoWork.join(", ")}`);
        }
        if (result.deferredBusy.length > 0) {
          lines.push(`Busy: ${result.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`);
        }
        if (Object.keys(result.backlogAfter ?? {}).length > 0) {
          lines.push("", "Backlog at run end:", formatDreamTaskBacklogs(result.backlogAfter));
        }
        if (lines.length === 2)
          lines.push("No enabled dream tasks to run.");
        return successResult(lines.join(`
`));
      } catch (error) {
        return errorResult(`## /ctx-dream

Dream run failed: ${describeError(error).brief}
The registered timer will retry due tasks on its next tick.`);
      }
    }
  });
}
function registerCtxEmbedCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-embed",
    description: "Embedding status, or start/pause history compartment embedding (start | pause)",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        if (!projectIdentity) {
          return errorResult(`## /ctx-embed

Could not resolve project identity.`);
        }
        const sub = invocation.rawInput.trim().toLowerCase();
        if (sub === "pause" || sub === "start") {
          if (!opts.runEmbedDrain) {
            return successResult(`## /ctx-embed

The embedding drain runner is not wired yet (Phase 2 slice C).`);
          }
          const { text, level } = await opts.runEmbedDrain({
            agent,
            sessionId,
            projectIdentity,
            cwd,
            signal: invocation.signal,
            db,
            action: sub === "pause" ? "pause" : "start"
          });
          return level === "error" ? errorResult(text) : successResult(text);
        }
        if (sub !== "") {
          return errorResult("## /ctx-embed\n\nUsage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.");
        }
        await opts.ensureProjectRegistered?.(cwd, db);
        const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
        const statusText = formatEmbedStatusText(coverage, { status: "idle" });
        return successResult(`## Embedding Status

${statusText}`);
      } catch (error) {
        return errorResult(`## /ctx-embed — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function registerCtxAugCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-aug",
    description: "Augment your prompt with relevant project context (sidekick)",
    handler: async (invocation) => {
      const agent = invocation.agent;
      const prompt = invocation.rawInput.trim();
      if (prompt.length === 0) {
        return errorResult("/ctx-aug: Usage `/ctx-aug <your prompt>` — provide a prompt to augment with project memory context.");
      }
      if (!opts.runSidekick) {
        return successResult("/ctx-aug: Sidekick runner is not wired yet (Phase 2 slice C). Add `sidekick.model` to your magic-context.jsonc to enable this command.");
      }
      try {
        const cwd = cwdOf(agent);
        const projectIdentity = cwd ? resolveProjectIdentity(ctx, opts, cwd) : undefined;
        const sidekickText = await opts.runSidekick({
          agent,
          prompt,
          cwd,
          projectIdentity,
          signal: invocation.signal
        });
        if (!sidekickText) {
          agent.followup(magicUserMessage(prompt, MAGIC_SOURCE));
          return successResult("/ctx-aug: sidekick returned no augmentation; the prompt was sent unchanged.");
        }
        const augmentedPrompt = `${prompt}

<sidekick-augmentation>
${sidekickText}
</sidekick-augmentation>`;
        agent.followup(magicUserMessage(augmentedPrompt, MAGIC_SOURCE));
        return successResult("/ctx-aug: augmentation queued as the next user message.");
      } catch (error) {
        agent.followup(magicUserMessage(prompt, MAGIC_SOURCE));
        return successResult(`/ctx-aug: sidekick failed (${describeError(error).brief}). Sending prompt without augmentation.`);
      }
    }
  });
}
var RECOMP_USAGE = [
  "Usage:",
  "- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
  "- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
  "- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout (Wave 3 runner)"
].join(`
`);
function parseRecompArgs(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    return { kind: "full" };
  if (trimmed === "--upgrade")
    return { kind: "upgrade" };
  const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return { kind: "error", message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.

${RECOMP_USAGE}` };
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (start < 1)
    return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
  if (end < start)
    return { kind: "error", message: `End must be >= start (got ${start}-${end}).` };
  return { kind: "partial", range: { start, end } };
}
var confirmationBySession = new Map;
var RECOMP_CONFIRMATION_WINDOW_MS = 60000;
function buildConfirmationWarning(db, sessionId, parsed) {
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
        `**To confirm, run \`/ctx-recomp ${parsed.range.start}-${parsed.range.end}\` again within 60 seconds.**`
      ].join(`
`)
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
      "**To confirm, run `/ctx-recomp` again within 60 seconds.**"
    ].join(`
`)
  };
}
function registerCtxRecompCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-recomp",
    description: "Rebuild Magic Context compartments from raw DSH session history",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff)
          return errorResult(COMPACTION_OFF_UNAVAILABLE);
        const parsed = parseRecompArgs(invocation.rawInput);
        if (parsed.kind === "error") {
          return errorResult(`## Magic Recomp — Invalid Arguments

${parsed.message}`);
        }
        const db = await resolveDb(ctx, opts);
        if (parsed.kind === "upgrade") {
          const legacyCount = getCompartments(db, sessionId).filter((compartment) => compartment.legacy === 1).length;
          if (legacyCount === 0) {
            return successResult(`## Magic Recomp Upgrade

Nothing to upgrade: this session has no legacy compartments.`);
          }
          return successResult([
            "## Magic Recomp Upgrade",
            "",
            `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
            "The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session."
          ].join(`
`));
        }
        if (!opts.runRecomp) {
          return successResult(`## Magic Recomp

The recomp runner is not wired yet (Phase 2 slice C).`);
        }
        const argsKey = parsed.kind === "partial" ? `${parsed.range.start}-${parsed.range.end}` : "";
        const now = Date.now();
        const confirmation = confirmationBySession.get(sessionId);
        const confirmed = confirmation !== undefined && now - confirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS && confirmation.argsKey === argsKey;
        if (!confirmed) {
          const warning = buildConfirmationWarning(db, sessionId, parsed);
          if (!warning.confirmable)
            confirmationBySession.delete(sessionId);
          else
            confirmationBySession.set(sessionId, { timestamp: now, argsKey });
          return warning.confirmable ? { kind: "success", text: warning.text } : errorResult(warning.text);
        }
        confirmationBySession.delete(sessionId);
        const cwd = cwdOf(agent);
        const result = await opts.runRecomp({
          agent,
          sessionId,
          cwd,
          rawInput: invocation.rawInput,
          signal: invocation.signal,
          db
        });
        return inferCommandLevel(result);
      } catch (error) {
        return errorResult(`## Magic Recomp — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function inferCommandLevel(text) {
  const lower = text.toLowerCase();
  if (lower.includes("failed") || lower.includes("error") || lower.includes("incomplete")) {
    return errorResult(text);
  }
  return successResult(text);
}
var DEFAULT_MESSAGES_TO_KEEP = 20;
function parseWrapupArgs(raw) {
  const trimmed = raw.trim();
  if (trimmed === "")
    return { ok: true, messagesToKeep: DEFAULT_MESSAGES_TO_KEEP };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer."
    };
  }
  const messagesToKeep = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
    return { ok: false, message: "messages_to_keep must be a positive integer." };
  }
  return { ok: true, messagesToKeep };
}
function registerCtxWrapupCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-wrapup",
    description: "Compact older Magic Context history while keeping the newest messages raw",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff)
          return errorResult(COMPACTION_OFF_UNAVAILABLE);
        const parsed = parseWrapupArgs(invocation.rawInput);
        if (!parsed.ok) {
          return errorResult(`## Magic Wrapup — Invalid Arguments

${parsed.message}`);
        }
        if (!opts.runWrapup) {
          return successResult(`## Magic Wrapup

The wrapup runner is not wired yet (Phase 2 slice C).`);
        }
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const result = await opts.runWrapup({
          agent,
          sessionId,
          cwd,
          messagesToKeep: parsed.messagesToKeep,
          signal: invocation.signal,
          db
        });
        return result.includes("Failed") || result.includes("Partial") ? errorResult(result) : successResult(result);
      } catch (error) {
        return errorResult(`## Magic Wrapup — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function registerCtxSessionUpgradeCommand(ctx, opts) {
  return registerCommand(ctx, {
    name: "ctx-session-upgrade",
    description: "Upgrade this session to the current Magic Context history format and re-organize project memories",
    handler: async (invocation) => {
      const agent = invocation.agent;
      try {
        const sessionId = resolveCanonicalKey(ctx, opts, agent);
        if (!sessionId)
          return errorResult("No canonical session id is available for this agent.");
        if (opts.compactionOff)
          return errorResult(COMPACTION_OFF_UNAVAILABLE);
        if (!opts.runUpgrade) {
          return successResult(`## Session Upgrade

The upgrade runner is not wired yet (Phase 2 slice C).`);
        }
        const db = await resolveDb(ctx, opts);
        const cwd = cwdOf(agent);
        const result = await opts.runUpgrade({
          agent,
          sessionId,
          cwd,
          signal: invocation.signal,
          db
        });
        return inferCommandLevel(result);
      } catch (error) {
        return errorResult(`## Session Upgrade — Failed

${describeError(error).brief}`);
      }
    }
  });
}
function registerCtxCommands(ctx, opts = {}) {
  const disposers = [
    registerCtxStatusCommand(ctx, opts),
    registerCtxFlushCommand(ctx, opts),
    registerCtxDreamCommand(ctx, opts),
    registerCtxEmbedCommand(ctx, opts),
    registerCtxAugCommand(ctx, opts),
    registerCtxRecompCommand(ctx, opts),
    registerCtxWrapupCommand(ctx, opts),
    registerCtxSessionUpgradeCommand(ctx, opts)
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  };
}

export { resolveCacheTtl, parseCacheTtl, SMART_NOTE_CHECK_FLOOR_MS, SMART_NOTE_CHECK_CEILING_MS, SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS, SmartNoteNetworkError, SmartNoteSecurityError, isSmartNoteNetworkError, isTerminalSmartNoteNetworkError, parseSmartNoteManifest, commitSmartNoteState, getDueCompiledSmartNoteChecks, getSmartNotesNeedingCompilation, getStaleCompiledSmartNotes, storeCompiledSmartNoteCheck, markCompiledCheckFalse, markCompiledCheckLogicFailure, markCompiledCheckNetworkFailure, markSmartNoteLivenessChecked, markSmartNoteCheckStatus, markSmartNoteCompilationFailure, getTaskScheduleState, writeTaskScheduleState, isRetrospectiveWindowProcessed, recordRetrospectiveWindowProcessed, CANONICAL_DREAM_TASKS, processedDreamTaskItems, leaseKeyFor, getDreamTaskBacklog, DREAMING_LEASE_KEY, getLeaseHolder, peekLeaseHolderAndExpiry, leaseOwnershipMatches, acquireLeaseWithAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat, runDueTasksForProject, selectPerRunCap, resolveOpenCodeProtectedTailBoundary, resolveWrapupProtectedTailBoundary, hasRunnableCompartmentWindow, validateBoundarySnapshot, recordHighPressureNoEligibleHead, createDefaultBoundarySnapshotForTests, getProactiveCompartmentTriggerPercentage, parseRecompArgs, registerCtxCommands };
