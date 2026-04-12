import { describe, expect, it } from "vitest";
import { buildFullPatchPrompt } from "./fullPatchPrompt.js";

const BASE_INPUT = {
  task: "Add a null check before calling process()",
  filePath: "src/core/processor.ts",
  fileContent: "export function process(input: string) { return input.trim(); }",
  repoSummary: "TypeScript monorepo with strict mode enabled.",
  relatedContext: "Called from src/cli/index.ts line 42.",
};

describe("buildFullPatchPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes the task", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.task);
  });

  it("includes the filePath", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.filePath);
  });

  it("includes the fileContent", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.fileContent);
  });

  it("includes the repoSummary", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.repoSummary);
  });

  it("includes the relatedContext", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain(BASE_INPUT.relatedContext);
  });

  it("includes the OUTPUT FORMAT JSON shape", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain('"filePath"');
    expect(prompt).toContain('"fullContent"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"warnings"');
  });

  it("instructs to return COMPLETE updated file content", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain("COMPLETE updated file content");
  });

  it("instructs not to add markdown fences", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain("Do not add markdown fences");
  });

  it("instructs to preserve unrelated code", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain("Preserve all existing code that is unrelated");
  });

  it("supports find/replace patch mode for large files", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      outputMode: "find_replace_patch",
    });
    expect(prompt).toContain("Return ONLY the specific change as a FIND/REPLACE patch");
    expect(prompt).toContain("--- FIND ---");
    expect(prompt).toContain("--- REPLACE ---");
  });

  it("instructs to return JSON only", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain("Return JSON only");
  });

  it("output is deterministic — same input produces same output", () => {
    const a = buildFullPatchPrompt(BASE_INPUT);
    const b = buildFullPatchPrompt(BASE_INPUT);
    expect(a).toBe(b);
  });

  it("different inputs produce different outputs", () => {
    const a = buildFullPatchPrompt(BASE_INPUT);
    const b = buildFullPatchPrompt({ ...BASE_INPUT, task: "Remove the process() call entirely" });
    expect(a).not.toBe(b);
  });

  it("file content is wrapped in code fences in the prompt", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).toContain("```");
    // content appears between the fences
    const fenceIdx = prompt.indexOf("```");
    const contentIdx = prompt.indexOf(BASE_INPUT.fileContent);
    expect(contentIdx).toBeGreaterThan(fenceIdx);
  });

  it("adds UI / design system rules for UI-facing patch tasks", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      task: "adjust spacing in the card layout",
      filePath: "src/components/Card.tsx",
      fileContent: '<div className="card"><button>Run</button></div>',
    });

    expect(prompt).toContain("UI / DESIGN SYSTEM RULES:");
    expect(prompt).toContain(
      "Prefer existing className-based styling over inline styles"
    );
    expect(prompt).toContain(
      "Preserve existing component structure unless the task explicitly requires structural change"
    );
  });

  it("adds strict micro-edit constraints when normalized intent is micro_edit", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      task: "fix spacing in the card",
      filePath: "src/components/Card.tsx",
      fileContent: '<div className="card">Zone</div>',
      normalizedTaskIntent: "micro_edit",
    });

    expect(prompt).toContain("MICRO-EDIT CONSTRAINTS:");
    expect(prompt).toContain("Modify as few lines as possible");
    expect(prompt).toContain("Do not rewrite the component");
    expect(prompt).toContain("Do not modify multiple files unless absolutely necessary");
    expect(prompt).toContain(
      "If a small class-based change is possible, prefer that over ad-hoc styling"
    );
  });
});
