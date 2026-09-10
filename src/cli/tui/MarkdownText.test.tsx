import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "./components/MarkdownText.js";

function renderMd(text: string): string {
  const { lastFrame } = render(<MarkdownText text={text} />);
  return lastFrame() ?? "";
}

describe("TUI.10.C: MarkdownText component", () => {
  it("## heading renders without ## prefix", () => {
    const frame = renderMd("## What changed");
    expect(frame).not.toContain("##");
    expect(frame).toContain("What changed");
  });

  it("### heading also strips prefix and preserves content", () => {
    const frame = renderMd("### Sub-section");
    expect(frame).not.toContain("###");
    expect(frame).toContain("Sub-section");
  });

  it("- bullet renders with • prefix, no leading dash", () => {
    const frame = renderMd("- Added util function");
    expect(frame).toContain("•");
    expect(frame).toContain("Added util function");
    expect(frame).not.toMatch(/^- /m);
  });

  it("* bullet also renders with • prefix", () => {
    const frame = renderMd("* Another bullet");
    expect(frame).toContain("•");
    expect(frame).toContain("Another bullet");
  });

  it("**bold** renders without ** markers", () => {
    const frame = renderMd("This is **important** text");
    expect(frame).not.toContain("**");
    expect(frame).toContain("important");
    expect(frame).toContain("This is");
    expect(frame).toContain("text");
  });

  it("`code` renders without backtick markers", () => {
    const frame = renderMd("Run `npm test` to verify");
    expect(frame).not.toContain("`");
    expect(frame).toContain("npm test");
    expect(frame).toContain("Run");
    expect(frame).toContain("to verify");
  });

  it("mixed block: heading + bullet + prose all render correctly", () => {
    const text = [
      "## What changed",
      "- Added `group` utility",
      "",
      "Prose explanation here.",
    ].join("\n");
    const frame = renderMd(text);
    expect(frame).not.toContain("##");
    expect(frame).toContain("What changed");
    expect(frame).toContain("•");
    expect(frame).toContain("Added");
    expect(frame).toContain("group");
    expect(frame).toContain("Prose explanation here.");
  });

  it("blank lines render without ## or - artefacts", () => {
    const frame = renderMd("\n\n");
    expect(frame).not.toContain("##");
    expect(frame).not.toMatch(/^- /m);
  });

  it("plain prose renders unchanged", () => {
    const frame = renderMd("Plan called for both utilities plus barrel update.");
    expect(frame).toContain("Plan called for both utilities plus barrel update.");
  });

  // Phase 6d — fenced code blocks
  it("fenced code block renders with dim bar and indent", () => {
    const text = [
      "```typescript",
      "function hello() {",
      "  return 'world';",
      "}",
      "```",
    ].join("\n");
    const frame = renderMd(text);
    // Fence lines (```) should not appear in output
    expect(frame).not.toContain("```");
    // Code content should be present
    expect(frame).toContain("function hello()");
    expect(frame).toContain("return 'world';");
    // Dim bar character (separator glyph: "─") should be present
    expect(frame).toContain("─");
  });

  it("unclosed fence at EOF closes implicitly", () => {
    const text = [
      "```",
      "some code here",
      // No closing ```
    ].join("\n");
    const frame = renderMd(text);
    expect(frame).not.toContain("```");
    expect(frame).toContain("some code here");
  });

  it("code line indentation preserved", () => {
    const text = [
      "```",
      "if (true) {",
      "  nested();",
      "    deep();",
      "}",
      "```",
    ].join("\n");
    const frame = renderMd(text);
    expect(frame).toContain("if (true)");
    expect(frame).toContain("nested()");
    expect(frame).toContain("deep()");
  });

  // Phase 6d — numbered lists
  it("numbered list renders with number prefix", () => {
    const text = [
      "1. First item",
      "2. Second item",
      "3. Third item",
    ].join("\n");
    const frame = renderMd(text);
    expect(frame).toContain("1.");
    expect(frame).toContain("First item");
    expect(frame).toContain("2.");
    expect(frame).toContain("Second item");
    expect(frame).toContain("3.");
    expect(frame).toContain("Third item");
  });

  // Phase 6d — inline links
  it("[text](url) renders text followed by muted url", () => {
    const frame = renderMd("See [the docs](https://example.com) for details");
    expect(frame).not.toContain("[");
    expect(frame).not.toContain("](");
    expect(frame).toContain("the docs");
    expect(frame).toContain("https://example.com");
    expect(frame).toContain("See");
    expect(frame).toContain("for details");
  });

  // Phase 6d — mixed document
  it("mixed document: heading + fence + list + link", () => {
    const text = [
      "## Summary",
      "",
      "```",
      "const x = 1;",
      "```",
      "",
      "1. Step one",
      "2. Step two",
      "",
      "See [example](https://test.com) for more.",
    ].join("\n");
    const frame = renderMd(text);
    expect(frame).toContain("Summary");
    expect(frame).toContain("const x = 1");
    expect(frame).toContain("1.");
    expect(frame).toContain("Step one");
    expect(frame).toContain("example");
    expect(frame).toContain("https://test.com");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("```");
  });
});
