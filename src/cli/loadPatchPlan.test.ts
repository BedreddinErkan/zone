import { describe, expect, it, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync
}));

describe("loadPatchPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("valid patch plan yükler", async () => {
    const validPlan = {
      patches: [
        {
          filePath: "src/file.ts",
          nextContent: "export const x = 1;"
        }
      ]
    };

    mockReadFileSync.mockReturnValue(JSON.stringify(validPlan));

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    const result = loadPatchPlan("./plan.json");

    expect(result).toEqual(validPlan);
  });

  it("dosya okunamazsa throw eder", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./missing.json")).toThrow(
      "Failed to read patch plan"
    );
  });

  it("invalid JSON ise throw eder", async () => {
    mockReadFileSync.mockReturnValue("{ invalid json }");

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      "Failed to parse patch plan JSON"
    );
  });

  it("patches yoksa throw eder", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      'Patch plan must include a "patches" array.'
    );
  });

  it("patch array değilse throw eder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ patches: "not-array" })
    );

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow();
  });

  it("patch object değilse throw eder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ patches: ["invalid"] })
    );

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      "must be an object"
    );
  });

  it("filePath yoksa throw eder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        patches: [{ nextContent: "x" }]
      })
    );

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      "filePath"
    );
  });

  it("nextContent yoksa throw eder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        patches: [{ filePath: "a.ts" }]
      })
    );

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      "nextContent"
    );
  });

  it("filePath boş string ise throw eder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        patches: [{ filePath: "", nextContent: "x" }]
      })
    );

    const { loadPatchPlan } = await import("./loadPatchPlan.js");

    expect(() => loadPatchPlan("./plan.json")).toThrow(
      "filePath"
    );
  });
});