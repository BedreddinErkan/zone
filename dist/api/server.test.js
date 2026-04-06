"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_http_1 = require("node:http");
const runAgentMock = vitest_1.vi.fn();
const runLlmPatchFlowMock = vitest_1.vi.fn();
const applyLlmPatchesMock = vitest_1.vi.fn();
const runTestEngineerFlowMock = vitest_1.vi.fn();
const runDataAnalystFlowMock = vitest_1.vi.fn();
const scanRepoMock = vitest_1.vi.fn();
const readProjectFilesMock = vitest_1.vi.fn();
const responsesCreateMock = vitest_1.vi.fn();
const supabaseInsertMock = vitest_1.vi.fn();
const supabaseRpcMock = vitest_1.vi.fn();
const supabaseFromMock = vitest_1.vi.fn(() => ({
    insert: supabaseInsertMock,
}));
const createSupabaseClientMock = vitest_1.vi.fn(() => ({
    from: supabaseFromMock,
    rpc: supabaseRpcMock,
}));
const createOpenAIClientMock = vitest_1.vi.fn(() => ({
    responses: {
        create: responsesCreateMock,
    },
}));
const getModelNameMock = vitest_1.vi.fn(() => "gpt-4o-mini");
vitest_1.vi.mock("../core/runAgent.js", () => ({
    runAgent: runAgentMock,
}));
vitest_1.vi.mock("../core/runLlmPatchFlow.js", () => ({
    runLlmPatchFlow: runLlmPatchFlowMock,
}));
vitest_1.vi.mock("../core/applyLlmPatches.js", () => ({
    applyLlmPatches: applyLlmPatchesMock,
}));
vitest_1.vi.mock("../roles/runTestEngineerFlow.js", () => ({
    runTestEngineerFlow: runTestEngineerFlowMock,
}));
vitest_1.vi.mock("../roles/runDataAnalystFlow.js", () => ({
    runDataAnalystFlow: runDataAnalystFlowMock,
}));
vitest_1.vi.mock("../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("../llm/openaiClient.js", () => ({
    createOpenAIClient: createOpenAIClientMock,
    getModelName: getModelNameMock,
}));
vitest_1.vi.mock("@supabase/supabase-js", () => ({
    createClient: createSupabaseClientMock,
}));
(0, vitest_1.describe)("/api/test-engineer", () => {
    let server;
    let baseUrl;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.resetModules();
        vitest_1.vi.clearAllMocks();
        process.env.VITEST = "true";
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.ZONE_USER_ID;
        const { app } = await import("./server.js");
        server = (0, node_http_1.createServer)(app);
        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Server address unavailable");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
    });
    (0, vitest_1.afterEach)(async () => {
        await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });
    (0, vitest_1.it)("returns complexity from the test engineer flow", async () => {
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
                userId: "clerk_user_123",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.complexity).toBe("data_driven");
    });
    (0, vitest_1.it)("returns the expected successful shape for /api/data-analyst", async () => {
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
                userId: "clerk_user_123",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body).toMatchObject({
            ok: true,
            dialect: "postgresql",
            migrationFormat: "flyway",
            confidence: 90,
            summary: "Creates orders table",
            warnings: ["Existing index naming differs from default convention."],
        });
        (0, vitest_1.expect)(body.applyPatches).toHaveLength(1);
        (0, vitest_1.expect)(body.applyPatches[0].filePath).toBe("db/migration/V3__orders.sql");
    });
    (0, vitest_1.it)("returns contextFiles from the developer patch flow", async () => {
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
                userId: "clerk_user_123",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.contextFiles).toEqual([
            "src/components/LoginForm.tsx",
            "server/routes/auth.ts",
        ]);
    });
    (0, vitest_1.it)("returns fileDiffs from /api/dry-run", async () => {
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
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.ok).toBe(true);
        (0, vitest_1.expect)(body.fileDiffs).toHaveLength(1);
        (0, vitest_1.expect)(body.patchResults).toEqual([
            { filePath: "src/foo.ts", status: "applied" },
        ]);
    });
    (0, vitest_1.it)("logs successful developer runs to Supabase when env is configured", async () => {
        process.env.SUPABASE_URL = "https://example.supabase.co";
        process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
        runLlmPatchFlowMock.mockResolvedValue({
            ok: true,
            patchPreview: "=== LLM PATCH PREVIEW ===",
            warnings: [],
            developerConfidence: 78,
            decisionMode: "safe_to_apply",
            applyPatches: [],
            patchResults: [],
        });
        supabaseInsertMock.mockResolvedValue({ error: null });
        supabaseRpcMock.mockResolvedValue({ error: null });
        const response = await fetch(`${baseUrl}/api/patch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "fix login validation",
                repoPath: "C:/repo",
                userId: "clerk_user_123",
            }),
        });
        (0, vitest_1.expect)(response.status).toBe(200);
        await vitest_1.vi.waitFor(() => {
            (0, vitest_1.expect)(createSupabaseClientMock).toHaveBeenCalledWith("https://example.supabase.co", "service-role");
            (0, vitest_1.expect)(supabaseFromMock).toHaveBeenCalledWith("run_logs");
            (0, vitest_1.expect)(supabaseInsertMock).toHaveBeenCalledWith({
                user_id: "clerk_user_123",
                role: "developer",
                task: "fix login validation",
                repo_path: "C:/repo",
                decision: "safe_to_apply",
                confidence: 78,
                credits_used: 0.1,
            });
            (0, vitest_1.expect)(supabaseRpcMock).toHaveBeenCalledWith("deduct_credits_and_increment_runs", {
                p_user_id: "clerk_user_123",
                p_credits: 1,
            });
        });
    });
    (0, vitest_1.it)("skips Supabase logging silently when Supabase env is missing", async () => {
        runTestEngineerFlowMock.mockResolvedValue({
            ok: true,
            framework: "playwright_ts",
            language: "typescript",
            confidence: 82,
            summary: "Generated test",
            warnings: [],
            complexity: "single_scenario",
            decisionMode: "safe_to_apply",
            applyPatches: [],
            preview: "preview",
        });
        const response = await fetch(`${baseUrl}/api/test-engineer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "add login test",
                repoPath: "C:/repo",
                userId: "clerk_user_123",
            }),
        });
        (0, vitest_1.expect)(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        (0, vitest_1.expect)(createSupabaseClientMock).not.toHaveBeenCalled();
        (0, vitest_1.expect)(supabaseInsertMock).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("logs successful data analyst runs with derived decision mode", async () => {
        process.env.SUPABASE_URL = "https://example.supabase.co";
        process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
        runDataAnalystFlowMock.mockResolvedValue({
            ok: true,
            dialect: "postgresql",
            migrationFormat: "flyway",
            confidence: 62,
            summary: "Adds report table",
            warnings: [],
            applyPatches: [],
            fileDiffs: [],
            preview: "preview",
        });
        supabaseInsertMock.mockResolvedValue({ error: null });
        supabaseRpcMock.mockResolvedValue({ error: null });
        const response = await fetch(`${baseUrl}/api/data-analyst`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "add reporting table",
                repoPath: "C:/repo",
                userId: "clerk_user_456",
            }),
        });
        (0, vitest_1.expect)(response.status).toBe(200);
        await vitest_1.vi.waitFor(() => {
            (0, vitest_1.expect)(supabaseInsertMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                role: "data_analyst",
                decision: "preview_only",
                confidence: 62,
                credits_used: 0.06,
            }));
            (0, vitest_1.expect)(supabaseRpcMock).toHaveBeenCalledWith("deduct_credits_and_increment_runs", {
                p_user_id: "clerk_user_456",
                p_credits: 1,
            });
        });
    });
    (0, vitest_1.it)("returns an enhanced task from /api/enhance-task", async () => {
        scanRepoMock.mockResolvedValue([
            {
                path: "tests/login.spec.ts",
                absolutePath: "C:/repo/tests/login.spec.ts",
            },
            {
                path: "tests/cart.spec.ts",
                absolutePath: "C:/repo/tests/cart.spec.ts",
            },
            {
                path: "src/app.ts",
                absolutePath: "C:/repo/src/app.ts",
            },
        ]);
        readProjectFilesMock.mockResolvedValue({
            "C:/repo/tests/cart.spec.ts": "test('cart', async () => {});",
            "C:/repo/tests/login.spec.ts": "test('login', async () => {});",
        });
        responsesCreateMock.mockResolvedValue({
            output_text: "Extend tests/login.spec.ts with a negative invalid-credentials Playwright test that reuses the existing login flow and asserts the real error state.",
        });
        const response = await fetch(`${baseUrl}/api/enhance-task`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "add login test",
                role: "test_engineer",
                repoPath: "C:/repo",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body).toEqual({
            ok: true,
            enhancedTask: "Extend tests/login.spec.ts with a negative invalid-credentials Playwright test that reuses the existing login flow and asserts the real error state.",
        });
        (0, vitest_1.expect)(scanRepoMock).toHaveBeenCalledWith("C:/repo");
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenCalledWith([
            "C:/repo/tests/cart.spec.ts",
            "C:/repo/tests/login.spec.ts",
        ]);
        (0, vitest_1.expect)(createOpenAIClientMock).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(responsesCreateMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            model: "gpt-4o-mini",
            instructions: vitest_1.expect.stringContaining("You are a task optimizer"),
            input: vitest_1.expect.stringContaining("User task: add login test"),
        }));
    });
});
//# sourceMappingURL=server.test.js.map