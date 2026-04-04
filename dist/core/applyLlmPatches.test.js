"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const applyLlmPatches_js_1 = require("./applyLlmPatches.js");
let tmpDir;
(0, vitest_1.beforeEach)(async () => {
    tmpDir = await node_fs_1.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "zone-apply-test-"));
});
(0, vitest_1.afterEach)(async () => {
    await node_fs_1.promises.rm(tmpDir, { recursive: true, force: true });
});
async function readFile(relative) {
    return node_fs_1.promises.readFile(node_path_1.default.join(tmpDir, relative), "utf8");
}
async function writeExisting(relative, content) {
    const abs = node_path_1.default.join(tmpDir, relative);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(abs), { recursive: true });
    await node_fs_1.promises.writeFile(abs, content, "utf8");
}
(0, vitest_1.describe)("applyLlmPatches", () => {
    (0, vitest_1.it)("returns empty arrays when patches list is empty", async () => {
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
    });
    (0, vitest_1.it)("skips patches with empty fullContent", async () => {
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "src/index.ts", fullContent: "" }], tmpDir);
        (0, vitest_1.expect)(result.skipped).toEqual(["src/index.ts"]);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
    });
    (0, vitest_1.it)("writes normal shallow files correctly", async () => {
        const content = "export const x = 1;\n";
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "src/x.ts", fullContent: content }], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual(["src/x.ts"]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
        (0, vitest_1.expect)(await readFile("src/x.ts")).toBe(content);
    });
    (0, vitest_1.it)("applies nested file paths inside repo", async () => {
        const content = "public class LoginSteps {}\n";
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([
            {
                filePath: "src/test/java/com/enuygun/stepdefinitions/LoginSteps.java",
                fullContent: content,
            },
        ], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual([
            "src/test/java/com/enuygun/stepdefinitions/LoginSteps.java",
        ]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
        (0, vitest_1.expect)(await readFile("src/test/java/com/enuygun/stepdefinitions/LoginSteps.java")).toBe(content);
    });
    (0, vitest_1.it)("creates missing parent directories recursively", async () => {
        const content = "describe('login', () => {});\n";
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([
            {
                filePath: "cypress/e2e/smoke/login.spec.js",
                fullContent: content,
            },
        ], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual(["cypress/e2e/smoke/login.spec.js"]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
        (0, vitest_1.expect)(await readFile("cypress/e2e/smoke/login.spec.js")).toBe(content);
    });
    (0, vitest_1.it)("overwrites an existing file with new content", async () => {
        await writeExisting("src/util.ts", "// old content\n");
        const newContent = "export function util() {}\n";
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "src/util.ts", fullContent: newContent }], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual(["src/util.ts"]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([]);
        (0, vitest_1.expect)(await readFile("src/util.ts")).toBe(newContent);
    });
    (0, vitest_1.it)("fails when patch path escapes repo using dot dot segments", async () => {
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "../outside.ts", fullContent: "export const x = 1;\n" }], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual(["../outside.ts"]);
    });
    (0, vitest_1.it)("fails when an absolute path escapes outside the repo", async () => {
        const outsidePath = node_path_1.default.resolve(tmpDir, "..", "outside.ts");
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: outsidePath, fullContent: "export const x = 1;\n" }], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual([outsidePath]);
    });
    (0, vitest_1.it)("fails when repo path does not exist", async () => {
        const badRepoPath = node_path_1.default.join(tmpDir, "does-not-exist");
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "src/a.ts", fullContent: "const a = 1;" }], badRepoPath);
        (0, vitest_1.expect)(result.failed).toEqual(["src/a.ts"]);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
    });
    (0, vitest_1.it)("skips empty content patches even when repo path does not exist", async () => {
        const badRepoPath = node_path_1.default.join(tmpDir, "missing-repo");
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([
            { filePath: "empty.ts", fullContent: "" },
            { filePath: "nested/file.ts", fullContent: "export const x = 1;\n" },
        ], badRepoPath);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual(["empty.ts"]);
        (0, vitest_1.expect)(result.failed).toEqual(["nested/file.ts"]);
    });
    (0, vitest_1.it)("processes multiple patches independently", async () => {
        const goodContent = "export const good = true;\n";
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([
            { filePath: "src/good.ts", fullContent: goodContent },
            { filePath: "../outside.ts", fullContent: "export const bad = true;\n" },
            { filePath: "src/empty.ts", fullContent: "" },
        ], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual(["src/good.ts"]);
        (0, vitest_1.expect)(result.skipped).toEqual(["src/empty.ts"]);
        (0, vitest_1.expect)(result.failed).toEqual(["../outside.ts"]);
        (0, vitest_1.expect)(await readFile("src/good.ts")).toBe(goodContent);
    });
    (0, vitest_1.it)("does not throw when all patches fail and returns failed array instead", async () => {
        const badRepoPath = node_path_1.default.join(tmpDir, "nonexistent");
        await (0, vitest_1.expect)((0, applyLlmPatches_js_1.applyLlmPatches)([
            { filePath: "a.ts", fullContent: "a" },
            { filePath: "b.ts", fullContent: "b" },
        ], badRepoPath)).resolves.toEqual({
            applied: [],
            skipped: [],
            failed: ["a.ts", "b.ts"],
        });
    });
    (0, vitest_1.it)("applied file content is written in utf8", async () => {
        const unicodeContent = "// hello\nexport const greeting = 'world';\n";
        await (0, applyLlmPatches_js_1.applyLlmPatches)([{ filePath: "unicode.ts", fullContent: unicodeContent }], tmpDir);
        const written = await readFile("unicode.ts");
        (0, vitest_1.expect)(written).toBe(unicodeContent);
    });
    (0, vitest_1.it)("fails protected src/ui paths without writing them", async () => {
        const result = await (0, applyLlmPatches_js_1.applyLlmPatches)([
            {
                filePath: "src/ui/index.html",
                fullContent: "<html><body>bad overwrite</body></html>",
            },
        ], tmpDir);
        (0, vitest_1.expect)(result.applied).toEqual([]);
        (0, vitest_1.expect)(result.skipped).toEqual([]);
        (0, vitest_1.expect)(result.failed).toEqual(["src/ui/index.html"]);
        await (0, vitest_1.expect)(node_fs_1.promises.access(node_path_1.default.join(tmpDir, "src/ui/index.html"))).rejects.toThrow();
    });
});
//# sourceMappingURL=applyLlmPatches.test.js.map