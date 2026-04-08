import { describe, expect, it } from "vitest";
import { validateLlmOutput } from "../validateLlmOutput.js";

import {
  analyzePatchScope,
  calculateDeveloperConfidence,
  detectMicroEditIntent,
  detectUiMappingRiskIntent,
  evaluateIntentPatchMismatch,
  evaluateUiMappingRisk,
  filterVisibleDeveloperWarnings,
  isVagueDeveloperTask,
  validateDeveloperOutput,
} from "../runLlmPatchFlow.js";

describe("validateDeveloperOutput", () => {
  it("blocks console logging of password-like values", () => {
    const result = validateDeveloperOutput({
      task: "add debug logging",
      filePath: "src/auth/login.ts",
      originalContent: "export function login(password: string) { return password.length > 0; }",
      fullContent:
        "export function login(password: string) { console.log('password', password); return password.length > 0; }",
    });

    expect(result.blocked).toBe(true);
    expect(result.warnings).toContain(
      "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled."
    );
  });

  it("does not block non-sensitive logging", () => {
    const result = validateDeveloperOutput({
      task: "add debug logging",
      filePath: "src/auth/login.ts",
      originalContent: "export function login(username: string) { return username.length > 0; }",
      fullContent:
        "export function login(username: string) { console.log('username', username); return username.length > 0; }",
    });

    expect(result.blocked).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.confidencePenalty).toBe(0);
  });

  it("warns on new empty catch blocks", () => {
    const result = validateDeveloperOutput({
      task: "handle errors",
      filePath: "src/api/user.ts",
      originalContent:
        "export async function save() {\n  try {\n    return await apiCall();\n  } catch (e) {\n    throw e;\n  }\n}",
      fullContent:
        "export async function save() {\n  try {\n    return await apiCall();\n  } catch (e) {}\n}",
    });

    expect(result.blocked).toBe(false);
    expect(result.confidencePenalty).toBe(20);
    expect(result.warnings).toContain(
      "[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks."
    );
  });

  it("flags filler patches when content is unchanged", () => {
    const content =
      "export function sanitizeInput(value: string) {\n  return value.trim();\n}";
    const result = validateDeveloperOutput({
      task: "refactor sanitizer",
      filePath: "src/utils/sanitize.ts",
      originalContent: content,
      fullContent: content,
    });

    expect(result.blocked).toBe(false);
    expect(result.confidencePenalty).toBe(30);
    expect(result.warnings).toContain(
      "[DEVELOPER_FILLER_PATCH] No meaningful changes detected."
    );
  });

  it("warns when the patch changes more than sixty percent of a large file", () => {
    const originalContent = Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};`).join("\n");
    const fullContent = Array.from({ length: 80 }, (_, index) => `const changed${index} = value${index};`).join("\n");

    const result = validateDeveloperOutput({
      task: "rewrite file",
      filePath: "src/large.ts",
      originalContent,
      fullContent,
    });

    expect(result.blocked).toBe(false);
    expect(result.confidencePenalty).toBe(25);
    expect(result.warnings).toContain(
      "[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file."
    );
  });

  it("blocks auth guard removal", () => {
    const result = validateDeveloperOutput({
      task: "simplify auth flow",
      filePath: "src/auth/guard.ts",
      originalContent:
        "export function canAccess(user: User) {\n  if (!isAuthenticated(user)) return false;\n  return hasRole(user, 'admin');\n}",
      fullContent:
        "export function canAccess(user: User) {\n  return true;\n}",
    });

    expect(result.blocked).toBe(true);
    expect(result.warnings).toContain(
      "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization."
    );
  });

  it("blocks validation removal", () => {
    const result = validateDeveloperOutput({
      task: "simplify input handler",
      filePath: "src/api/register.ts",
      originalContent:
        "export function register(input: string) {\n  validateInput(input);\n  if (!input) throw new Error('required');\n  return input;\n}",
      fullContent:
        "export function register(input: string) {\n  return input;\n}",
    });

    expect(result.blocked).toBe(true);
    expect(result.warnings).toContain(
      "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards."
    );
  });

  it("caps vague developer tasks to preview-only confidence levels", () => {
    expect(isVagueDeveloperTask("fix bug")).toBe(true);
    expect(
      calculateDeveloperConfidence({
        warnings: [],
        changedFileCount: 1,
        changedFileMetrics: [{ totalLines: 20, changedLines: 2 }],
        vagueTask: true,
      })
    ).toBeLessThanOrEqual(60);
  });

  it("keeps specific developer tasks at the 95 confidence baseline when no penalties apply", () => {
    expect(isVagueDeveloperTask("update login validator to trim username input")).toBe(
      false
    );
    expect(
      calculateDeveloperConfidence({
        warnings: [],
        changedFileCount: 1,
        changedFileMetrics: [{ totalLines: 40, changedLines: 4 }],
        vagueTask: false,
      })
    ).toBe(95);
  });

  it("reduces developer confidence for mass-change warnings", () => {
    expect(
      calculateDeveloperConfidence({
        warnings: ["[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file."],
        changedFileCount: 1,
        changedFileMetrics: [{ totalLines: 260, changedLines: 130 }],
        vagueTask: false,
      })
    ).toBe(75);
  });

  it("detects micro-edit intent for spacing and copy-polish tasks", () => {
    expect(
      detectMicroEditIntent(
        "Fix spacing between the analysis cards on the landing page."
      )
    ).toBe(true);
    expect(detectMicroEditIntent("Update placeholder text in the search input")).toBe(
      true
    );
    expect(detectMicroEditIntent("Add OAuth callback handling to auth flow")).toBe(
      false
    );
  });

  it("analyzes oversized patch scope deterministically", () => {
    const originalContent = Array.from(
      { length: 90 },
      (_, index) => `.card-${index} { gap: ${index}px; }`
    ).join("\n");
    const fullContent = Array.from(
      { length: 90 },
      (_, index) => `.analysis-card-${index} { margin: ${index}px; padding: 12px; }`
    ).join("\n");

    expect(
      analyzePatchScope({
        applyPatches: [
          {
            filePath: "src/styles/landing.css",
            fullContent,
          },
        ],
        originalContents: {
          "src/styles/landing.css": originalContent,
        },
      })
    ).toMatchObject({
      changedFileCount: 1,
      rewriteLikeSuspicion: true,
      cssRewriteSuspicion: true,
    });
  });

  it("flags intent-vs-patch mismatch for oversized micro-edit rewrites", () => {
    const mismatch = evaluateIntentPatchMismatch({
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

    expect(mismatch.suspicious).toBe(true);
    expect(mismatch.confidenceCap).toBe(55);
    expect(mismatch.risk.score).toBeGreaterThan(0);
    expect(mismatch.warnings).toContain(
      "Micro-edit task produced a larger-than-expected patch."
    );
    expect(mismatch.warnings).toContain(
      "CSS patch scope is too large for a spacing-only request."
    );
  });

  it("detects ui mapping and swap tasks and applies a deterministic review cap", () => {
    expect(detectUiMappingRiskIntent("swap the before and after card mapping")).toBe(
      true
    );
    expect(detectUiMappingRiskIntent("fix spacing between cards")).toBe(false);

    const risk = evaluateUiMappingRisk({
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

    expect(risk.applies).toBe(true);
    expect(risk.confidenceCap).toBe(70);
    expect(risk.risk.score).toBeGreaterThan(0);
    expect(risk.forcePreviewOnly).toBe(false);
    expect(risk.warnings).toContain(
      "UI mapping/order changes are higher-risk and should be reviewed carefully."
    );
  });

  it("hides internal developer warnings from user-facing warnings", () => {
    expect(
      filterVisibleDeveloperWarnings([
        "[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks.",
        "[DEVELOPER_FILLER_PATCH] No meaningful changes detected.",
        "[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file.",
      ])
    ).toEqual([]);
  });

  it("keeps blocked developer warnings visible to users", () => {
    expect(
      filterVisibleDeveloperWarnings([
        "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled.",
        "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards.",
        "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization.",
      ])
    ).toEqual([
      "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled.",
      "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards.",
      "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization.",
    ]);
  });

  it("flags hallucinated raw unicode escapes as blocking output", () => {
    const content =
      "export const broken = \"" +
      "\\u0041\\u0042\\u0043\\u0044\\u0045\\u0046\\u0047\\u0048\\u0049\\u0050\\u0051\\u0052\\u0053\\u0054\\u0055" +
      "\";";

    const result = validateLlmOutput("developer", [
      {
        filePath: "src/utils/broken.ts",
        content,
      },
    ]);

    const issue = result.issues.find((i) => i.code === "UNICODE_ESCAPE_DETECTED");
    expect(issue?.severity).toBe("error");
    expect(result.verdict).toBe("block");
  });

  it("does not flag normal code with one or two unicode escapes", () => {
    const result = validateLlmOutput("developer", [
      {
        filePath: "src/utils/labels.ts",
        content:
          'export const unicodeLabel = "Price \\u20AC";\nexport const newline = "\\u000A";',
      },
    ]);

    expect(
      result.issues.some((i) => i.code === "UNICODE_ESCAPE_DETECTED")
    ).toBe(false);
  });
});
