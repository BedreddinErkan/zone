import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectIntent,
  detectMessageType,
  shouldUseInvestigationMode,
} from "./detectIntent.js";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

const applyPatchTraceTask =
  "Trace the apply_patch tool end-to-end. Cover dispatch, validation, execution, verification, finalization. For each stage, give file:line references.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("detectMessageType", () => {
  it("classifies apply_patch trace tasks as questions even when the model says patch_request", async () => {
    mocks.createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: '{ "type": "patch_request" }' } }],
    });

    await expect(detectMessageType(applyPatchTraceTask)).resolves.toBe("question");

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).toContain("trace, explain, describe");
    expect(prompt).toContain("Only classify as patch_request when the deliverable is a CODE CHANGE");
  });
});

describe("detectIntent", () => {
  it("routes apply_patch trace tasks to investigation", async () => {
    mocks.createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: '{ "type": "patch_request" }' } }],
    });

    await expect(detectIntent(applyPatchTraceTask)).resolves.toBe("investigation");
  });
});

describe("shouldUseInvestigationMode", () => {
  it("routes identifier usage questions to investigation", () => {
    expect(
      shouldUseInvestigationMode(
        "What does getRunCost return and which files use it?",
        "question"
      )
    ).toBe(true);
  });

  it("keeps trivial chat on the cheap chat path", () => {
    expect(shouldUseInvestigationMode("hi", "question")).toBe(false);
    expect(shouldUseInvestigationMode("what does Zone do?", "question")).toBe(false);
  });

  it("keeps generic discussion on the chat path", () => {
    expect(
      shouldUseInvestigationMode(
        "what's the best way to handle async errors?",
        "discussion"
      )
    ).toBe(false);
  });

  it("routes codebase flow questions to investigation", () => {
    expect(
      shouldUseInvestigationMode(
        "how does the apply_patch flow work end to end?",
        "question"
      )
    ).toBe(true);
  });

  it("routes staged trace questions with line references to investigation", () => {
    expect(shouldUseInvestigationMode(applyPatchTraceTask, "question")).toBe(true);
  });

  it("never routes patch requests to investigation", () => {
    expect(
      shouldUseInvestigationMode("Add a one-line comment to README.md", "patch_request")
    ).toBe(false);
  });
});
