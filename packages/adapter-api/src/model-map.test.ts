import { describe, expect, it } from "bun:test";
import {
  CANONICAL_DEEPSEEK_PROVIDER,
  DSH_DEEPSEEK_PROVIDER,
  dshModelRefToCanonical,
  resolveModelRefForDsh,
} from "./model-map";

describe("DSH model geometry", () => {
  it("maps the official DeepSeek route to the canonical provider prefix", () => {
    expect(dshModelRefToCanonical("deepseek-official/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("maps the canonical form back to the DSH-native route, idempotently", () => {
    expect(resolveModelRefForDsh("deepseek/deepseek-v4-flash")).toBe(
      "deepseek-official/deepseek-v4-flash",
    );
    // Already DSH-native: normalize to canonical, then map back.
    expect(resolveModelRefForDsh("deepseek-official/deepseek-v4-flash")).toBe(
      "deepseek-official/deepseek-v4-flash",
    );
  });

  it("preserves model ids containing additional slashes byte-for-byte", () => {
    expect(dshModelRefToCanonical("deepseek-official/deepseek-reasoner/r1")).toBe(
      "deepseek/deepseek-reasoner/r1",
    );
  });

  it("leaves unmapped providers as identities", () => {
    expect(dshModelRefToCanonical("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
    expect(resolveModelRefForDsh("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
  });

  it("handles prototype-colliding provider names safely", () => {
    expect(dshModelRefToCanonical("constructor/model")).toBe("constructor/model");
  });

  it("exposes the canonical DeepSeek provider constants", () => {
    expect(CANONICAL_DEEPSEEK_PROVIDER).toBe("deepseek");
    expect(DSH_DEEPSEEK_PROVIDER).toBe("deepseek-official");
  });
});
