import { describe, expect, it } from "bun:test";
import {
  canonicalSessionKey,
  currentHarness,
  parseDshSessionKey,
  setDshHarness,
  DSH_HARNESS,
} from "./harness";

describe("harness identity boundary", () => {
  it("locks the harness to 'dsh'", () => {
    setDshHarness();
    expect(currentHarness()).toBe("dsh");
  });

  it("is idempotent when already locked to dsh", () => {
    setDshHarness();
    setDshHarness();
    expect(currentHarness()).toBe("dsh");
  });

  it("DSH_HARNESS is the exact runtime string", () => {
    expect(DSH_HARNESS).toBe("dsh");
  });
});

describe("canonical session key", () => {
  it("derives an invertible canonical key", () => {
    const key = canonicalSessionKey("a1b2c3d4", "session-abc-123");
    expect(key).toBe("dsh:a1b2c3d4:session-abc-123");
    expect(parseDshSessionKey(key)).toEqual({
      homeHash: "a1b2c3d4",
      dshSessionId: "session-abc-123",
    });
  });

  it("rejects empty segments", () => {
    expect(() => canonicalSessionKey("", "s")).toThrow();
    expect(() => canonicalSessionKey("h", "")).toThrow();
  });

  it("rejects a dsh session id containing the separator", () => {
    expect(() => canonicalSessionKey("h", "a:b")).toThrow();
  });

  it("returns undefined for non-DSH keys and malformed shapes", () => {
    expect(parseDshSessionKey("opencode-session")).toBeUndefined();
    expect(parseDshSessionKey("dsh:onlyone")).toBeUndefined();
    expect(parseDshSessionKey("dsh::tail")).toBeUndefined();
    expect(parseDshSessionKey("dsh:head:")).toBeUndefined();
    expect(parseDshSessionKey(undefined as unknown as string)).toBeUndefined();
  });

  it("round-trips DSH session ids that themselves contain no colon", () => {
    const dshSessionId = "session-d52f303c-8b76-499b-9217-5cf176d80b4c";
    const key = canonicalSessionKey("a1b2c3d4", dshSessionId);
    expect(parseDshSessionKey(key)?.dshSessionId).toBe(dshSessionId);
  });
});
