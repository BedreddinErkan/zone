import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  start,
  read,
  killAllForRun,
  _resetForTests,
} from "./backgroundProcessRegistry.js";

// First real vitest coverage for this module — src/tools/__tests__/runBackgroundProcessManual.ts
// is a standalone spawn-and-poll script (node --experimental-strip-types), not picked up by
// vitest's .test.ts glob, and its own offset coverage never passes a negative value. The module
// offers no seam to construct a process state without a real start() call, so these tests spawn
// a real, tiny, deterministic child process rather than mocking one.

const CWD = "/tmp";
const RUN_ID = "bg-registry-since-offset-test";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Bounded and throwing, not a silent false — a hang here must produce a named failure
// ("fixture never reached eof") rather than surfacing as vitest's own generic hook-timeout
// message on an unrelated-looking line. 3000ms is comfortably under both vitest's built-in
// hookTimeout default (10000ms, unset in this repo's vitest.config.ts) and this beforeAll's
// own explicit override below.
async function waitForEof(handle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = read({ runId: RUN_ID, handle, sinceOffset: null, maxBytes: 64 });
    if (probe.success && probe.eof) return;
    await delay(20);
  }
  throw new Error(
    `background fixture process did not reach eof within ${timeoutMs}ms (runId=${RUN_ID}, handle=${handle})`
  );
}

describe("backgroundProcessRegistry.read — since_offset boundary handling", () => {
  let handle: string;

  // One real spawned process, shared by every test below. read() is a pure query — verified
  // against the real function body, not the type signature: it only reads proc.ringWritten,
  // proc.ringBuffer, proc.eof, and proc.exitCode, and assigns to none of them anywhere in its
  // body — so reading the same settled process repeatedly, in any order, is safe and does not
  // make test order load-bearing.
  beforeAll(async () => {
    const s = start({ runId: RUN_ID, command: 'printf "ABCDEFGHIJ"', cwd: CWD });
    if (!s.success) {
      throw new Error(`failed to start background fixture process: ${s.error}`);
    }
    handle = s.handle;
    await waitForEof(handle, 3000);
  }, 8000);

  afterAll(async () => {
    await killAllForRun(RUN_ID);
    _resetForTests();
  });

  it("a negative since_offset returns the available data instead of silently returning empty", () => {
    const result = read({ runId: RUN_ID, handle, sinceOffset: -5, maxBytes: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output).toBe("ABCDEFGHIJ");
    expect(result.truncated).toBe(true);
    expect(result.newOffset).toBe(10);
  });

  it("since_offset: 0 — control, must not regress", () => {
    const result = read({ runId: RUN_ID, handle, sinceOffset: 0, maxBytes: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output).toBe("ABCDEFGHIJ");
    expect(result.truncated).toBe(false);
    expect(result.newOffset).toBe(10);
  });

  it("since_offset past the end of available data returns empty correctly — not a defect", () => {
    const result = read({ runId: RUN_ID, handle, sinceOffset: 999999, maxBytes: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.newOffset).toBe(10);
  });
});
