import { describe, expect, it } from "vitest";
import { classifyPatchIntent } from "./classifyPatchIntent.js";

describe("classifyPatchIntent", () => {
  it("returns rename_symbol for rename-related tasks", () => {
    expect(classifyPatchIntent("rename helper function")).toBe("rename_symbol");
    expect(classifyPatchIntent("Rename variable in utils")).toBe("rename_symbol");
    expect(classifyPatchIntent("change name of method")).toBe("rename_symbol");
    expect(classifyPatchIntent("rename class in parser module")).toBe("rename_symbol");
  });

  it("returns update_import for import-related tasks", () => {
    expect(classifyPatchIntent("update import path in api client")).toBe("update_import");
    expect(classifyPatchIntent("fix import after file move")).toBe("update_import");
    expect(classifyPatchIntent("change import in service")).toBe("update_import");
    expect(classifyPatchIntent("adjust import for renamed module")).toBe("update_import");
  });

  it("returns add_comment for comment-related tasks", () => {
    expect(classifyPatchIntent("add comment to explain fallback")).toBe("add_comment");
    expect(classifyPatchIntent("insert comment above helper")).toBe("add_comment");
    expect(classifyPatchIntent("append comment to file")).toBe("add_comment");
    expect(classifyPatchIntent("document with comment")).toBe("add_comment");
  });

  it("returns safe_replace for replace-related tasks", () => {
    expect(classifyPatchIntent("replace exact text in config")).toBe("safe_replace");
    expect(classifyPatchIntent("safe replace deprecated label")).toBe("safe_replace");
    expect(classifyPatchIntent("replace string in constants")).toBe("safe_replace");
    expect(classifyPatchIntent("update text in README")).toBe("safe_replace");
  });

  it("returns unknown for unsupported tasks", () => {
    expect(classifyPatchIntent("refactor authentication flow")).toBe("unknown");
    expect(classifyPatchIntent("rewrite business logic")).toBe("unknown");
    expect(classifyPatchIntent("optimize performance")).toBe("unknown");
    expect(classifyPatchIntent("restructure project architecture")).toBe("unknown");
  });

  it("returns unknown for empty or whitespace-only tasks", () => {
    expect(classifyPatchIntent("")).toBe("unknown");
    expect(classifyPatchIntent("   ")).toBe("unknown");
    expect(classifyPatchIntent("\n\t")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyPatchIntent("RENAME HELPER FUNCTION")).toBe("rename_symbol");
    expect(classifyPatchIntent("ADD COMMENT TO FILE")).toBe("add_comment");
    expect(classifyPatchIntent("FIX IMPORT PATH")).toBe("update_import");
    expect(classifyPatchIntent("REPLACE EXACT TEXT")).toBe("safe_replace");
  });

it("applies deterministic category precedence when multiple intents match", () => {
  expect(classifyPatchIntent("rename function and update import")).toBe("update_import");
  expect(classifyPatchIntent("add comment and replace text")).toBe("add_comment");
});

  it("applies deterministic category precedence when multiple intents match", () => {
  expect(classifyPatchIntent("rename function and update import")).toBe("update_import");
  expect(classifyPatchIntent("add comment and replace text")).toBe("add_comment");
});
});