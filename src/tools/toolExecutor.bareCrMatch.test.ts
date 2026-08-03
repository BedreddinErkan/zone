/**
 * Ledger item 41 — apply_patch's search target normalized CRLF only while the FIND normalized
 * both CRLF and bare CR, so a bare-CR file's FIND was always normalized past what it was being
 * searched against and the match was guaranteed to fail. Fixed by normalizing the search target
 * for bare CR too, and by teaching detectLineEnding/analyzeLineEnding (item 42) a "cr" ending so
 * the output re-encode can restore it. Fixtures use .md, not .js/.ts — a bare \r inside a JS
 * string literal is an unterminated-string parse error caught by the pre-flight syntax check
 * before ever reaching the normalization mismatch this suite is testing (found the hard way
 * during the establish, and corrected there before any test was written).
 *
 * The last test mocks debugLog to observe detectLineEnding's own return value directly — a
 * mutation-testing finding, not a stylistic choice. `dominant` (what every re-encode branch in
 * this file actually reads) is computed from raw counts, never from detectLineEnding's return;
 * `detected` has exactly one consumer anywhere, originalEol, which feeds only item 21's
 * debugLog telemetry. No behavioral assertion above can distinguish detectLineEnding returning
 * "cr" from a mutant that always returns "lf" — only reading the telemetry payload directly can,
 * which is why this file needs both styles rather than just the behavioral one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDebugLog = vi.hoisted(() => vi.fn());
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, debugLog: mockDebugLog };
});

import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function applyPatch(filePath: string, find: string, replace: string) {
  const patch = `--- FIND ---\n${find}\n--- REPLACE ---\n${replace}`;
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    {}
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-bare-cr-match-"));
  mockDebugLog.mockClear();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch bare-CR line-ending match and re-encode (ledger item 41)", () => {
  it("pure bare-CR file, FIND spans a CR: matches, output stays uniformly CR", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "line one\rline two\rline three\rline four\r");

    const result = await applyPatch(filePath, "line two\rline three", "NEW A\nNEW B");

    expect(result.success).toBe(true);
    const after = fs.readFileSync(path.join(repoPath, filePath), "utf8");
    expect(after).toBe("line one\rNEW A\rNEW B\rline four\r");
  });

  it("pure CRLF file (control): matches, output stays uniformly CRLF", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "alpha\r\nbeta\r\ngamma\r\ndelta\r\n");

    const result = await applyPatch(filePath, "beta\r\ngamma", "NEW A\nNEW B");

    expect(result.success).toBe(true);
    const after = fs.readFileSync(path.join(repoPath, filePath), "utf8");
    expect(after).toBe("alpha\r\nNEW A\r\nNEW B\r\ndelta\r\n");
  });

  it("pure LF file (control): matches, output stays uniformly LF", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const result = await applyPatch(filePath, "beta\ngamma", "NEW A\nNEW B");

    expect(result.success).toBe(true);
    const after = fs.readFileSync(path.join(repoPath, filePath), "utf8");
    expect(after).toBe("alpha\nNEW A\nNEW B\ndelta\n");
  });

  it("mostly-LF file with one stray bare CR, FIND on a clean line: matches, minority CR flattened to dominant LF", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "# Title\n\nold\rvalue paragraph\n\nUnrelated clean line\n");

    const result = await applyPatch(filePath, "Unrelated clean line", "PATCHED");

    expect(result.success).toBe(true);
    const after = fs.readFileSync(path.join(repoPath, filePath), "utf8");
    expect(after).toBe("# Title\n\nold\nvalue paragraph\n\nPATCHED\n");
  });

  it("pure bare-CR file: detectLineEnding classifies it as \"cr\", not \"lf\" (mutation-testing finding)", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "line one\rline two\r");

    await applyPatch(filePath, "line one", "NEW A");

    const call = mockDebugLog.mock.calls.find((c) => c[0] === "[zone-apply-patch-eol]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.originalEol).toBe("cr");
  });
});
