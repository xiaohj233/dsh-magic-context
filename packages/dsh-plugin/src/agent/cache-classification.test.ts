import { describe, expect, it } from "bun:test";
import {
  classifyPlan,
  compareSurfaces,
  firstDiffIndex,
  hardTriggersFor,
  isHardTrigger,
  messageBytes,
  prefixHash,
  type CacheClass,
} from "./cache-classification";

function text(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function user(textValue: string): { role: "user"; content: { type: "text"; text: string }[] } {
  return { role: "user", content: [text(textValue)] };
}

function assistant(textValue: string): { role: "assistant"; content: { type: "text"; text: string }[] } {
  return { role: "assistant", content: [text(textValue)] };
}

const m0 = user("§1§ <m0 baseline>");
const m1 = user("§2§ <m1 delta>");
const u1 = user("hello");
const a1 = assistant("let me check");
const u2 = user("thanks");

describe("cache classification contract (SOFT+/SOFT/HARD)", () => {
  it("byte-hash: the prefix hash is stable under tail appends", () => {
    const before = [m0, m1, u1, a1];
    const after = [m0, m1, u1, a1, u2];
    // The provider cache key is the prefix: identical up to the old tail.
    expect(prefixHash(before, 4)).toBe(prefixHash(after, 4));
    expect(prefixHash(after, 4)).toBe(prefixHash(before, 4));
  });

  it("ordinary turns: first-diff lands exactly at the old tail (SOFT+)", () => {
    const before = [m0, m1, u1, a1];
    const after = [m0, m1, u1, a1, u2];
    const diff = compareSurfaces(before, after);
    expect(diff.index).toBe(4);
    expect(diff.tailAppend).toBe(true);
    expect(diff.range).toEqual({ start: 4, end: 4 });
    expect(firstDiffIndex(before, after)).toBe(4);
  });

  it("mid-range replacement inside m1: first-diff is within the m1 region (SOFT)", () => {
    const before = [m0, m1, u1, a1, u2];
    const after = [m0, user("§2§ <m1 delta v2>"), u1, a1, u2];
    const diff = compareSurfaces(before, after);
    expect(diff.index).toBe(1);
    expect(diff.tailAppend).toBe(false);
    expect(diff.range).toEqual({ start: 1, end: 1 });
    // classifyPlan: the op is at node 1 (>= m0 end), not hard-triggered → SOFT.
    const plan = [{ start: 1, end: 2, cacheClass: "soft" as CacheClass, reason: "m1_delta" }];
    expect(classifyPlan(plan, 1, 5)).toBe("soft");
  });

  it("baseline replacement is HARD (first-diff crosses into m0)", () => {
    const before = [m0, m1, u1, a1];
    const after = [user("§1§ <m0 v2>"), m1, u1, a1];
    const diff = compareSurfaces(before, after);
    expect(diff.index).toBe(0);
    const plan = [{ start: 0, end: 1, cacheClass: "soft" as CacheClass, reason: "m0_refold" }];
    expect(classifyPlan(plan, 1, 4)).toBe("hard");
  });

  it("HARD is only produced by the enumerated triggers", () => {
    expect(isHardTrigger("model_change")).toBe(true);
    expect(isHardTrigger("system_hash")).toBe(true);
    expect(isHardTrigger("ttl_idle")).toBe(true);
    expect(isHardTrigger("pressure_refold")).toBe(true);
    expect(isHardTrigger("overflow_recovery")).toBe(true);
    expect(isHardTrigger("m1_delta")).toBe(false);
    expect(isHardTrigger("first_render")).toBe(false);
    expect(isHardTrigger("compartment_render_epoch")).toBe(false);
  });

  it("hardTriggersFor enumerates the active triggers from meta signals", () => {
    expect(hardTriggersFor({})).toEqual([]);
    expect(hardTriggersFor({ modelKey: "deepseek/deepseek-chat" })).toEqual(["model-change"]);
    expect(hardTriggersFor({ cacheExpired: true })).toEqual(["ttl-expiry"]);
    expect(
      hardTriggersFor({ modelKey: "x", systemPromptHash: "h", toolSetHash: "t", cacheExpired: true, overflowRecovered: true }),
    ).toEqual(["system-change", "model-change", "tool-change", "ttl-expiry", "overflow-recovery"]);
  });

  it("SOFT never crosses the m1 boundary (first-diff >= m0 end)", () => {
    // Build a scenario where a SOFT-classified plan touches only m1+ nodes.
    const plan = [{ start: 2, end: 3, cacheClass: "soft" as CacheClass, reason: "drop" }];
    expect(classifyPlan(plan, 1, 5)).toBe("soft");
    // And the same op with a HARD reason must escalate.
    expect(classifyPlan([{ start: 2, end: 3, cacheClass: "soft" as CacheClass, reason: "model_change" }], 1, 5)).toBe("hard");
  });

  it("empty plan / no changes classifies SOFT+", () => {
    expect(classifyPlan([], 1, 5)).toBe("soft-plus");
    expect(compareSurfaces([m0, m1], [m0, m1]).index).toBe(-1);
  });

  it("replay invariant: the same change yields the same first-diff every time", () => {
    const before = [m0, m1, u1, a1, u2];
    const after = [m0, m1, u1, a1, u2, assistant("one more")];
    const d1 = compareSurfaces(before, after);
    const d2 = compareSurfaces(before, after);
    expect(d1).toEqual(d2);
  });

  it("message bytes are stable and hash-consistent", () => {
    expect(messageBytes(user("x"))).toBe(JSON.stringify(user("x")));
    expect(prefixHash([m0], 1)).toBe(prefixHash([m0], 1));
    expect(prefixHash([m0, m1], 1)).toBe(prefixHash([m0], 1));
  });
});
