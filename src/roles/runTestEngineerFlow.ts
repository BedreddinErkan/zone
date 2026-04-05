import path from "node:path";
import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { detectTestFramework } from "./detectTestFramework.js";
import { buildTestEngineerContext } from "./testEngineerContext.js";
import { buildTestEngineerPrompt } from "../prompts/testEngineerPrompt.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import { checkConfidenceGate } from "../core/confidenceGate.js";
import { computeFileDiff, type DiffLine } from "../core/runLlmPatchFlow.js";
import {
  validateTestOutput,
  type ValidationDecision,
  type ValidationIssue,
} from "./testOutputValidator.js";
import { detectTestComplexity } from "./detectTestComplexity.js";
import type { TestComplexity } from "./detectTestComplexity.js";
import type { RepoFile } from "../types/project.js";
import type { TestEngineerContextDebug } from "./testEngineerContext.js";

interface TestEngineerDebugInfo {
  selectedRole: "test_engineer";
  promptPipeline: "buildTestEngineerPrompt";
  finalPromptBuilder: "buildFinalPrompt";
  detectedFramework: string;
  frameworkAugmentation:
    | "playwright"
    | "cypress"
    | "selenium"
    | "cucumber"
    | "none";
  contextSelection: TestEngineerContextDebug | null;
  outputPathDecision: {
    finalTestFilePath: string | null;
    finalPathSource:
      | "deterministic_context"
      | "deterministic_context_override"
      | "model_output";
    rawModelTestFilePath: string | null;
    rawModelFeatureFilePath: string | null;
    rawModelStepDefinitionPath: string | null;
    rawModelPathDiffers: boolean;
  };
  suspiciousFilenameFiltering: {
    triggered: boolean;
    generatedSlug: string | null;
    safeSlug: string | null;
  };
  playwrightUrlAssertionGuard: {
    checked: boolean;
    triggered: boolean;
    reason: string | null;
    routeEvidence: string[];
  };
}

export type TestEngineerFlowResult =
  | {
      ok: true;
      framework: string;
      language: string;
      confidence: number;
      decisionMode: "safe_to_apply" | "preview_only";
      summary: string;
      warnings: string[];
      complexity?: TestComplexity;
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      fileDiffs: Array<{
        filePath: string;
        addedLines: number;
        removedLines: number;
        diff: DiffLine[];
      }>;
      preview: string;
      debug?: TestEngineerDebugInfo;
    }
  | {
      ok: false;
      reason: string;
      framework?: string;
      language?: string;
      confidence?: number;
      decisionMode?: "blocked";
      summary?: string;
      warnings?: string[];
      complexity?: TestComplexity;
      applyPatches?: Array<{ filePath: string; fullContent: string }>;
      preview?: string;
      validationBlocked?: boolean;
      debug?: TestEngineerDebugInfo;
    };

function extractJson(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  throw new Error("No JSON found in model response");
}

