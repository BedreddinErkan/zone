"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const validateLlmOutput_js_1 = require("../validateLlmOutput.js");
const computeRiskScore_js_1 = require("../computeRiskScore.js");
const confidenceGate_js_1 = require("../confidenceGate.js");
const runLlmPatchFlow_js_1 = require("../runLlmPatchFlow.js");
(0, vitest_1.describe)("validateDeveloperOutput", () => {
    (0, vitest_1.it)("blocks console logging of password-like values", () => {
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "add debug logging",
            filePath: "src/auth/login.ts",
            originalContent: "export function login(password: string) { return password.length > 0; }",
            fullContent: "export function login(password: string) { console.log('password', password); return password.length > 0; }",
        });
        (0, vitest_1.expect)(result.blocked).toBe(true);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled.");
    });
    (0, vitest_1.it)("does not block non-sensitive logging", () => {
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "add debug logging",
            filePath: "src/auth/login.ts",
            originalContent: "export function login(username: string) { return username.length > 0; }",
            fullContent: "export function login(username: string) { console.log('username', username); return username.length > 0; }",
        });
        (0, vitest_1.expect)(result.blocked).toBe(false);
        (0, vitest_1.expect)(result.warnings).toEqual([]);
        (0, vitest_1.expect)(result.confidencePenalty).toBe(0);
    });
    (0, vitest_1.it)("warns on new empty catch blocks", () => {
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "handle errors",
            filePath: "src/api/user.ts",
            originalContent: "export async function save() {\n  try {\n    return await apiCall();\n  } catch (e) {\n    throw e;\n  }\n}",
            fullContent: "export async function save() {\n  try {\n    return await apiCall();\n  } catch (e) {}\n}",
        });
        (0, vitest_1.expect)(result.blocked).toBe(false);
        (0, vitest_1.expect)(result.confidencePenalty).toBe(20);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks.");
    });
    (0, vitest_1.it)("flags filler patches when content is unchanged", () => {
        const content = "export function sanitizeInput(value: string) {\n  return value.trim();\n}";
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "refactor sanitizer",
            filePath: "src/utils/sanitize.ts",
            originalContent: content,
            fullContent: content,
        });
        (0, vitest_1.expect)(result.blocked).toBe(false);
        (0, vitest_1.expect)(result.confidencePenalty).toBe(30);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_FILLER_PATCH] No meaningful changes detected.");
    });
    (0, vitest_1.it)("warns when the patch changes more than sixty percent of a large file", () => {
        const originalContent = Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};`).join("\n");
        const fullContent = Array.from({ length: 80 }, (_, index) => `const changed${index} = value${index};`).join("\n");
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "rewrite file",
            filePath: "src/large.ts",
            originalContent,
            fullContent,
        });
        (0, vitest_1.expect)(result.blocked).toBe(false);
        (0, vitest_1.expect)(result.confidencePenalty).toBe(25);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file.");
    });
    (0, vitest_1.it)("blocks auth guard removal", () => {
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "simplify auth flow",
            filePath: "src/auth/guard.ts",
            originalContent: "export function canAccess(user: User) {\n  if (!isAuthenticated(user)) return false;\n  return hasRole(user, 'admin');\n}",
            fullContent: "export function canAccess(user: User) {\n  return true;\n}",
        });
        (0, vitest_1.expect)(result.blocked).toBe(true);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization.");
    });
    (0, vitest_1.it)("blocks validation removal", () => {
        const result = (0, runLlmPatchFlow_js_1.validateDeveloperOutput)({
            task: "simplify input handler",
            filePath: "src/api/register.ts",
            originalContent: "export function register(input: string) {\n  validateInput(input);\n  if (!input) throw new Error('required');\n  return input;\n}",
            fullContent: "export function register(input: string) {\n  return input;\n}",
        });
        (0, vitest_1.expect)(result.blocked).toBe(true);
        (0, vitest_1.expect)(result.warnings).toContain("[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards.");
    });
    (0, vitest_1.it)("caps vague developer tasks to preview-only confidence levels", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isVagueDeveloperTask)("fix bug")).toBe(true);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.calculateDeveloperConfidence)({
            warnings: [],
            changedFileCount: 1,
            changedFileMetrics: [{ totalLines: 20, changedLines: 2 }],
            vagueTask: true,
        })).toBeLessThanOrEqual(60);
    });
    (0, vitest_1.it)("keeps specific developer tasks at the 95 confidence baseline when no penalties apply", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isVagueDeveloperTask)("update login validator to trim username input")).toBe(false);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.calculateDeveloperConfidence)({
            warnings: [],
            changedFileCount: 1,
            changedFileMetrics: [{ totalLines: 40, changedLines: 4 }],
            vagueTask: false,
        })).toBe(95);
    });
    (0, vitest_1.it)("reduces developer confidence for mass-change warnings", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.calculateDeveloperConfidence)({
            warnings: ["[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file."],
            changedFileCount: 1,
            changedFileMetrics: [{ totalLines: 260, changedLines: 130 }],
            vagueTask: false,
        })).toBe(75);
    });
    (0, vitest_1.it)("detects micro-edit intent for spacing and copy-polish tasks", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.detectMicroEditIntent)("Fix spacing between the analysis cards on the landing page.")).toBe(true);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.detectMicroEditIntent)("Update placeholder text in the search input")).toBe(true);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.detectMicroEditIntent)("Add OAuth callback handling to auth flow")).toBe(false);
    });
    (0, vitest_1.it)("analyzes oversized patch scope deterministically", () => {
        const originalContent = Array.from({ length: 90 }, (_, index) => `.card-${index} { gap: ${index}px; }`).join("\n");
        const fullContent = Array.from({ length: 90 }, (_, index) => `.analysis-card-${index} { margin: ${index}px; padding: 12px; }`).join("\n");
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.analyzePatchScope)({
            applyPatches: [
                {
                    filePath: "src/styles/landing.css",
                    fullContent,
                },
            ],
            originalContents: {
                "src/styles/landing.css": originalContent,
            },
        })).toMatchObject({
            changedFileCount: 1,
            rewriteLikeSuspicion: true,
            cssRewriteSuspicion: true,
        });
    });
    (0, vitest_1.it)("flags intent-vs-patch mismatch for oversized micro-edit rewrites", () => {
        const mismatch = (0, runLlmPatchFlow_js_1.evaluateIntentPatchMismatch)({
            task: "Fix spacing between the analysis cards on the landing page",
            patchScope: {
                changedFileCount: 1,
                totalAddedLines: 95,
                totalRemovedLines: 95,
                totalChangedLines: 190,
                rewriteLikeSuspicion: true,
                cssRewriteSuspicion: true,
            },
        });
        (0, vitest_1.expect)(mismatch.suspicious).toBe(true);
        (0, vitest_1.expect)(mismatch.confidenceCap).toBe(55);
        (0, vitest_1.expect)(mismatch.risk.score).toBeGreaterThan(0);
        (0, vitest_1.expect)(mismatch.warnings).toContain("Micro-edit task produced a larger-than-expected patch.");
        (0, vitest_1.expect)(mismatch.warnings).toContain("CSS patch scope is too large for a spacing-only request.");
    });
    (0, vitest_1.it)("detects ui mapping and swap tasks and applies a deterministic review cap", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.detectUiMappingRiskIntent)("swap the before and after card mapping")).toBe(true);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.detectUiMappingRiskIntent)("fix spacing between cards")).toBe(false);
        const risk = (0, runLlmPatchFlow_js_1.evaluateUiMappingRisk)({
            task: "swap the before and after card mapping",
            patchScope: {
                changedFileCount: 1,
                totalAddedLines: 8,
                totalRemovedLines: 8,
                totalChangedLines: 16,
                rewriteLikeSuspicion: false,
                cssRewriteSuspicion: false,
            },
        });
        (0, vitest_1.expect)(risk.applies).toBe(true);
        (0, vitest_1.expect)(risk.confidenceCap).toBe(70);
        (0, vitest_1.expect)(risk.risk.score).toBeGreaterThan(0);
        (0, vitest_1.expect)(risk.forcePreviewOnly).toBe(false);
        (0, vitest_1.expect)(risk.warnings).toContain("UI mapping/order changes are higher-risk and should be reviewed carefully.");
    });
    (0, vitest_1.it)("hides internal developer warnings from user-facing warnings", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.filterVisibleDeveloperWarnings)([
            "[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks.",
            "[DEVELOPER_FILLER_PATCH] No meaningful changes detected.",
            "[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file.",
        ])).toEqual([]);
    });
    (0, vitest_1.it)("keeps blocked developer warnings visible to users", () => {
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.filterVisibleDeveloperWarnings)([
            "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled.",
            "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards.",
            "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization.",
        ])).toEqual([
            "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled.",
            "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards.",
            "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization.",
        ]);
    });
    (0, vitest_1.it)("flags hallucinated raw unicode escapes as blocking output", () => {
        const content = "export const broken = \"" +
            "\\u0041\\u0042\\u0043\\u0044\\u0045\\u0046\\u0047\\u0048\\u0049\\u0050\\u0051\\u0052\\u0053\\u0054\\u0055" +
            "\";";
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [
            {
                filePath: "src/utils/broken.ts",
                content,
            },
        ]);
        const issue = result.issues.find((i) => i.code === "UNICODE_ESCAPE_DETECTED");
        (0, vitest_1.expect)(issue?.severity).toBe("error");
        (0, vitest_1.expect)(result.verdict).toBe("block");
    });
    (0, vitest_1.it)("does not flag normal code with one or two unicode escapes", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [
            {
                filePath: "src/utils/labels.ts",
                content: 'export const unicodeLabel = "Price \\u20AC";\nexport const newline = "\\u000A";',
            },
        ]);
        (0, vitest_1.expect)(result.issues.some((i) => i.code === "UNICODE_ESCAPE_DETECTED")).toBe(false);
    });
    (0, vitest_1.describe)("risk scoring", () => {
        (0, vitest_1.it)("assigns destructive risk for drop-table tasks", () => {
            const result = (0, computeRiskScore_js_1.computeRiskScore)({
                task: "drop table users from database",
            });
            (0, vitest_1.expect)(result.breakdown.destructive).toBeGreaterThanOrEqual(50);
        });
        (0, vitest_1.it)("assigns schema risk for schema modification tasks", () => {
            const result = (0, computeRiskScore_js_1.computeRiskScore)({
                task: "modify schema file to add column to users table",
            });
            (0, vitest_1.expect)(result.breakdown.schema).toBeGreaterThanOrEqual(25);
        });
        (0, vitest_1.it)("assigns mass-scope risk for broad destructive tasks", () => {
            const result = (0, computeRiskScore_js_1.computeRiskScore)({
                task: "delete all records in the entire user database",
            });
            (0, vitest_1.expect)(result.breakdown.massScope).toBeGreaterThanOrEqual(40);
        });
        (0, vitest_1.it)("keeps normal single-file feature additions low risk", () => {
            const result = (0, computeRiskScore_js_1.computeRiskScore)({
                task: "add forgot password helper text to login form",
                role: "developer",
            });
            (0, vitest_1.expect)(result.breakdown.destructive).toBeLessThan(20);
            (0, vitest_1.expect)(result.breakdown.schema).toBeLessThan(20);
            (0, vitest_1.expect)(result.breakdown.critical).toBeLessThan(20);
            (0, vitest_1.expect)(result.breakdown.massScope).toBeLessThan(20);
        });
    });
    (0, vitest_1.describe)("confidence gate", () => {
        (0, vitest_1.it)("treats confidence below 70 as preview_only", () => {
            const gate = (0, confidenceGate_js_1.checkConfidenceGate)({
                confidenceScore: 69,
                role: "data_analyst",
            });
            const decisionMode = gate.pass ? "safe_to_apply" : "preview_only";
            (0, vitest_1.expect)(decisionMode).toBe("preview_only");
        });
        (0, vitest_1.it)("treats confidence at or above threshold with no blocking issues as safe_to_apply", () => {
            const gate = (0, confidenceGate_js_1.checkConfidenceGate)({
                confidenceScore: 80,
                role: "developer",
            });
            const decisionMode = gate.pass ? "safe_to_apply" : "preview_only";
            (0, vitest_1.expect)(decisionMode).toBe("safe_to_apply");
        });
        (0, vitest_1.it)("treats blocking validator issues as blocked regardless of confidence", () => {
            const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [
                {
                    filePath: "src/ui/App.tsx",
                    content: 'const App = () => <div />;',
                },
            ]);
            const decisionMode = result.verdict === "block"
                ? "blocked"
                : result.verdict === "warn"
                    ? "preview_only"
                    : "safe_to_apply";
            (0, vitest_1.expect)(decisionMode).toBe("blocked");
        });
    });
    (0, vitest_1.describe)("context filtering", () => {
        (0, vitest_1.it)("filters .env paths from developer context", () => {
            (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)(".env")).toBe(false);
        });
        (0, vitest_1.it)("filters .gitignore paths from developer context", () => {
            (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)(".gitignore")).toBe(false);
        });
        (0, vitest_1.it)("filters node_modules paths from developer context", () => {
            (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)("node_modules/react/index.js")).toBe(true);
        });
        (0, vitest_1.it)("keeps normal source files in developer context", () => {
            (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)("src/auth/login.ts")).toBe(false);
        });
    });
});
//# sourceMappingURL=developerOutputValidator.test.js.map