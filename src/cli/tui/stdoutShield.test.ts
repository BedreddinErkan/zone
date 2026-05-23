import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyStdoutInterception } from "./stdoutShield.js";

describe("stdoutShield", () => {
  let originalWrite: typeof process.stdout.write;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    delete process.env.ZONE_TUI_DEBUG;
  });

  afterEach(() => {
    restore?.();
    restore = null;
    process.stdout.write = originalWrite;
    delete process.env.ZONE_TUI_DEBUG;
  });

  it("swallows [zone-r2-shim] telemetry line", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    const result = process.stdout.write("[zone-r2-shim] {\"iter\":1}\n");
    expect(result).toBe(true);
    expect(written).toHaveLength(0); // swallowed — original not called
  });

  it("swallows [agent_loop] telemetry line", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write("[agent_loop] Iteration 1/5\n");
    expect(written).toHaveLength(0);
  });

  it("passes through non-telemetry lines", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write("regular output line\n");
    expect(written).toContain("regular output line\n");
  });

  it("with ZONE_TUI_DEBUG=1, routes telemetry to stderr instead of swallowing", () => {
    process.env.ZONE_TUI_DEBUG = "1";
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = vi.fn((chunk: unknown) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    restore = applyStdoutInterception();

    try {
      process.stdout.write("[zone-archetype] {\"tier\":\"simple\"}\n");
      expect(stdoutWrites).toHaveLength(0); // not written to stdout
      expect(stderrWrites).toContain("[zone-archetype] {\"tier\":\"simple\"}\n"); // routed to stderr
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("swallows dispatch.ts ✓ result line (ANSI-prefixed)", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write("\n\x1b[32m✓\x1b[0m patching mode\n");
    expect(written).toHaveLength(0);
  });

  it("restore fn lets telemetry pass through again after restore", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    // While shield is active: swallowed
    process.stdout.write("[zone-test] should be swallowed\n");
    expect(written).toHaveLength(0);

    // After restore: passes through
    restore();
    restore = null;
    process.stdout.write("[zone-test] should pass through now\n");
    expect(written).toContain("[zone-test] should pass through now\n");
  });
});
