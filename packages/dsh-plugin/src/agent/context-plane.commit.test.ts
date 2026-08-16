import { describe, expect, it } from "bun:test";
import { recentCommitClusterCount } from "./context-plane";

function fakeAgent(texts: string[]): never {
  const events = texts.map((text) => ({
    type: "assistant/message",
    data: { content: [{ type: "text", text }] },
  }));
  return { session: { events } } as never;
}

describe("recentCommitClusterCount (lightweight Pi-parity trigger)", () => {
  it("counts contiguous commit-mention bursts, not individual hashes", () => {
    const agent = fakeAgent([
      "let me check the code",
      "fixed it — commit 9f86d081884c7d65",
      "also pushed 5a5b7c1d and 1f2e3d4c5",
      "now the tests pass",
      "release commit 0f5c9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e",
    ]);
    expect(recentCommitClusterCount(agent)).toBe(2);
  });

  it("returns 0 for text without commit hashes", () => {
    const agent = fakeAgent(["hello", "world", "no hashes here"]);
    expect(recentCommitClusterCount(agent)).toBe(0);
  });
});
