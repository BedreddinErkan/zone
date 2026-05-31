import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CommandTail } from "./components/CommandTail.js";
import { formatMetadata } from "./components/toolCallFormat.js";

describe("TUI.10.J CommandTail", () => {
  it("success output shows last 3 non-meta lines, earlier lines excluded", () => {
    const detail = "line1\nline2\nline3\nline4\nline5";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line3");
    expect(frame).toContain("line4");
    expect(frame).toContain("line5");
    expect(frame).not.toContain("line1");
    expect(frame).not.toContain("line2");
  });

  it("failure output (ok=false) shows last 8 lines not truncated to 3", () => {
    // Use zero-padded names to avoid substring collisions (e.g. "fail01" not contained in "fail10")
    const lines = Array.from({ length: 10 }, (_, i) => `fail${String(i + 1).padStart(2, "0")}`).join("\n");
    const { lastFrame } = render(<CommandTail detail={lines} ok={false} />);
    const frame = lastFrame() ?? "";
    // Last 8: fail03..fail10 visible; fail01, fail02 excluded
    expect(frame).toContain("fail03");
    expect(frame).toContain("fail10");
    expect(frame).not.toContain("fail01");
    expect(frame).not.toContain("fail02");
  });

  it("output ≤ 3 lines shows all lines without truncation", () => {
    const detail = "only\ntwo";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("only");
    expect(frame).toContain("two");
  });

  it("all-meta output (silent success) shows ✓ indicator", () => {
    const detail = "[exit_code=0 — command succeeded; output below is informational]\n[zone-something]";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
  });

  it("empty detail shows ✓ indicator", () => {
    const { lastFrame } = render(<CommandTail detail="" ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
  });

  it("ok=false shows more tail lines than ok=true for same detail", () => {
    const detail = Array.from({ length: 6 }, (_, i) => `L${i + 1}`).join("\n");
    const { lastFrame: successFrame } = render(<CommandTail detail={detail} ok={true} />);
    const { lastFrame: failFrame } = render(<CommandTail detail={detail} ok={false} />);
    // success: last 3 → L4 L5 L6; failure: last 6 (all) → L1..L6
    expect(successFrame() ?? "").not.toContain("L1");
    expect(failFrame() ?? "").toContain("L1");
  });

  it("meta lines ([exit_code= and [zone-) are filtered from tail", () => {
    const detail = "[exit_code=0 — command succeeded]\nresult: ok\n[zone-something]\nTests 5 passed";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("result: ok");
    expect(frame).toContain("Tests 5 passed");
    expect(frame).not.toContain("[exit_code");
    expect(frame).not.toContain("[zone-");
  });
});

describe("TUI.10.J.1 CommandTail exit-status indicator", () => {
  it("success shows ✓ indicator before tail lines", () => {
    const detail = "[exit_code=0 — command succeeded]\nsome output line";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("some output line");
    // indicator appears on earlier line than tail content
    expect(frame.indexOf("✓")).toBeLessThan(frame.indexOf("some output line"));
  });

  it("failure shows ✗ exit N indicator with exit code from detail", () => {
    const detail = "[exit_code=1 — command failed]\nerror: something went wrong";
    const { lastFrame } = render(<CommandTail detail={detail} ok={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗ exit 1");
    expect(frame).toContain("error: something went wrong");
  });

  it("silent success (only meta lines) shows ✓ with no tail content", () => {
    const detail = "[exit_code=0 — command succeeded]";
    const { lastFrame } = render(<CommandTail detail={detail} ok={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).not.toContain("[exit_code");
  });

  it("failure with no parseable exit code shows ✗ without number", () => {
    const { lastFrame } = render(<CommandTail detail="error output" ok={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).not.toContain("exit");
  });
});

describe("TUI.10.J formatMetadata lineRange", () => {
  it("read_file with lineRange header returns 'lines S-E of T'", () => {
    const result = formatMetadata("read_file", {
      ok: true,
      detail: "[lineRange 1-50 of 82 total lines from src/cli/tui/components/Transcript.tsx]\nsome content",
    });
    expect(result).toBe("lines 1-50 of 82");
  });

  it("read_file with no lineRange header returns plain 'N lines'", () => {
    const result = formatMetadata("read_file", {
      ok: true,
      detail: "const x = 1;\nconst y = 2;\n",
    });
    expect(result).toBe("2 lines");
  });
});