function buildPreview(
  result: Record<string, unknown>,
  framework: string,
  outputPaths: { testFile: string; featureFile?: string; stepDefinition?: string }
): string {
  const lines: string[] = ["=== TEST ENGINEER PREVIEW ==="];
  lines.push(`Framework: ${framework}`);
  lines.push(`Summary: ${result["summary"] as string}`);
  const warnings = result["warnings"] as string[];
  if (warnings?.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  lines.push("");
  lines.push("Files to create:");
  if (outputPaths.testFile) {
    lines.push(`- ${outputPaths.testFile}`);
  }
  if (outputPaths.featureFile) {
    lines.push(`- ${outputPaths.featureFile} [feature]`);
  }
  if (outputPaths.stepDefinition) {
    lines.push(`- ${outputPaths.stepDefinition} [step definitions]`);
  }
  return lines.join("\n");
}

function normalizeTestContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function extractTestBlockSignature(block: string): string | null {
  const signatureMatch = block.match(
    /test(?:\.each\([\s\S]*?\))?\s*\(\s*(['"`])([^'"`]+)\1/
  );
  if (signatureMatch) {
    return signatureMatch[2].trim();
  }

  const fallbackMatch = block.match(/^\s*test(?:\.each)?[^\n]*/m);
  return fallbackMatch?.[0].trim() ?? null;
}

export function extractTestSignatures(content: string): string[] {
  const normalized = normalizeTestContent(content);
  const signatures = new Set<string>();
  const signaturePattern =
    /test(?:\.each\([\s\S]*?\))?\s*\(\s*(['"`])([^'"`]+)\1/g;

  let match: RegExpExecArray | null;
  while ((match = signaturePattern.exec(normalized)) !== null) {
    signatures.add(match[2].trim());
  }

  return [...signatures];
}

function deduplicatePlaywrightImport(content: string): string {
  let seen = false;
  return content.replace(
    /^\s*import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*['"]@playwright\/test['"];\s*$/gm,
    (line) => {
      if (seen) return "";
      seen = true;
      return line;
    }
  );
}

function splitTestBlocks(content: string): { prefix: string; blocks: string[] } {
  const normalized = normalizeTestContent(content);
  const blockStartPattern = /^\s*test(?:\.each)?/gm;
  const starts = [...normalized.matchAll(blockStartPattern)].map(
    (match) => match.index ?? 0
  );

  if (starts.length === 0) {
    return {
      prefix: normalized,
      blocks: [],
    };
  }

  return {
    prefix: normalized.slice(0, starts[0]),
    blocks: starts.map((start, index) =>
      normalized.slice(start, starts[index + 1] ?? normalized.length)
    ),
  };
}

function countTestBlocks(content: string): number {
  return (
    (content.match(/^\s*test\s*\(/gm) || []).length +
    (content.match(/^\s*test\.each\s*\(/gm) || []).length
  );
}

function safeAppendToExisting(
  originalContent: string,
  generatedContent: string
): string {
  if (!originalContent.trim()) {
    return generatedContent;
  }

  const originalCount = countTestBlocks(originalContent);
  const generatedCount = countTestBlocks(generatedContent);
  if (generatedCount <= originalCount) {
    return deduplicateTestBlocks(
      `${originalContent.trimEnd()}\n${generatedContent.trimStart()}`
    );
  }

  return generatedContent;
}

export function deduplicateTestBlocks(content: string): string {
  const normalized = normalizeTestContent(content);
  let nextContent = deduplicatePlaywrightImport(normalized);
  const lines = normalized.trimEnd().split("\n");
  if (lines.length % 2 === 0) {
    const midpoint = lines.length / 2;
    const firstHalf = lines.slice(0, midpoint).join("\n").trim();
    const secondHalf = lines.slice(midpoint).join("\n").trim();
    if (firstHalf && firstHalf === secondHalf) {
      return firstHalf;
    }
  }

  const blockStartPattern = /^\s*test(?:\.each)?/gm;
  const starts = [...nextContent.matchAll(blockStartPattern)].map(
    (match) => match.index ?? 0
  );

  if (starts.length === 0) {
    return nextContent.replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  const prefix = nextContent.slice(0, starts[0]);
  const blocks = starts.map((start, index) =>
    nextContent.slice(start, starts[index + 1] ?? nextContent.length)
  );

  const lastIndexBySignature = new Map<string, number>();
  blocks.forEach((block, index) => {
    const signature = extractTestBlockSignature(block);
    if (signature) {
      lastIndexBySignature.set(signature, index);
    }
  });

  const dedupedBlocks = blocks.filter((block, index) => {
    const signature = extractTestBlockSignature(block);
    if (!signature) return true;
    return lastIndexBySignature.get(signature) === index;
  });

  return `${prefix}${dedupedBlocks.join("")}`.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function finalizeGeneratedTestContent(input: {
  fullContent: string;
  originalContent: string;
}): {
  fullContent: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const rawGeneratedContent = input.fullContent;
  let nextContent = input.fullContent;

  const deduped = deduplicateTestBlocks(nextContent);
  if (deduped !== nextContent) {
    warnings.push("[TEST_DEDUPLICATION] Duplicate test blocks were removed.");
    nextContent = deduped;
  }

  const originalSignatures = new Set(extractTestSignatures(input.originalContent));
  const nextSignatures = new Set(extractTestSignatures(nextContent));
  const hasNewTestNames = [...nextSignatures].some(
    (signature) => !originalSignatures.has(signature)
  );

  if (
    input.originalContent &&
    rawGeneratedContent.length > input.originalContent.length * 2
  ) {
    warnings.push(
      "[TEST_DUPLICATE_CONTENT] Generated content appears to be duplicated. Returning original."
    );
    return {
      fullContent: input.originalContent,
      warnings,
    };
  }

  if (
    input.originalContent &&
    nextContent.length > input.originalContent.length * 1.5 &&
    !hasNewTestNames
  ) {
    return {
      fullContent: input.originalContent,
      warnings,
    };
  }

  return {
    fullContent: nextContent,
    warnings,
  };
}

function buildApplyPatches(
  result: Record<string, unknown>,
  outputPaths: { testFile: string; featureFile?: string; stepDefinition?: string }
): Array<{ filePath: string; fullContent: string }> {
  const patches: Array<{ filePath: string; fullContent: string }> = [];

  if (result["testFile"]) {
    const file = result["testFile"] as { path: string; content: string };
    if (outputPaths.testFile && file.content) {
      patches.push({ filePath: outputPaths.testFile, fullContent: file.content });
    }
  }

  if (result["featureFile"]) {
    const file = result["featureFile"] as { path: string; content: string };
    if (outputPaths.featureFile && file.content) {
      patches.push({ filePath: outputPaths.featureFile, fullContent: file.content });
    }
  }

  if (result["stepDefinitionFile"]) {
    const file = result["stepDefinitionFile"] as {
      path: string;
      content: string;
    };
    if (outputPaths.stepDefinition && file.content) {
      patches.push({ filePath: outputPaths.stepDefinition, fullContent: file.content });
    }
  }

  return patches;
}

function resolveFrameworkAugmentation(framework: string): TestEngineerDebugInfo["frameworkAugmentation"] {
  if (framework.startsWith("playwright")) return "playwright";
  if (framework === "cypress") return "cypress";
  if (
    framework === "selenium_java" ||
    framework === "selenium_python" ||
    framework === "junit" ||
    framework === "testng"
  ) {
    return "selenium";
  }
  if (framework === "cucumber_java") return "cucumber";
  return "none";
}

async function readExampleContents(
  files: RepoFile[],
  allFiles: RepoFile[],
  limit: number
): Promise<Array<{ path: string; content: string }>> {
  const examplePaths = files
    .slice(0, limit)
    .map((file) => file.absolutePath)
    .filter((filePath): filePath is string => typeof filePath === "string");

  const contentsMap =
    examplePaths.length > 0 ? await readProjectFiles(examplePaths) : {};
  const safeContentsMap = contentsMap ?? {};

  return Object.entries(safeContentsMap).map(([absPath, content]) => ({
    path: allFiles.find((file) => file.absolutePath === absPath)?.path ?? absPath,
    content,
  }));
}

function scoreFeatureExampleContent(content: string): number {
  let score = 0;

  if (content.includes("Scenario Outline")) score += 4;
  if (content.includes("Examples:")) score += 4;
  if (/^\s*@/m.test(content)) score += 1;

  return score;
}

function isPreferredCucumberFeaturePath(path: string): boolean {
  return path.startsWith("src/test/resources/features/");
}

async function readFeatureExampleContents(
  files: RepoFile[],
  allFiles: RepoFile[],
  framework: { framework: string }
): Promise<Array<{ path: string; content: string }>> {
  if (framework.framework !== "cucumber_java") {
    return readExampleContents(files, allFiles, 2);
  }

  const inspectedExamples = await readExampleContents(files, allFiles, 4);

  return [...inspectedExamples]
    .sort((a, b) => {
      const scoreDiff =
        scoreFeatureExampleContent(b.content) - scoreFeatureExampleContent(a.content);
      if (scoreDiff !== 0) return scoreDiff;
      const preferredPathDiff =
        Number(isPreferredCucumberFeaturePath(b.path)) -
        Number(isPreferredCucumberFeaturePath(a.path));
      if (preferredPathDiff !== 0) return preferredPathDiff;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 2);
}

function extractRouteEvidence(contents: Array<{ path: string; content: string }>): string[] {
  const evidence = new Set<string>();
  const routePattern =
    /(goto|toHaveURL|visit|navigate(?:To)?)\(\s*(?:await\s+)?(?:(["'`])([^"'`]+)\2|\/([^/\n]+(?:\/[^/\n]+)*)\/[a-z]*)/g;

  for (const entry of contents) {
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(entry.content)) !== null) {
      const literalRoute = (match[3] ?? match[4] ?? "").trim();
      if (literalRoute.length >= 2 && /[a-z]/i.test(literalRoute)) {
        evidence.add(literalRoute);
      }
    }
  }

  return [...evidence];
}

function findSuspiciousPlaywrightUrlAssertion(
  testFileContent: string,
  routeEvidence: string[]
): string | null {
  const assertions = [...testFileContent.matchAll(/toHaveURL\(\s*([^)]+)\)/g)];
  if (assertions.length === 0) return null;

  for (const assertion of assertions) {
    const rawArgument = assertion[1]?.trim() ?? "";
    const normalizedArgument = rawArgument.toLowerCase();

    if (routeEvidence.length === 0) {
      return "Generated Playwright URL assertion is not grounded in repository route evidence.";
    }

    const isGenericRegex =
      /^\/.*\/[a-z]*$/i.test(rawArgument) &&
      (!/[a-z]{2,}/i.test(rawArgument.replace(/tohaveurl/gi, "")) ||
        normalizedArgument.includes("/.*\\/#/") ||
        normalizedArgument.includes("/.*\\/?#/") ||
        normalizedArgument.includes("/.*\\/$/"));

    if (isGenericRegex) {
      return "Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.";
    }

    const matchesEvidence = routeEvidence.some((route) =>
      normalizedArgument.includes(route.toLowerCase())
    );
    if (!matchesEvidence) {
      return "Generated Playwright URL assertion does not match any repository-evidenced route.";
    }
  }

  return null;
}

function buildValidationBlockedResult(input: {
  framework: string;
  language: string;
  reason: string;
  confidence: number;
  summary: string;
  warnings: string[];
  complexity?: TestComplexity;
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  preview: string;
  debug: TestEngineerDebugInfo;
}): TestEngineerFlowResult {
  return {
    ok: false,
    framework: input.framework,
    language: input.language,
    reason: input.reason,
    confidence: Math.min(input.confidence, 35),
    decisionMode: "blocked",
    summary: input.summary,
    warnings: input.warnings,
    complexity: input.complexity,
    applyPatches: input.applyPatches,
    preview: input.preview,
    validationBlocked: true,
    debug: input.debug,
  };
}

function adjustConfidenceForWarnings(
  confidence: number,
  warnings: string[]
): number {
  if (!warnings.length) return confidence;

  let cappedConfidence = Math.min(confidence, warnings.length > 1 ? 90 : 95);
  const hasPlaceholderSelectorWarning = warnings.some((warning) =>
    warning.toLowerCase().includes("placeholder selector")
  );

  if (hasPlaceholderSelectorWarning) {
    cappedConfidence = Math.min(cappedConfidence, 80);
  }

  return cappedConfidence;
}

function hasRepoContextSelector(
  repoContext: string,
  selector: string
): boolean {
  return repoContext.toLowerCase().includes(selector.toLowerCase());
}

function calculateDeterministicConfidence(input: {
  modelConfidence?: number;
  complexity?: TestComplexity;
  warnings: string[];
  generatedContent: string;
  isNewFile: boolean;
  repoContextText: string;
  vagueTaskDetected: boolean;
}): number {
  let penalty = 0;

  if (input.complexity === "e2e") penalty += 15;
  if (input.complexity === "multi_scenario") penalty += 10;
  if (input.complexity === "data_driven") penalty += 5;

  penalty += input.warnings.length * 5;

  const hasPlaceholderSelectorWarning = input.warnings.some((warning) =>
    warning.toLowerCase().includes("placeholder selector")
  );
  if (hasPlaceholderSelectorWarning) penalty += 15;

  const lowerGeneratedContent = input.generatedContent.toLowerCase();
  const lowerRepoContext = input.repoContextText.toLowerCase();
  const hasGenericSelectors =
    lowerGeneratedContent.includes(".btn_inventory") ||
    lowerGeneratedContent.includes("adjust selector") ||
    lowerGeneratedContent.includes("your_selector") ||
    (lowerGeneratedContent.includes(".shopping_cart_link") &&
      !hasRepoContextSelector(lowerRepoContext, ".shopping_cart_link"));

  if (hasGenericSelectors) penalty += 15;

  if (input.generatedContent.length > 3000) penalty += 10;
  if (input.generatedContent.length > 5000) penalty += 10;

  const deterministicConfidence = Math.max(0, Math.min(100, 100 - penalty));
  let confidence =
    typeof input.modelConfidence === "number"
      ? Math.min(input.modelConfidence, deterministicConfidence)
      : deterministicConfidence;
  if (input.vagueTaskDetected) {
    confidence = Math.min(confidence, 60);
  }

  return confidence;
}

const VAGUE_TASK_WARNING =
  "[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior.";

const GENERIC_TASK_PHRASES = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
  "test",
  "add test",
  "write test",
]);

const GENERIC_TASK_TOKENS = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
  "test",
  "add",
  "write",
]);

const TASK_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "on",
  "in",
  "with",
  "and",
  "or",
  "my",
  "our",
  "your",
  "this",
  "that",
]);

const NON_SPECIFIC_TASK_TOKENS = new Set([
  "negative",
  "positive",
  "happy",
  "path",
  "scenario",
  "case",
  "coverage",
  "flow",
  "spec",
  "specs",
  "e2e",
  "ui",
  "page",
  "action",
  "feature",
  "component",
  "screen",
  "behavior",
  "behaviour",
]);

function normalizeTaskText(task: string): string {
  return task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/www\.[^\s]+/g, " ")
    .replace(/[a-z0-9-]+\.(com|org|net|io|dev|app|co)[^\s]*/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .trim();
}

const KNOWN_REAL_SELECTORS = [
  "#password",
  "#username",
  "#user-name",
  "#email",
  "#login-button",
  "#submit",
  "#search",
];

const GENERIC_FILENAME_TASK_TOKENS = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
  "test",
  "add",
  "write",
  "create",
  "requirements",
  "request",
  "task",
  "analyze",
  "repo",
  "prompt",
  "code",
  "agent",
  "page",
  "feature",
  "component",
  "scenario",
  "case",
  "spec",
  "specs",
]);

const NON_TARGET_FILENAME_TOKENS = new Set([
  ...GENERIC_FILENAME_TASK_TOKENS,
  "negative",
  "positive",
  "invalid",
  "valid",
  "happy",
  "path",
  "error",
  "errors",
  "credentials",
  "credential",
  "username",
  "password",
  "requirements",
  "requirement",
]);

const FILENAME_KIND_TOKENS = {
  negative: ["negative", "invalid", "error", "failure", "denied"],
  e2e: ["e2e", "journey", "integration"],
  flow: ["flow", "smoke", "sanity"],
} as const;

function isVagueTestTask(task: string): boolean {
  const normalizedTask = task.trim().toLowerCase().replace(/\s+/g, " ");
  const words = normalizedTask.split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  if (GENERIC_TASK_PHRASES.has(normalizedTask)) return true;

  const tokens = normalizedTask
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

  if (
    tokens.length > 0 &&
    tokens.every(
      (token) => GENERIC_TASK_TOKENS.has(token) || TASK_STOPWORDS.has(token)
    )
  ) {
    return true;
  }

  const hasSpecificTarget = tokens.some(
    (token) =>
      token.length >= 3 &&
      !GENERIC_TASK_TOKENS.has(token) &&
      !TASK_STOPWORDS.has(token) &&
      !NON_SPECIFIC_TASK_TOKENS.has(token)
  );

  return !hasSpecificTarget;
}

function tokenizeForFilename(task: string): string[] {
  return normalizeTaskText(task).split(/\s+/).filter(Boolean);
}

function extractSpecificFilenameTarget(task: string): string | null {
  const normalizedTask = normalizeTaskText(task);
  if (
    normalizedTask.includes("login") ||
    normalizedTask.includes("sign in") ||
    normalizedTask.includes("signin")
  ) {
    return "login";
  }
  if (
    normalizedTask.includes("auth") ||
    normalizedTask.includes("authentication")
  ) {
    return "auth";
  }

  const tokens = tokenizeForFilename(task);
  return (
    tokens.find(
      (token) =>
        token.length >= 3 &&
        !NON_TARGET_FILENAME_TOKENS.has(token) &&
        !TASK_STOPWORDS.has(token)
    ) ?? null
  );
}

function detectFilenameKind(task: string): string | null {
  const normalizedTask = normalizeTaskText(task);
  for (const [kind, tokens] of Object.entries(FILENAME_KIND_TOKENS)) {
    if (tokens.some((token) => normalizedTask.includes(token))) {
      return kind;
    }
  }
  return null;
}

function isTaskSlugLikeFilename(pathValue: string): boolean {
  const basename = path.posix
    .basename(pathValue)
    .replace(/\.(spec|test|cy)\.[a-z]+$/i, "")
    .replace(/^test_/i, "");
  const tokens = basename.split(/[^a-z0-9]+/i).filter(Boolean);
  const genericCount = tokens.filter((token) =>
    GENERIC_FILENAME_TASK_TOKENS.has(token.toLowerCase())
  ).length;

  return tokens.length > 3 || genericCount >= 2 || basename.length > 28;
}

function chooseExistingTestFileForReuse(
  existingTestFiles: RepoFile[],
  task: string
): string | null {
  if (!existingTestFiles.length) return null;
  const target = extractSpecificFilenameTarget(task);

  return [...existingTestFiles]
    .map((file) => {
      const basename = path.posix.basename(file.path).toLowerCase();
      const suspiciousPenalty = isTaskSlugLikeFilename(file.path) ? -20 : 0;
      const targetScore =
        target && basename.includes(target.toLowerCase()) ? 15 : 0;
      return {
        path: file.path,
        score: targetScore + suspiciousPenalty - basename.length / 100,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })[0]?.path ?? null;
}

function buildShortTestFilePath(currentPath: string, task: string): string {
  const parsed = path.posix.parse(currentPath);
  const extensionMatch = parsed.base.match(/(\.(?:spec|test|cy)\.[a-z]+)$/i);
  const extension = extensionMatch?.[1] ?? parsed.ext;
  const target = extractSpecificFilenameTarget(task) ?? parsed.name.split(".")[0] ?? "app";
  const kind = detectFilenameKind(task);
  const baseName =
    kind && kind !== target ? `${target}_${kind}` : target;
  return path.posix.join(parsed.dir, `${baseName}${extension}`);
}

function resolveOutputPaths(input: {
  task: string;
  outputPaths: { testFile: string; featureFile?: string; stepDefinition?: string };
  existingTestFiles: RepoFile[];
}): { testFile: string; featureFile?: string; stepDefinition?: string } {
  const currentTestFile = input.outputPaths.testFile;
  if (!currentTestFile) return input.outputPaths;

  const shouldNormalize =
    isTaskSlugLikeFilename(currentTestFile) ||
    GENERIC_TASK_PHRASES.has(normalizeTaskText(input.task));

  if (!shouldNormalize) {
    return input.outputPaths;
  }

  const specificTarget = extractSpecificFilenameTarget(input.task);
  if (!specificTarget) {
    const existingReusePath = chooseExistingTestFileForReuse(
      input.existingTestFiles,
      input.task
    );
    if (existingReusePath) {
      return { ...input.outputPaths, testFile: existingReusePath };
    }
    return input.outputPaths;
  }

  return {
    ...input.outputPaths,
    testFile: buildShortTestFilePath(currentTestFile, input.task),
  };
}

function extractQuotedSelector(message: string): string | null {
  const match = message.match(/"([^"]+)"/);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

function shouldIgnoreKnownRealSelectorIssue(issue: ValidationIssue): boolean {
  if (issue.code !== "PLAYWRIGHT_PLACEHOLDER_SELECTOR") return false;
  const selector = extractQuotedSelector(issue.message);
  return selector !== null && KNOWN_REAL_SELECTORS.includes(selector);
}

function shouldIgnoreKnownRealSelectorWarning(warning: string): boolean {
  if (!warning.toLowerCase().includes("placeholder selector")) return false;
  const selector = extractQuotedSelector(warning);
  return selector !== null && KNOWN_REAL_SELECTORS.includes(selector);
}

function summarizeValidationIssues(
  issues: ValidationIssue[]
): { decision: ValidationDecision; summary: string } {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  const decision: ValidationDecision =
    errors.length > 0 ? "blocked" : warnings.length > 0 ? "preview_only" : "pass";

  const summary =
    decision === "pass"
      ? "Validation passed - output is safe to apply"
      : decision === "preview_only"
        ? `Validation warnings (${warnings.length}) - review before applying`
        : `Validation blocked (${errors.length} error(s)) - cannot apply`;

  return { decision, summary };
}

export async function runTestEngineerFlow(input: {
  task: string;
  repoPath: string;
  onProgress?: (stage: string) => void;
}): Promise<TestEngineerFlowResult> {
  let allFiles: RepoFile[];
  try {
    input.onProgress?.("Scanning repo...");
    allFiles = await scanRepo(input.repoPath);
    if (!Array.isArray(allFiles)) {
      return {
        ok: false,
        reason: `scanRepo returned unexpected type: ${typeof allFiles}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to scan repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let framework;
  try {
    input.onProgress?.("Detecting framework...");
    framework = detectTestFramework(allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `detectTestFramework failed: ${err instanceof Error ? err.stack : String(err)}`,
    };
  }

  if (framework.framework === "unknown") {
    return {
      ok: false,
      reason:
        "Could not detect a test framework in this repository. " +
        "Supported frameworks: Playwright (TS/JS), Cypress, Cucumber+Java, " +
        "Selenium (Java/Python), TestNG, pytest.",
      framework: "unknown",
    };
  }

  let context;
  try {
    context = buildTestEngineerContext(input.task, framework, allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `buildTestEngineerContext failed: ${err instanceof Error ? err.stack : String(err)}`,
    };
  }

  const resolvedOutputPaths = resolveOutputPaths({
    task: input.task,
    outputPaths: context.outputPaths,
    existingTestFiles: context.existingTestFiles,
  });

  const debug: TestEngineerDebugInfo = {
    selectedRole: "test_engineer",
    promptPipeline: "buildTestEngineerPrompt",
    finalPromptBuilder: "buildFinalPrompt",
    detectedFramework: framework.framework,
    frameworkAugmentation: resolveFrameworkAugmentation(framework.framework),
    contextSelection: context.debug ?? null,
    outputPathDecision: {
      finalTestFilePath: resolvedOutputPaths.testFile ?? null,
      finalPathSource: "deterministic_context",
      rawModelTestFilePath: null,
      rawModelFeatureFilePath: null,
      rawModelStepDefinitionPath: null,
      rawModelPathDiffers: false,
    },
    suspiciousFilenameFiltering: {
      triggered: Boolean(context.debug?.suspiciousFilenameRejected),
      generatedSlug: context.debug?.generatedSlug ?? null,
      safeSlug: context.debug?.safeSlug ?? null,
    },
    playwrightUrlAssertionGuard: {
      checked: false,
      triggered: false,
      reason: null,
      routeEvidence: [],
    },
  };

  const pageObjectContents = await readExampleContents(
    context.pageObjectFiles,
    allFiles,
    3
  );
  const stepDefinitionContents = await readExampleContents(
    context.stepDefinitionFiles,
    allFiles,
    2
  );
  const featureContents = await readFeatureExampleContents(
    context.featureFiles,
    allFiles,
    framework
  );
  const existingTestContents = await readExampleContents(
    context.existingTestFiles,
    allFiles,
    3
  );

  input.onProgress?.("Building prompt...");
  const prompt = buildTestEngineerPrompt({
    task: input.task,
    context: {
      ...context,
      outputPaths: resolvedOutputPaths,
    },
    pageObjectContents,
    stepDefinitionContents,
    featureContents,
    existingTestContents,
  }) +
    "\n\nIMPORTANT: Do NOT rewrite or modify any existing tests.\n" +
    "Only add NEW test blocks that do not exist in the file.\n" +
    "If a similar test already exists, skip it and add a different scenario.";

  let parsed: Record<string, unknown>;
  try {
    input.onProgress?.("Generating patch...");
    const client = createOpenAIClient();
    const model = getModelName();
    const response = await client.responses.create({ model, input: prompt });
    const rawText = response.output_text || "";
    const jsonText = extractJson(rawText);
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      framework: framework.framework,
    };
  }

  const rawModelTestFilePath =
    (parsed["testFile"] as { path?: string } | undefined)?.path ?? null;
  const rawModelFeatureFilePath =
    (parsed["featureFile"] as { path?: string } | undefined)?.path ?? null;
  const rawModelStepDefinitionPath =
    (parsed["stepDefinitionFile"] as { path?: string } | undefined)?.path ?? null;
  debug.outputPathDecision = {
    finalTestFilePath: resolvedOutputPaths.testFile ?? null,
    finalPathSource:
      rawModelTestFilePath && rawModelTestFilePath !== resolvedOutputPaths.testFile
        ? "deterministic_context_override"
        : rawModelTestFilePath
          ? "deterministic_context"
          : "model_output",
    rawModelTestFilePath,
    rawModelFeatureFilePath,
    rawModelStepDefinitionPath,
    rawModelPathDiffers:
      Boolean(rawModelTestFilePath && rawModelTestFilePath !== resolvedOutputPaths.testFile) ||
      Boolean(
        rawModelFeatureFilePath &&
          resolvedOutputPaths.featureFile &&
          rawModelFeatureFilePath !== resolvedOutputPaths.featureFile
      ) ||
      Boolean(
        rawModelStepDefinitionPath &&
          resolvedOutputPaths.stepDefinition &&
          rawModelStepDefinitionPath !== resolvedOutputPaths.stepDefinition
      ),
  };

  const rawModelWarnings = Array.isArray(parsed["warnings"])
    ? (parsed["warnings"] as string[])
    : [];
  const internalWarnings: string[] = [];
  const modelWarnings = rawModelWarnings.filter(
    (warning) => !shouldIgnoreKnownRealSelectorWarning(warning)
  );
  const postProcessingWarnings: string[] = [];
  const originalContentByPath = new Map<string, string>([
    ...existingTestContents.map((file) => [file.path, file.content] as const),
    ...featureContents.map((file) => [file.path, file.content] as const),
    ...stepDefinitionContents.map((file) => [file.path, file.content] as const),
  ]);
  let applyPatches = buildApplyPatches(parsed, resolvedOutputPaths).map((patch) => {
    if (patch.filePath !== resolvedOutputPaths.testFile) {
      return patch;
    }

    const finalized = finalizeGeneratedTestContent({
      fullContent: patch.fullContent,
      originalContent: originalContentByPath.get(patch.filePath) ?? "",
    });

    if (finalized.warnings.length > 0) {
      internalWarnings.push(...finalized.warnings);
    }

    return {
      ...patch,
      fullContent: finalized.fullContent,
    };
  });
  const preview = buildPreview(
    {
      ...parsed,
      warnings: [...modelWarnings, ...postProcessingWarnings],
    },
    framework.framework,
    resolvedOutputPaths
  );
  const { complexity } = detectTestComplexity(input.task);
  const modelConfidence =
    typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
  const summary =
    typeof parsed["summary"] === "string"
      ? parsed["summary"]
      : "Test generated successfully.";
  const vagueTaskDetected = isVagueTestTask(input.task);
  const warnings = vagueTaskDetected
    ? [...modelWarnings, ...postProcessingWarnings, VAGUE_TASK_WARNING]
    : [...modelWarnings, ...postProcessingWarnings];
  const repoContextText = [
    ...existingTestContents.map((file) => file.content),
    ...pageObjectContents.map((file) => file.content),
    ...stepDefinitionContents.map((file) => file.content),
    ...featureContents.map((file) => file.content),
  ].join("\n\n");
  const generatedContent = applyPatches.map((patch) => patch.fullContent).join("\n\n");
  const isNewFile = applyPatches.some((patch) => {
    const originalContent = originalContentByPath.get(patch.filePath) ?? "";
    return !originalContent.trim();
  });
  const confidence = calculateDeterministicConfidence({
    modelConfidence,
    complexity,
    warnings,
    generatedContent,
    isNewFile,
    repoContextText,
    vagueTaskDetected,
  });
  const confidenceGate = checkConfidenceGate({
    confidenceScore: confidence,
    role: "test_engineer",
    framework: framework.framework,
    warnings,
  });

  if (!confidenceGate.pass && applyPatches.length > 0) {
    const exportErrors = applyPatches.filter((patch) =>
      patch.fullContent.includes("export default new ")
    );
    for (const patch of exportErrors) {
      patch.fullContent = patch.fullContent.replace(
        /export default new (\w+)\(\)/g,
        "export default $1"
      );
    }
  }
// 9. Validate output
  const featurePatch = applyPatches.find(p => p.filePath.endsWith(".feature"));
  const stepPatch = applyPatches.find(p => p.filePath.endsWith(".java"));

const testFilePatch = applyPatches.find(
  p =>
    p.filePath.endsWith(".spec.ts") ||
    p.filePath.endsWith(".spec.js") ||
    p.filePath.endsWith(".test.ts") ||
    p.filePath.endsWith(".test.js") ||
    p.filePath.endsWith(".cy.ts") ||
    p.filePath.endsWith(".cy.js") ||
    p.filePath.endsWith(".py")
);

input.onProgress?.("Validating output...");
const validation = validateTestOutput({
  featureContent: featurePatch?.fullContent,
  stepDefinitionContent: stepPatch?.fullContent,
  testFileContent: testFilePatch?.fullContent,
  pageObjectContents: pageObjectContents,
  framework: framework.framework,
  complexityHint: complexity,
});
const filteredValidationIssues = validation.issues.filter(
  (issue) => !shouldIgnoreKnownRealSelectorIssue(issue)
);
const filteredValidation = {
  ...validation,
  issues: filteredValidationIssues,
  ...summarizeValidationIssues(filteredValidationIssues),
};
if (filteredValidation.decision !== "pass" || filteredValidation.issues.length > 0) {
  console.log(`[zone:validate] Decision: ${filteredValidation.decision}`);
  for (const issue of filteredValidation.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}
  if (
    framework.framework.startsWith("playwright") &&
    testFilePatch?.fullContent
  ) {
    const routeEvidence = extractRouteEvidence([
      ...existingTestContents,
      ...pageObjectContents,
    ]);
    const playwrightUrlAssertionIssue = findSuspiciousPlaywrightUrlAssertion(
      testFilePatch.fullContent,
      routeEvidence
    );

    if (playwrightUrlAssertionIssue) {
      debug.playwrightUrlAssertionGuard = {
        checked: true,
        triggered: true,
        reason: playwrightUrlAssertionIssue,
        routeEvidence,
      };
      return buildValidationBlockedResult({
        framework: framework.framework,
        language: framework.language,
        reason: `Output validation blocked: ${playwrightUrlAssertionIssue}`,
        confidence,
        summary,
        warnings,
        complexity,
        applyPatches,
        preview,
        debug,
      });
    }
    debug.playwrightUrlAssertionGuard = {
      checked: true,
      triggered: false,
      reason: null,
      routeEvidence,
    };
  }
  if (filteredValidation.decision === "blocked") {
    return buildValidationBlockedResult({
      framework: framework.framework,
      language: framework.language,
      reason:
        `Output validation blocked: ${filteredValidation.summary}\n` +
        filteredValidation.issues
          .filter(i => i.severity === "error")
          .map(i => `  - ${i.message}`)
          .join("\n"),
      confidence,
      summary,
      warnings,
      complexity,
      applyPatches,
      preview,
      debug,
    });
  }

  const validationWarnings = filteredValidation.issues
    .filter(i => i.severity === "warning")
    .map(i => `[${i.code}] ${i.message}`);
  applyPatches = applyPatches.map((patch) => {
    if (patch.filePath !== resolvedOutputPaths.testFile) {
      return patch;
    }

    const originalContent = originalContentByPath.get(patch.filePath) ?? "";
    const originalTestCount = countTestBlocks(originalContent);
    if (originalTestCount === 0) {
      return patch;
    }

    const safeContent = safeAppendToExisting(
      originalContent,
      patch.fullContent
    );

    if (safeContent !== patch.fullContent) {
      internalWarnings.push(
        "[TEST_CONTENT_PRESERVED] Existing tests were preserved and the new test content was appended safely."
      );
      return {
        ...patch,
        fullContent: safeContent,
      };
    }

    return patch;
  });
  const fileDiffs = applyPatches.map((patch) => {
    const originalContent = originalContentByPath.get(patch.filePath) ?? "";
    const diff = computeFileDiff(originalContent, patch.fullContent);
    return {
      filePath: patch.filePath,
      addedLines: diff.filter((line) => line.type === "added").length,
      removedLines: diff.filter((line) => line.type === "removed").length,
      diff,
    };
  });
  const finalWarnings = [...warnings, ...validationWarnings];
  const finalGeneratedContent = applyPatches
    .map((patch) => patch.fullContent)
    .join("\n\n");
  const finalConfidence = calculateDeterministicConfidence({
    modelConfidence,
    complexity,
    warnings: finalWarnings,
    generatedContent: finalGeneratedContent,
    isNewFile,
    repoContextText,
    vagueTaskDetected,
  });
input.onProgress?.("Ready");
  return {
    ok: true,
    framework: framework.framework,
    language: framework.language,
    confidence: finalConfidence,
    decisionMode:
      vagueTaskDetected || finalConfidence < 70 ? "preview_only" : "safe_to_apply",
    summary,
    warnings: finalWarnings,
    complexity,
    applyPatches,
    fileDiffs,
    preview,
    debug,
  };
}
