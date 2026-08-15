import { describe, expect, it, spyOn } from "bun:test";
import {
  buildGuidanceSectionText,
  GUIDANCE_SECTION_NAME,
  GUIDANCE_SECTION_ORDER,
  readSystemPrompt,
  registerSystemGuidance,
  type DshSystemPromptView,
} from "./system-guidance";

describe("agent system-guidance (static Magic Context section)", () => {
  it("builds the v2 guidance-only section text", () => {
    const text = buildGuidanceSectionText({});
    expect(text).toContain("## Magic Context");
    // Guidance only — the volatile/data-bearing blocks live in m[0]/m[1].
    expect(text).not.toContain("<project-docs>");
    expect(text).not.toContain("<user-profile>");
    // memory guidance is gated on memoryEnabled (default true).
    expect(text).toContain("ctx_memory");
    expect(text).toContain("ctx_search");
  });

  it("drops memory guidance when memory is disabled", () => {
    const withMemory = buildGuidanceSectionText({});
    const withoutMemory = buildGuidanceSectionText({ memoryEnabled: false });
    expect(withoutMemory).toContain("## Magic Context");
    expect(withoutMemory).not.toContain("ctx_memory");
    expect(withMemory).toContain("ctx_memory");
  });

  it("is byte-stable across repeated builds (cache-prefix stability)", () => {
    expect(buildGuidanceSectionText({})).toBe(buildGuidanceSectionText({}));
    expect(buildGuidanceSectionText({ protectedTags: 20, memoryEnabled: true })).toBe(
      buildGuidanceSectionText({}),
    );
  });

  it("registers one section with the stable identity and disposes on unload", () => {
    const registry = new Map<string, { order: number; text: string }>();
    const disposers: Array<() => void> = [];
    const sectionSpy = spyOn(
      {
        section: (section: { name: string; order: number; text: string }): (() => void) => {
          registry.set(section.name, { order: section.order, text: section.text });
          const dispose = () => registry.delete(section.name);
          disposers.push(dispose);
          return dispose;
        },
      } satisfies DshSystemPromptView,
      "section",
    );
    const effects: Array<() => unknown> = [];
    const fakeCtx = {
      get: (name: string) => (name === "systemPrompt" ? { section: sectionSpy } : undefined),
      effect: (execute: () => unknown) => effects.push(execute),
    } as unknown as Parameters<typeof registerSystemGuidance>[0];

    registerSystemGuidance(fakeCtx, { log: () => {} });

    expect(sectionSpy).toHaveBeenCalledTimes(1);
    const call = sectionSpy.mock.calls[0]?.[0];
    expect(call?.name).toBe(GUIDANCE_SECTION_NAME);
    expect(call?.order).toBe(GUIDANCE_SECTION_ORDER);
    expect(call?.text).toContain("## Magic Context");
    expect(registry.has(GUIDANCE_SECTION_NAME)).toBe(true);
    expect(readSystemPrompt(fakeCtx)).toBeDefined();

    // Fiber ownership: the effect disposer removes the section. ctx.effect's
    // contract is `execute: () => disposer` — cordis calls the RETURNED
    // disposer on unload, so the test must invoke it the same way.
    expect(effects.length).toBe(1);
    const disposer = (effects[0] as () => () => void)();
    disposer();
    expect(registry.has(GUIDANCE_SECTION_NAME)).toBe(false);
  });

  it("skips registration when guidance is disabled", () => {
    const sectionSpy = spyOn(
      { section: () => () => {} } satisfies DshSystemPromptView,
      "section",
    );
    const fakeCtx = {
      get: (name: string) => (name === "systemPrompt" ? { section: sectionSpy } : undefined),
      effect: () => {},
    } as unknown as Parameters<typeof registerSystemGuidance>[0];
    registerSystemGuidance(fakeCtx, { config: { enabled: false }, log: () => {} });
    expect(sectionSpy).not.toHaveBeenCalled();
  });

  it("skips registration (fail-open) when the systemPrompt service is absent", () => {
    const fakeCtx = {
      get: () => undefined,
      effect: () => {},
    } as unknown as Parameters<typeof registerSystemGuidance>[0];
    expect(() => registerSystemGuidance(fakeCtx, { log: () => {} })).not.toThrow();
  });
});
