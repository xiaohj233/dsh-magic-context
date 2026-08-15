/**
 * HarnessRuntime — the explicit Host-neutral runtime surface a harness adapter
 * implements so the shared Magic core never sees harness-specific primitives.
 *
 * This is the DSH port's formalization of what the Pi adapter currently gets
 * implicitly from `@earendil-works/pi-coding-agent`'s ExtensionAPI (PLAN §2
 * adapter-api purpose; magic-reference §附录 row for adapter-api).
 *
 * Every member maps one Pi primitive from magic-reference §10 to a DSH-side
 * capability:
 *   runtime.model        ← Pi `ctx.model` (provider/id/contextWindow)
 *   runtime.notify       ← Pi `ctx.ui.notify`
 *   runtime.setStatus    ← Pi `ctx.ui.setStatus`
 *   runtime.sendMessage  ← Pi `pi.sendUserMessage` (Channel-2 ceiling nudge)
 *   runtime.inject       ← DSH `agent.inject()` (pre-step context channel)
 *   runtime.hasUI        ← Pi `ctx.hasUI`
 *   runtime.signal       ← Pi `ctx.signal`
 */
export interface HarnessRuntime {
  /** Current routed model: native provider id, model id, advertised window. */
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
  };
  /** Whether the runtime exposes interactive UI (print mode → skip notices). */
  readonly hasUI: boolean;
  /** The current turn's cancellation signal, when one is active. */
  readonly signal?: AbortSignal;
  /** UI notification (fire-and-forget). */
  notify(message: string, level?: "info" | "warn" | "error"): void;
  /** Persistent status-line text (model-invisible). */
  setStatus(key: string, text: string): void;
  /** Inject a follow-up user message (ceiling nudge / Channel-2). */
  sendMessage(text: string): void;
  /** Queue model-facing context for the next pre-step without waking the driver. */
  inject(content: unknown): void;
}
