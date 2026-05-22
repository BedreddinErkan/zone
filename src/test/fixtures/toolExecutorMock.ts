/// <reference types="vitest" />
import { vi } from "vitest";
import type { Mock } from "vitest";

export type ToolExecutorMockTier = "minimal" | "realistic" | "integration";

export interface ToolExecutorMock {
  executeTool: Mock;
  withStagingTempFlush: Mock;
  clearCommandCacheForRun: Mock;
  clearCommandCacheForTest: Mock;
  clearOutlineCacheForTest: Mock;
  isMemoizableCommand: Mock;
  computeCommandFingerprint: Mock;
  truncateCommandOutput: Mock;
  resolveAgentPath: Mock;
  resolveRunCommandCwd: Mock;
}

export interface BuildToolExecutorMockOpts {
  tier?: ToolExecutorMockTier;
}

// Binds the construction-time tier to each mock instance without polluting
// ToolExecutorMock's shape (which must stay shape-compatible with the
// toolExecutor module export contract for the vi.mock factory).
const _tierRegistry = new WeakMap<ToolExecutorMock, ToolExecutorMockTier>();

export function buildToolExecutorMock(opts?: BuildToolExecutorMockOpts): ToolExecutorMock {
  const tier = opts?.tier ?? "minimal";
  const mock: ToolExecutorMock = {
    executeTool: vi.fn(),
    withStagingTempFlush: vi.fn(),
    clearCommandCacheForRun: vi.fn(),
    clearCommandCacheForTest: vi.fn(),
    clearOutlineCacheForTest: vi.fn(),
    isMemoizableCommand: vi.fn(),
    computeCommandFingerprint: vi.fn(),
    truncateCommandOutput: vi.fn(),
    resolveAgentPath: vi.fn(),
    resolveRunCommandCwd: vi.fn(),
  };
  _tierRegistry.set(mock, tier);
  _applyTierDefaults(mock, tier);
  return mock;
}

export function resetToolExecutorMock(mock: ToolExecutorMock): void {
  for (const fn of Object.values(mock)) fn.mockReset();
  _applyTierDefaults(mock, _tierRegistry.get(mock) ?? "minimal");
}

function _applyTierDefaults(mock: ToolExecutorMock, tier: ToolExecutorMockTier): void {
  // minimal defaults — every test file relies on these three
  mock.withStagingTempFlush.mockImplementation(
    async (_staging: unknown, fn: () => unknown) => fn(),
  );
  mock.clearCommandCacheForRun.mockReturnValue(undefined);
  mock.clearCommandCacheForTest.mockReturnValue(undefined);
  mock.clearOutlineCacheForTest.mockReturnValue(undefined);
  mock.executeTool.mockResolvedValue({ success: true, output: "ok" });

  if (tier === "realistic" || tier === "integration") {
    mock.isMemoizableCommand.mockReturnValue(false);
    mock.computeCommandFingerprint.mockReturnValue("fingerprint-stub");
    mock.truncateCommandOutput.mockImplementation((s: string) => ({
      truncated: s,
      wasTruncated: false,
      originalLineCount: s.split("\n").length,
    }));
    mock.resolveAgentPath.mockImplementation((rawPath: string) => rawPath);
    mock.resolveRunCommandCwd.mockImplementation(
      (_: unknown, repoPath: string) => ({ ok: true, cwd: repoPath }),
    );
  }

  if (tier === "integration") {
    mock.executeTool.mockResolvedValue({
      success: true,
      output: "ok",
      exitCode: 0,
      truncated: false,
      contentLength: 2,
    });
  }
}
