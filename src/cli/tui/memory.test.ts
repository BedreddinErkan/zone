import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";

const mockReadFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({
  promises: { readFile: mockReadFile },
}));

import { readMemoryAndShow } from "./memory.js";

function makeDispatch(): { dispatch: Dispatch<StoreAction>; calls: StoreAction[] } {
  const calls: StoreAction[] = [];
  const dispatch: Dispatch<StoreAction> = (a) => { calls.push(a); };
  return { dispatch, calls };
}

function userPromptTexts(calls: StoreAction[]): string[] {
  return calls
    .filter(a => a.type === "USER_PROMPT")
    .map(a => (a as { type: "USER_PROMPT"; text: string }).text);
}

beforeEach(() => {
  mockReadFile.mockReset();
});

describe("readMemoryAndShow", () => {
  it("T1: ENOENT dispatches helpful 'not found' message", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValueOnce(err);
    const { dispatch, calls } = makeDispatch();
    await readMemoryAndShow("/fake/cwd", dispatch);
    const texts = userPromptTexts(calls);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("No .zone/memory.md found");
    expect(texts[0]).toContain("/init");
  });

  it("T2: small file dispatches single combined message with header and content, no warning", async () => {
    const content = "# Project\nThis is a test.";
    mockReadFile.mockResolvedValueOnce(content);
    const { dispatch, calls } = makeDispatch();
    await readMemoryAndShow("/fake/cwd", dispatch);
    const texts = userPromptTexts(calls);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(".zone/memory.md");
    expect(texts[0]).toContain(content);
    expect(texts[0]).not.toContain("⚠️");
  });

  it("T3: file >40K dispatches single combined message including warning", async () => {
    const content = "a".repeat(41000);
    mockReadFile.mockResolvedValueOnce(content);
    const { dispatch, calls } = makeDispatch();
    await readMemoryAndShow("/fake/cwd", dispatch);
    const texts = userPromptTexts(calls);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("⚠️");
    expect(texts[0]).toContain("40K");
  });
});
