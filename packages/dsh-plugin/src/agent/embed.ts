/**
 * agent/embed — the /ctx-embed drain runner (Phase 5 close-out of #21).
 *
 * Mirrors the Pi adapter's runEmbedDrain over the shared core machinery:
 * `embedSessionCompartmentChunks` (project-embedding-registry) with the
 * per-session run/pause state maps (embed-session-state). The outcome
 * statuses (nothing/disabled/busy/aborted/stalled/completed) map to the same
 * user-facing texts as Pi.
 */
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  embedSessionCompartmentChunks,
  getEmbeddingCoverageStatus,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import {
  embedPauseBySession,
  embedRunStateBySession,
} from "@magic-context/core/hooks/magic-context/embed-session-state";
import type { CtxCommandSeams } from "./commands";

export type EmbedDrainStatus = { text: string; level: "success" | "info" | "error" };

/** Injectable chunk-embedding runner (tests stub it; production = the core). */
export type EmbedChunksRunner = (
  db: Database,
  projectIdentity: string,
  sessionId: string,
  options: { signal: AbortSignal },
) => Promise<
  | { status: "nothing" | "disabled" | "busy" | "aborted" }
  | { status: "stalled"; embedded: number; remaining: number }
  | { status: "completed" | "ok"; embedded: number }
>;

/** Run the embedding drain for one session (idempotent start + pause support). */
export async function runEmbedDrain(
  db: Database,
  projectIdentity: string,
  sessionId: string,
  action: "start" | "pause",
  signal: AbortSignal,
  now: () => number = Date.now,
  runner: EmbedChunksRunner = embedSessionCompartmentChunks as EmbedChunksRunner,
): Promise<EmbedDrainStatus> {
  if (action === "pause") {
    embedPauseBySession.add(sessionId);
    const ctrl = embedRunStateBySession.get(sessionId);
    if (ctrl) ctrl.abort();
    const cov = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
    return {
      text: `## /ctx-embed\n\nPaused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`,
      level: "info",
    };
  }

  // Idempotent start: a drain already running for this session is kept.
  const activeCtrl = embedRunStateBySession.get(sessionId);
  if (activeCtrl && !activeCtrl.signal.aborted) {
    return {
      text: "## /ctx-embed\n\nEmbedding is already running for this session.",
      level: "info",
    };
  }
  embedPauseBySession.delete(sessionId);
  const prior = embedRunStateBySession.get(sessionId);
  if (prior) prior.abort();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  embedRunStateBySession.set(sessionId, controller);
  void now;
  try {
    const outcome = await runner(db, projectIdentity, sessionId, {
      signal: controller.signal,
    });
    switch (outcome.status) {
      case "nothing":
        return {
          text: "## /ctx-embed\n\nAll of this session's history is already embedded.",
          level: "info",
        };
      case "disabled":
        return {
          text: "## /ctx-embed\n\nNo embedding provider is configured, so there is nothing to embed.",
          level: "info",
        };
      case "busy":
        return {
          text: "## /ctx-embed\n\nEmbedding is already running for this project. Try again shortly.",
          level: "info",
        };
      case "aborted": {
        const cov = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
        return {
          text: `## /ctx-embed\n\nPaused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`,
          level: "info",
        };
      }
      case "stalled":
        return {
          text: `## /ctx-embed\n\nEmbedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"}; ${outcome.remaining} could not be embedded (the provider returned no result). Run /ctx-embed start again to retry them.`,
          level: "info",
        };
      default:
        return {
          text: `## /ctx-embed\n\nEmbedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search.`,
          level: "success",
        };
    }
  } finally {
    if (embedRunStateBySession.get(sessionId) === controller) {
      embedRunStateBySession.delete(sessionId);
    }
    signal.removeEventListener("abort", onAbort);
  }
}

/** Wire the `/ctx-embed` seam (commands.ts expects `runEmbedDrain`). */
export function createEmbedSeam(deps: { log?: (message: string) => void }): NonNullable<CtxCommandSeams["runEmbedDrain"]> {
  return ({ sessionId, projectIdentity, db, signal, action }) =>
    runEmbedDrain(db, projectIdentity, sessionId, action, signal);
}
