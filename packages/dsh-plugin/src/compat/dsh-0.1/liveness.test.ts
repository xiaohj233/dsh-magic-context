import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markerPath,
  projectHash,
  removeDshLivenessMarker,
  writeDshLivenessMarker,
} from "./liveness";

describe("dsh liveness marker (migration guard)", () => {
  it("writes an RpcPortFileRecord-shaped marker the core guard parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-marker-"));
    try {
      const path = writeDshLivenessMarker({
        storageDir: dir,
        projectPath: "C:\\work\\proj",
        port: 3170,
        instanceId: "deadbeef",
      });
      expect(existsSync(path)).toBe(true);
      const record = JSON.parse(readFileSync(path, "utf8")) as {
        port: number;
        pid: number;
        started_at: number;
        instance_id?: string;
      };
      expect(record.port).toBe(3170);
      expect(record.pid).toBeGreaterThan(0);
      expect(record.started_at).toBeGreaterThan(0);
      expect(record.instance_id).toMatch(/^dsh:/);
      // The core guard scans `<storageDir>/rpc/<projectHash>/port-<pid>.json`.
      expect(path).toBe(
        join(dir, "rpc", projectHash("C:\\work\\proj"), `port-${record.pid}.json`),
      );
      removeDshLivenessMarker(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives the project hash deterministically (16 hex)", () => {
    const h1 = projectHash("C:\\work\\proj");
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(projectHash("C:\\work\\proj")).toBe(h1);
  });

  it("markerPath composes the exact scan path", () => {
    const p = markerPath({ storageDir: "S", projectPath: "P", pid: 123 });
    expect(p).toBe(join("S", "rpc", projectHash("P"), "port-123.json"));
  });
});
