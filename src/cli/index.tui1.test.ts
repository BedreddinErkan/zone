/**
 * TUI.1 routing tests: covers the new entry-point fork in index.ts.
 * These tests set process.argv and call run(), mocking dispatch + tui imports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks (must precede module-level imports that pull in the subjects)
const mockRunHeadless = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunOneShotFromCli = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunTui = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockProcessExit = vi.hoisted(() => vi.fn<[number?], never>(() => { throw new Error("process.exit"); }));

vi.mock("./dispatch.js", () => ({
  runHeadless: mockRunHeadless,
  runOneShotFromCli: mockRunOneShotFromCli,
  runOneShotInner: vi.fn(),
}));

vi.mock("./tui/index.js", () => ({
  runTui: mockRunTui,
}));

// Mocks for subcommand-level deps (avoid side-effects)
vi.mock("../core/runLlmPatchFlow.js", () => ({ runLlmPatchFlow: vi.fn(), isChitchat: () => false, isVagueDeveloperTask: () => false }));
vi.mock("../api/commandApprovals.js", () => ({
  rejectPendingApprovalsForRun: vi.fn(),
  clearTrustedCommandsForRun: vi.fn(),
}));
vi.mock("../llm/revisionApprovals.js", () => ({ rejectPendingRevisionsForRun: vi.fn() }));

import { run } from "./index.js";

const originalArgv = process.argv;
const originalExit = process.exit;
const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "zone"];
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  // @ts-expect-error -- mock process.exit
  process.exit = mockProcessExit;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exit = originalExit;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
});

describe("TUI.1 routing", () => {
  it("zone -c → exits 1 with 'no resumable run found' when no envelope exists", async () => {
    process.argv = ["node", "zone", "-c"];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(run()).rejects.toThrow("process.exit");

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no resumable run found"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
  });

  it("zone -p 'task' → calls runHeadless (headless flag set)", async () => {
    process.argv = ["node", "zone", "-p", "fix the bug"];

    await run();

    expect(mockRunHeadless).toHaveBeenCalledWith("fix the bug", expect.any(Object), { outputFormat: "text" });
  });

  it("zone -p --output-format json 'task' → calls runHeadless with json format", async () => {
    process.argv = ["node", "zone", "-p", "--output-format", "json", "my task"];

    await run();

    expect(mockRunHeadless).toHaveBeenCalledWith("my task", expect.any(Object), { outputFormat: "json" });
  });

  it("zone -p 'multi word query' → joins query words and calls runHeadless", async () => {
    process.argv = ["node", "zone", "-p", "multi", "word", "query"];

    await run();

    expect(mockRunHeadless).toHaveBeenCalledWith("multi word query", expect.any(Object), { outputFormat: "text" });
  });

  it("zone 'fix typo' (interactive TTY) → calls runTui with initialPrompt", async () => {
    process.argv = ["node", "zone", "fix typo"];

    await run();

    expect(mockRunTui).toHaveBeenCalledWith("fix typo", expect.any(Object));
    expect(mockRunHeadless).not.toHaveBeenCalled();
  });

  it("zone (no args, interactive TTY) → calls runTui with no prompt", async () => {
    process.argv = ["node", "zone"];

    await run();

    expect(mockRunTui).toHaveBeenCalledWith(undefined, expect.any(Object));
    expect(mockRunHeadless).not.toHaveBeenCalled();
  });
});
