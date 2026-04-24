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
    expect(prompt).toContain("Preserve ALL existing code that is unrelated");
  });

  it("supports find/replace patch mode for large files", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      outputMode: "find_replace_patch",
    });
    expect(prompt).toContain("REQUIRED OUTPUT FORMAT");
    expect(prompt).toContain("ONLY a patch");
    expect(prompt).toContain("--- FILE:");
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

  it("adds scope control rules for small targeted UI tasks", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      task: "adjust spacing on one card in the dashboard",
      filePath: "src/components/DashboardCard.tsx",
      fileContent: '<div className="card"><button>Open</button></div>',
    });

    expect(prompt).toContain("SCOPE CONTROL FOR SMALL UI TASKS:");
    expect(prompt).toContain(
      "Apply the change only to the most relevant instance"
    );
    expect(prompt).toContain(
      "Avoid repeating the same change across all similar components"
    );
    expect(prompt).toContain(
      "Avoid turning a local tweak into a section-wide restyling"
    );
    expect(prompt).toContain(
      "Modify only one relevant instance unless the task explicitly requires broader consistency"
    );
    expect(prompt).toContain(
      "Do not apply the same change to every similar card, item, or section"
    );
    expect(prompt).toContain(
      "Do not convert a small local tweak into a repeated batch edit"
    );
  });

  it("applies stricter scope control for micro-edit UI tasks", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      task: "make a tiny spacing fix",
      filePath: "src/components/Card.tsx",
      fileContent: '<div className="card">Zone</div>',
      normalizedTaskIntent: "micro_edit",
    });

    expect(prompt).toContain("SCOPE CONTROL FOR SMALL UI TASKS:");
    expect(prompt).toContain(
      "Modify only one relevant instance unless the task explicitly requires broader consistency"
    );
    expect(prompt).toContain(
      "Do not apply the same change to every similar card, item, or section"
    );
    expect(prompt).toContain(
      "Do not convert a small local tweak into a repeated batch edit"
    );
  });

  it("does not add scope control rules for non-targeted backend tasks", () => {
    const prompt = buildFullPatchPrompt(BASE_INPUT);
    expect(prompt).not.toContain("SCOPE CONTROL FOR SMALL UI TASKS:");
  });

  it("does not add the strictest small-scope phrasing for broader UI tasks", () => {
    const prompt = buildFullPatchPrompt({
      ...BASE_INPUT,
      task: "redesign the dashboard layout for better hierarchy",
      filePath: "src/components/Dashboard.tsx",
      fileContent:
        '<section className="dashboard"><div className="card">Metrics</div></section>',
    });

    expect(prompt).toContain("UI / DESIGN SYSTEM RULES:");
    expect(prompt).not.toContain("SCOPE CONTROL FOR SMALL UI TASKS:");
    expect(prompt).not.toContain(
      "Modify only one relevant instance unless the task explicitly requires broader consistency"
    );
  });
});
