/**
 * agent/system-guidance — the static Magic Context guidance section (Phase 2
 * slice A).
 *
 * Registers ONE byte-stable `## Magic Context` prompt section through the DSH
 * `systemPrompt.section()` seam (dsh-reference §B.8). The text is produced by
 * the core `buildMagicContextSection` (agents/magic-context-prompt) exactly
 * like the Pi adapter's `buildMagicContextBlock` (pi-plugin/system-prompt.ts):
 * v2 guidance ONLY — project docs / user profile / memories live in the m[0]
 * baseline, never in the system prompt. Static content keeps the provider-side
 * prefix cache stable (section order/name fixed; text recomputed once at
 * registration).
 *
 * The `systemPrompt` service is OPTIONAL here (not in `inject`): the section is
 * skipped with a log line when the service is absent. The DSH service type is
 * accessed through a structural view because `@deepseek-ai/dsh-system-prompt`
 * is not part of this package's dependency set yet — the compat seam keeps the
 * vocabulary isolated when it joins.
 */
import type { Context } from "@deepseek-ai/cordis";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import type { ConfigHarness } from "@magic-context/core/config/migrate-config-location";
import { DSH_HARNESS } from "@xiao_hj909/magic-context-for-dsh-adapter";

/** Stable section identity (B.8: unique name, order asc, 300 = after tool guidance). */
export const GUIDANCE_SECTION_NAME = "magic-context:guidance";
export const GUIDANCE_SECTION_ORDER = 300;

/** Guidance options surfaced in the agent plugin config. */
export interface GuidanceConfig {
  enabled?: boolean;
  /** Workspace directory for prompt-surface config resolution. */
  directory?: string;
  protectedTags?: number;
  ctxReduceCallable?: boolean;
  dreamerEnabled?: boolean;
  temporalAwarenessEnabled?: boolean;
  cavemanTextCompressionEnabled?: boolean;
  memoryEnabled?: boolean;
  language?: string;
  /** prompt_surface config (default/full, guidance_override_path, ...). */
  promptSurface?: PromptSurfaceConfig;
}

export interface SystemGuidanceDeps {
  readonly config?: GuidanceConfig;
  readonly log?: (message: string) => void;
}

/**
 * Structural view of `ctx.systemPrompt` (dsh-system-prompt §B.8) — only the
 * member this slice consumes. Kept minimal so the package can typecheck before
 * the DSH service package joins the dependency set.
 */
export interface DshSystemPromptView {
  section(section: {
    name: string;
    order: number;
    text: string | ((ctx: unknown) => string);
    complete?: boolean;
  }): () => void;
}

export function readSystemPrompt(ctx: Context): DshSystemPromptView | undefined {
  // ctx.get() — never a property read: cordis throws on undeclared property
  // access, and this service is intentionally OPTIONAL (not in `inject`).
  return ctx.get("systemPrompt") as DshSystemPromptView | undefined;
}

/**
 * Build the static guidance text (pure; tested directly). `compactionOff`
 * knowledge mode: guidance only — never emits <project-docs>/<user-profile>.
 */
export function buildGuidanceSectionText(config: GuidanceConfig): string {
  return buildMagicContextSection(
    null,
    config.protectedTags ?? 20,
    config.ctxReduceCallable ?? true,
    config.dreamerEnabled ?? false,
    config.temporalAwarenessEnabled ?? false,
    config.cavemanTextCompressionEnabled ?? false,
    false,
    config.language,
    config.memoryEnabled ?? true,
    // Model-independent preset (registration-time static text; per-model epochs
    // land with the tool-registration phase).
    config.promptSurface?.default ?? "full",
    undefined,
  );
}

/** Resolve the prompt-surface preset, when a runtime can be created (best-effort). */
export function resolveGuidancePreset(
  config: GuidanceConfig,
): { preset: string; primaryOverride?: string } | null {
  try {
    const runtime = createPromptSurfaceRuntime({
      harness: DSH_HARNESS as unknown as ConfigHarness,
      directory: config.directory,
      warn: () => {},
    });
    const selection = runtime.resolveGuidance(config.promptSurface, undefined);
    return { preset: selection.preset, primaryOverride: selection.primaryOverride };
  } catch {
    return null;
  }
}

/**
 * Register the static guidance section on the system prompt (fiber-owned via
 * the section disposer; skipped fail-open when the service is absent).
 */
export function registerSystemGuidance(ctx: Context, deps: SystemGuidanceDeps = {}): void {
  if (deps.config?.enabled === false) return;
  const systemPrompt = readSystemPrompt(ctx);
  if (!systemPrompt) {
    deps.log?.("[magic-context] systemPrompt service unavailable; guidance section skipped");
    return;
  }
  const text = buildGuidanceSectionText(deps.config ?? {});
  if (text.length === 0) return;
  const dispose = systemPrompt.section({
    name: GUIDANCE_SECTION_NAME,
    order: GUIDANCE_SECTION_ORDER,
    text,
  });
  // Fiber ownership: the section is removed when the plugin unloads.
  ctx.effect(() => dispose);
}
