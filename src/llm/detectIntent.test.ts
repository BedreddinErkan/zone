import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectIntent,
  detectMessageType,
  looksLikePatchImperative,
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

describe("looksLikePatchImperative (bug Y — multi-language)", () => {
  it("matches Turkish imperatives (verb at end)", () => {
    expect(looksLikePatchImperative("body background-color'ını radial-gradient yap")).toBe(true);
    expect(looksLikePatchImperative("src/utils/files.ts'in başına yorum ekle: // Test")).toBe(true);
    expect(looksLikePatchImperative("body background'unu mavi yap")).toBe(true);
    expect(looksLikePatchImperative("şu hatayı düzelt")).toBe(true);
  });

  it("matches English imperatives (verb at start)", () => {
    expect(looksLikePatchImperative("Change body bg to #1a1a2e")).toBe(true);
    expect(looksLikePatchImperative("Fix the bug in line 42")).toBe(true);
    expect(looksLikePatchImperative("Add a flag to the parser")).toBe(true);
  });

  it("matches Spanish imperatives", () => {
    expect(looksLikePatchImperative("Cambia el color de fondo a azul")).toBe(true);
    expect(looksLikePatchImperative("Añade un comentario al archivo")).toBe(true);
  });

  it("does not match questions (TR/EN)", () => {
    expect(looksLikePatchImperative("Neden bu test fail ediyor?")).toBe(false);
    expect(looksLikePatchImperative("How does the auth flow work?")).toBe(false);
    expect(looksLikePatchImperative("Nasıl çalışıyor bu modül?")).toBe(false);
    expect(looksLikePatchImperative("Bu fonksiyon ne yapıyor?")).toBe(false);
    expect(looksLikePatchImperative("Explain the dispatch logic")).toBe(false);
  });

  it("does not match Turkish question particles (mı/mi/mu/mü)", () => {
    expect(looksLikePatchImperative("Bu kod doğru mu?")).toBe(false);
  });
});

describe("detectMessageType — bug Y multi-language overrides", () => {
  function mockLLM(type: "patch_request" | "question" | "discussion") {
    mocks.createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: `{ "type": "${type}" }` } }],
    });
  }

  it("overrides LLM 'question' to 'patch_request' for Turkish imperatives", async () => {
    mockLLM("question");
    await expect(
      detectMessageType("body background-color'ını radial-gradient yap")
    ).resolves.toBe("patch_request");
  });

  it("overrides LLM 'discussion' to 'patch_request' for Turkish imperatives with paths", async () => {
    mockLLM("discussion");
    await expect(
      detectMessageType("src/utils/files.ts'in başına yorum ekle: // Test")
    ).resolves.toBe("patch_request");
  });

  it("keeps Turkish questions as 'question'", async () => {
    mockLLM("question");
    await expect(detectMessageType("Neden bu test fail ediyor?")).resolves.toBe("question");
  });

  it("keeps English questions as 'question' even when LLM is wrong", async () => {
    mockLLM("question");
    await expect(detectMessageType("How does the auth flow work?")).resolves.toBe("question");
  });

  it("keeps English imperatives as patch_request when LLM agrees", async () => {
    mockLLM("patch_request");
    await expect(detectMessageType("Change body bg to #1a1a2e")).resolves.toBe("patch_request");
    await expect(detectMessageType("Fix the bug in line 42")).resolves.toBe("patch_request");
  });
});

describe("detectIntent — bug Y end-to-end routing", () => {
  function mockLLM(type: "patch_request" | "question" | "discussion") {
    mocks.createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: `{ "type": "${type}" }` } }],
    });
  }

  it("Turkish imperative routes to execute (patch path)", async () => {
    mockLLM("question");
    await expect(
      detectIntent("body background-color'ını radial-gradient yap")
    ).resolves.toBe("execute");
  });

  it("Turkish imperative with file path routes to execute (not investigation)", async () => {
    mockLLM("question");
    await expect(
      detectIntent("src/utils/files.ts'in başına yorum ekle: // Test")
    ).resolves.toBe("execute");
  });

  it("Turkish question routes to chat (not patch)", async () => {
    mockLLM("question");
    await expect(detectIntent("Neden bu test fail ediyor?")).resolves.toBe("chat");
  });

  it("English question routes to chat", async () => {
    mockLLM("question");
    await expect(detectIntent("How does the auth flow work?")).resolves.toBe("chat");
  });

  it("English imperative routes to execute", async () => {
    mockLLM("patch_request");
    await expect(detectIntent("Change body bg to #1a1a2e")).resolves.toBe("execute");
    mockLLM("patch_request");
    await expect(detectIntent("Fix the bug in line 42")).resolves.toBe("execute");
  });
});
