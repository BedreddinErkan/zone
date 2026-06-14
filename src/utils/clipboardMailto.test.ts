import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

// Import after mocking
const { copyToClipboard, openMailtoFeedback } = await import("./clipboardMailto.js");

function makeSpawnMock(): { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; on: ReturnType<typeof vi.fn> } {
  return {
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
  };
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExecFile.mockReset();
  });

  it("uses pbcopy on darwin", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const proc = makeSpawnMock();
    mockSpawn.mockReturnValue(proc);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawn).toHaveBeenCalledWith("pbcopy", [], expect.any(Object));
    expect(proc.stdin.write).toHaveBeenCalledWith("hello");
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("uses clip on win32", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const proc = makeSpawnMock();
    mockSpawn.mockReturnValue(proc);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawn).toHaveBeenCalledWith("clip", [], expect.any(Object));
  });

  it("tries wl-copy first on linux", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const proc = makeSpawnMock();
    mockSpawn.mockReturnValue(proc);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawn).toHaveBeenCalledWith("wl-copy", [], expect.any(Object));
  });

  it("falls through to xclip on linux when wl-copy is ENOENT", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const proc = makeSpawnMock();
    mockSpawn.mockReturnValue(proc);
    copyToClipboard("hello");
    // Simulate ENOENT error callback from wl-copy
    const onCall = proc.on.mock.calls.find(([evt]: [string]) => evt === "error");
    if (onCall) {
      const handler = onCall[1] as (err: NodeJS.ErrnoException) => void;
      const xclipProc = makeSpawnMock();
      mockSpawn.mockReturnValue(xclipProc);
      handler(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      expect(mockSpawn).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], expect.any(Object));
    }
  });

  it("never throws even if spawn throws", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    mockSpawn.mockImplementation(() => { throw new Error("spawn failed"); });
    expect(() => copyToClipboard("hello")).not.toThrow();
  });
});

describe("openMailtoFeedback", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
  });

  it("calls execFile with a mailto URL", () => {
    openMailtoFeedback("Zone feedback", "my message");
    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0] as [string, string[]];
    const url = args[1].find((a) => a.startsWith("mailto:"));
    expect(url).toContain("mailto:feedback@zonecli.dev");
    expect(url).toContain("subject=");
    expect(url).toContain("body=");
  });

  it("caps body at 1800 chars", () => {
    const longBody = "x".repeat(2000);
    openMailtoFeedback("subj", longBody);
    const args = mockExecFile.mock.calls[0] as [string, string[]];
    const url = args[1].find((a) => a.startsWith("mailto:")) ?? "";
    const bodyParam = new URLSearchParams(url.split("?")[1] ?? "").get("body") ?? "";
    expect(bodyParam.length).toBeLessThanOrEqual(1801); // 1800 chars + ellipsis char
  });

  it("never throws even if execFile throws", () => {
    mockExecFile.mockImplementation(() => { throw new Error("execFile failed"); });
    expect(() => openMailtoFeedback("subj", "body")).not.toThrow();
  });
});
