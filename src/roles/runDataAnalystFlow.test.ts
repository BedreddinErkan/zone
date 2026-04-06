import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

const scanRepoMock = vi.fn();
const readProjectFilesMock = vi.fn();
const createMock = vi.fn();
const getModelNameMock = vi.fn();
const validateTestOutputMock = vi.fn();
const buildDataAnalystContextMock = vi.fn();
const detectDataSchemaMock = vi.fn();
const buildDataAnalystPromptMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createMock,
  getModelName: getModelNameMock,
}));

vi.mock("./testOutputValidator.js", () => ({
  validateTestOutput: validateTestOutputMock,
}));

vi.mock("./dataAnalystContext.js", () => ({
  buildDataAnalystContext: buildDataAnalystContextMock,
}));

vi.mock("./detectDataSchema.js", () => ({
  detectDataSchema: detectDataSchemaMock,
}));

vi.mock("../prompts/dataAnalystPrompt.js", () => ({
  buildDataAnalystPrompt: buildDataAnalystPromptMock,
}));

function buildRepoFile(path: string): RepoFile {
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension: path.split(".").pop() ?? "",
    category: "unknown",
  };
}

describe("runDataAnalystFlow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    validateTestOutputMock.mockReturnValue({
      decision: "pass",
      issues: [],
      summary: "Validation passed",
    });
  });

  it("returns fileDiffs for generated migration patches", async () => {
    const files = [buildRepoFile("db/migration/V3__orders.sql")];
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            summary: "Creates orders table",
            warnings: [],
            confidence: 90,
            migrationFile: {
              path: "db/migration/V3__orders.sql",
              content:
                "CREATE TABLE IF NOT EXISTS orders (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL\n);",
            },
          }),
        }),
      },
    };

    scanRepoMock.mockResolvedValue(files);
    detectDataSchemaMock.mockReturnValue({
      dialect: "postgresql",
      migrationFormat: "flyway",
    });
    buildDataAnalystContextMock.mockReturnValue({
      existingSqlFiles: files,
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/db/migration/V3__orders.sql":
        "CREATE TABLE IF NOT EXISTS orders (\n  id SERIAL PRIMARY KEY\n);",
    });
    buildDataAnalystPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");

    const { runDataAnalystFlow } = await import("./runDataAnalystFlow.js");
    const result = await runDataAnalystFlow({
      task: "add email to orders table",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          filePath: "db/migration/V3__orders.sql",
          addedLines: 2,
          removedLines: 1,
          diff: expect.arrayContaining([
            expect.objectContaining({
              type: "added",
              content: "  email TEXT NOT NULL",
            }),
          ]),
        }),
      ]);
    }
  });
});
