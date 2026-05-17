import { marked } from "marked";
import { describe, expect, it } from "vitest";

function sanitize(html: string): string {
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
}

describe("chat slot markdown rendering (UI.2)", () => {
  it("renders audit markdown to h2 heading, table, and ul list", () => {
    const md = "## H\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- bullet";
    const html = sanitize(marked.parse(md) as string);
    expect(html).toContain("<h2>");
    expect(html).toContain("<table");
    expect(html).toContain("<ul>");
  });

  it("sanitizer strips script tags from XSS injection in agent text", () => {
    const xss = "text <script>alert(1)</script> more text";
    const rawFromMarked = marked.parse(xss) as string;
    expect(rawFromMarked).toContain("alert(1)");
    const sanitized = sanitize(rawFromMarked);
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).not.toContain("alert(1)");
  });
});
