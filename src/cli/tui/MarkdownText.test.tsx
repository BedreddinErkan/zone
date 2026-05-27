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
});
