import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const runAgentMock = vi.fn();
const runLlmPatchFlowMock = vi.fn();
const applyLlmPatchesMock = vi.fn();
const runTestEngineerFlowMock = vi.fn();
const runDataAnalystFlowMock = vi.fn();

vi.mock("../core/runAgent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: runLlmPatchFlowMock,
}));

vi.mock("../core/applyLlmPatches.js", () => ({
  applyLlmPatches: applyLlmPatchesMock,
}));

vi.mock("../roles/runTestEngineerFlow.js", () => ({
  runTestEngineerFlow: runTestEngineerFlowMock,
}));

vi.mock("../roles/runDataAnalystFlow.js", () => ({
  runDataAnalystFlow: runDataAnalystFlowMock,
}));

describe("/api/test-engineer", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.VITEST = "true";
    const { app } = await import("./server.js");
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns complexity from the test engineer flow", async () => {
    runTestEngineerFlowMock.mockResolvedValue({
      ok: true,
      framework: "playwright_ts",
      language: "typescript",
      confidence: 82,
      summary: "Generated test",
      warnings: [],
      complexity: "data_driven",
      applyPatches: [],
      preview: "preview",
    });

    const response = await fetch(`${baseUrl}/api/test-engineer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "Write a data driven login test for multiple users",
        repoPath: "C:/repo",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.complexity).toBe("data_driven");
  });

  it("returns the expected successful shape for /api/data-analyst", async () => {
    runDataAnalystFlowMock.mockResolvedValue({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 90,
      summary: "Creates orders table",
      warnings: ["Existing index naming differs from default convention."],
      applyPatches: [
        {
          filePath: "db/migration/V3__orders.sql",
          fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
        },
      ],
      preview: "=== DATA ANALYST PREVIEW ===\nDialect: postgresql",
    });

    const response = await fetch(`${baseUrl}/api/data-analyst`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "create orders table",
        repoPath: "C:/repo/zone-flyway-test",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dialect: "postgresql",
      migrationFormat: "flyway",
      confidence: 90,
      summary: "Creates orders table",
      warnings: ["Existing index naming differs from default convention."],
    });
    expect(body.applyPatches).toHaveLength(1);
    expect(body.applyPatches[0].filePath).toBe("db/migration/V3__orders.sql");
  });

  it("returns contextFiles from the developer patch flow", async () => {
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Update login flow",
      warnings: [],
      contextFiles: [
        "src/components/LoginForm.tsx",
        "server/routes/auth.ts",
      ],
      applyPatches: [
        {
          filePath: "src/components/LoginForm.tsx",
          fullContent: "export function LoginForm() {}",
        },
      ],
    });

    const response = await fetch(`${baseUrl}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "fix login form auth bug",
        repoPath: "C:/repo",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.contextFiles).toEqual([
      "src/components/LoginForm.tsx",
      "server/routes/auth.ts",
    ]);
  });

  it("returns fileDiffs from /api/dry-run", async () => {
    runLlmPatchFlowMock.mockResolvedValue({
      ok: true,
      patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Dry run",
      warnings: [],
      patchResults: [
        { filePath: "src/foo.ts", status: "applied" },
      ],
      fileDiffs: [
        {
          filePath: "src/foo.ts",
          before: "export const foo = 1;",
          after: "export const foo = 2;",
          diff: [
            { type: "removed", content: "export const foo = 1;", lineNumber: 1 },
            { type: "added", content: "export const foo = 2;", lineNumber: 1 },
          ],
          addedLines: 1,
          removedLines: 1,
        },
      ],
      applyPatches: [
        {
          filePath: "src/foo.ts",
          fullContent: "export const foo = 2;",
        },
      ],
    });

    const response = await fetch(`${baseUrl}/api/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "update foo",
        repoPath: "C:/repo",
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fileDiffs).toHaveLength(1);
    expect(body.patchResults).toEqual([
      { filePath: "src/foo.ts", status: "applied" },
    ]);
  });
});
