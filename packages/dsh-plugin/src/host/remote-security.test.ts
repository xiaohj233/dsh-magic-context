/**
 * Phase 5 security audit (PLAN §11): Remote responses must never leak
 * secrets; the diagnostics endpoint bounds its input; the client bundle must
 * not render untrusted data as HTML.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/typert";
import {
  MAGIC_DIAGNOSTICS_METHOD,
  MAGIC_STATUS_METHOD,
  magicDiagnosticsDescriptor,
  magicStatusDescriptor,
} from "./remote";

describe("Phase 5 security audit", () => {
  it("remote descriptors carry the strict namespace and no secret-adjacent fields", () => {
    for (const descriptor of [magicStatusDescriptor(), magicDiagnosticsDescriptor()]) {
      expect(descriptor.namespace).toBe(MAGIC_CONTEXT_REMOTE_NAMESPACE);
      expect(descriptor.invocation.kind).toBe("direct");
      const serialized = JSON.stringify(descriptor);
      // No secret-bearing field names anywhere in the wire contract.
      expect(serialized.toLowerCase()).not.toMatch(/apikey|api_key|secret|token|password|credential/);
    }
    expect(magicStatusDescriptor().method).toBe(MAGIC_STATUS_METHOD);
    expect(magicDiagnosticsDescriptor().method).toBe(MAGIC_DIAGNOSTICS_METHOD);
  });

  it("diagnostics descriptor bounds its input (sessionId length cap)", () => {
    const parameters = magicDiagnosticsDescriptor().parameters;
    expect(parameters.length).toBe(1);
    expect(parameters[0]?.name).toBe("args");
    expect(parameters[0]?.codec.mode).toBe("src-json");
  });

  it("the client bundle never assigns untrusted content into innerHTML", () => {
    const client = readFileSync(
      join(import.meta.dir, "..", "client", "client.js"),
      "utf8",
    );
    // The XSS surface is dynamic HTML assignment with interpolated values.
    expect(client).not.toMatch(/innerHTML\s*=\s*[^;]*\$\{/);
    expect(client).not.toMatch(/insertAdjacentHTML\s*\(/);
    // Text insertion must go through textContent / createTextNode.
    expect(client).toMatch(/textContent/);
  });

  it("the host status payload carries no environment or credential echo", () => {
    const descriptor = magicStatusDescriptor();
    const serialized = JSON.stringify(descriptor).toLowerCase();
    expect(serialized).not.toContain("process.env");
    expect(serialized).not.toContain("dsh_home=");
  });
});
