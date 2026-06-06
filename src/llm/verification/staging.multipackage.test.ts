import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockExecAsync = vi.hoisted(() => vi.fn());

vi.mock("./command.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./command.js")>();
  return { ...mod, execAsync_verify: mockExecAsync };
});

import { runStagingVerification } from "./staging.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-staging-mp-"));
  mockExecAsync.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function write(rel: string, content = ""): string {
  const abs = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function tscFail(errorLine: string) {
  return Object.assign(new Error("tsc error"), {
    code: 1,
    stdout: errorLine,
    stderr: "",
  });
}

describe("runStagingVerification — multi-package routing", () => {
  it("runs tsc per tsconfig when staged files span two packages (both pass)", async () => {
    write("apps/web/tsconfig.json", "{}");
    write("packages/db/tsconfig.json", "{}");
    const a = write("apps/web/src/a.ts", "export const x = 1;");
    const b = write("packages/db/src/b.ts", "export const y = 2;");

    const result = await runStagingVerification({
      stagingFiles: new Map([[a, "export const x = 1;"], [b, "export const y = 2;"]]),
      repoPath,
      framework: { language: "typescript" },
      withStagingTempFlush: async (_s, body) => body(),
    });

    expect(result.status).toBe("pass");
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
    const cmds: string[] = mockExecAsync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(cmds.some((cmd) => cmd.includes("apps/web/tsconfig.json"))).toBe(true);
    expect(cmds.some((cmd) => cmd.includes("packages/db/tsconfig.json"))).toBe(true);
  });

  it("returns fail+regressed when one package has a regression, the other passes", async () => {
    write("apps/web/tsconfig.json", "{}");
    write("packages/db/tsconfig.json", "{}");
    const a = write("apps/web/src/a.ts", "x");
    const b = write("packages/db/src/b.ts", "x");

    // staged: apps/web fails with a regression; baseline passes → regressed=true
    // staged: packages/db passes
    mockExecAsync
      .mockRejectedValueOnce(tscFail("apps/web/src/a.ts(1,1): error TS1234: Broken."))
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // baseline for apps/web → pass
      .mockResolvedValue({ stdout: "", stderr: "" });    // packages/db staged + baseline

    const result = await runStagingVerification({
      stagingFiles: new Map([[a, "x"], [b, "x"]]),
      repoPath,
      framework: { language: "typescript" },
      withStagingTempFlush: async (_s, body) => body(),
    });

    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.regressed).toBe(true);
      expect(result.postErrorCount).toBeGreaterThan(0);
      expect(result.errorPreview).toMatch(/TS1234/);
    }
  });

  it("returns fail+not-regressed when errors are pre-existing across both packages", async () => {
    write("apps/web/tsconfig.json", "{}");
    write("packages/db/tsconfig.json", "{}");
    const a = write("apps/web/src/a.ts", "x");
    const b = write("packages/db/src/b.ts", "x");
    const errLine = "src/a.ts(1,1): error TS9999: Pre-existing.";

    // staged: web fails (1 error); baseline: web fails same (1 error) → not regressed
    // staged: db fails (1 error); baseline: db fails same (1 error) → not regressed
    mockExecAsync
      .mockRejectedValueOnce(tscFail(errLine))         // web staged
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 1, stdout: errLine, stderr: "" })) // web baseline
      .mockRejectedValueOnce(tscFail(errLine))         // db staged
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 1, stdout: errLine, stderr: "" })); // db baseline

    const result = await runStagingVerification({
      stagingFiles: new Map([[a, "x"], [b, "x"]]),
      repoPath,
      framework: { language: "typescript" },
      withStagingTempFlush: async (_s, body) => body(),
    });

    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.regressed).toBe(false);
    }
  });

  it("falls through to single-command path when only one tsconfig is found", async () => {
    write("apps/web/tsconfig.json", "{}");
    const a = write("apps/web/src/a.ts", "x");
    const b = write("apps/web/src/b.ts", "x"); // same package

    await runStagingVerification({
      stagingFiles: new Map([[a, "x"], [b, "x"]]),
      repoPath,
      framework: { language: "typescript" },
      withStagingTempFlush: async (_s, body) => body(),
    });

    // single-command path: called exactly once
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
    const cmd = mockExecAsync.mock.calls[0][0] as string;
    expect(cmd).toContain("apps/web/tsconfig.json");
  });
});
