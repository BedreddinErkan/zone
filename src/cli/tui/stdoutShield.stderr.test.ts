import { describe, it, expect, vi, afterEach } from "vitest";
import { applyStderrInterception } from "./stdoutShield.js";

// Pattern: install fakeOriginal on process.stderr.write BEFORE applyStderrInterception()
// so the shield captures it as `original`. Then calls through the interceptor hit fakeOriginal.

describe("applyStderrInterception", () => {
  let restore: (() => void) | null = null;
  let fakeOriginal: ReturnType<typeof vi.fn>;

  afterEach(() => {
    restore?.();
    restore = null;
    delete process.env.ZONE_TUI_DEBUG;
    delete process.env.ZONE_VERBOSE_LOGS;
  });

  function setup() {
    fakeOriginal = vi.fn((..._args: unknown[]) => true);
    (process.stderr as unknown as { write: typeof fakeOriginal }).write = fakeOriginal;
    restore = applyStderrInterception();
  }

  it("1. swallows tagged [zone-*] line in normal mode", () => {
    setup();
    process.stderr.write("[zone-plan] skipped (agent_loop): test\n");
    expect(fakeOriginal).not.toHaveBeenCalled();
  });

  it("2. passes through tagged line to original when ZONE_TUI_DEBUG=1", () => {
    process.env.ZONE_TUI_DEBUG = "1";
    setup();
    process.stderr.write("[zone-plan] skipped (agent_loop): test\n");
    expect(fakeOriginal).toHaveBeenCalledOnce();
    expect(String(fakeOriginal.mock.calls[0]![0])).toContain("[zone-plan]");
  });

  it("3. passes through untagged line in normal mode", () => {
    setup();
    process.stderr.write("Error: boom\n    at Object.<anonymous> (foo.ts:1:1)\n");
    expect(fakeOriginal).toHaveBeenCalledOnce();
  });
});
