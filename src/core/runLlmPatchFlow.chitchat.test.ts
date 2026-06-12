import { describe, it, expect } from "vitest";
import { isChitchat, classifyChitchat } from "./runLlmPatchFlow.js";

describe("classifyChitchat", () => {
  it("greeting tokens → greeting", () => {
    expect(classifyChitchat("hello")).toBe("greeting");
    expect(classifyChitchat("hey")).toBe("greeting");
    expect(classifyChitchat("good morning")).toBe("greeting");
    expect(classifyChitchat("hi")).toBe("greeting");
  });

  it("gratitude tokens → gratitude", () => {
    expect(classifyChitchat("thanks")).toBe("gratitude");
    expect(classifyChitchat("thank you")).toBe("gratitude");
    expect(classifyChitchat("cheers")).toBe("gratitude");
  });

  it("farewell tokens → farewell", () => {
    expect(classifyChitchat("bye")).toBe("farewell");
    expect(classifyChitchat("goodbye")).toBe("farewell");
    expect(classifyChitchat("cya later")).toBe("farewell");
  });

  it("farewell wins over gratitude (priority)", () => {
    expect(classifyChitchat("bye thanks")).toBe("farewell");
  });
});

describe("chitchat gate — multi-word tasks not caught", () => {
  it("hello can you refactor auth.ts — isChitchat false (>4 words)", () => {
    expect(isChitchat("hello can you refactor auth.ts")).toBe(false);
  });

  it("fix the bug in auth.ts — isChitchat false", () => {
    expect(isChitchat("fix the bug in auth.ts")).toBe(false);
  });
});
