import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLlmPatchFlow } from "./runLlmPatchFlow.js";

// Chitchat zero-call fixture: isChitchat() at runLlmPatchFlow.ts:5133 short-circuits
// before any agent loop invocation — zero createChatCompletion calls fire.

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-chitchat-"));
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("chitchat zero-call invariant", () => {
  it("zero createChatCompletion calls for 'hi'", async () => {
    const result = await runLlmPatchFlow({ task: "hi", repoPath });

    expect(mocks.createChatCompletion.mock.calls.length).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisionMode).toBe("chat");
      expect(typeof result.chatResponse).toBe("string");
    }
  });

  it("zero createChatCompletion calls for 'thanks!'", async () => {
    const result = await runLlmPatchFlow({ task: "thanks!", repoPath });

    expect(mocks.createChatCompletion.mock.calls.length).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisionMode).toBe("chat");
    }
  });

  it("zero createChatCompletion calls for a farewell", async () => {
    const result = await runLlmPatchFlow({ task: "bye", repoPath });

    expect(mocks.createChatCompletion.mock.calls.length).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisionMode).toBe("chat");
    }
  });
});
