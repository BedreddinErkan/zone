/**
 * Phase Q.4 unit tests: truncateCommandOutput — head/tail line truncation
 * for run_command agent context.
 */

import { describe, expect, it } from "vitest";
import {
  COMMAND_OUTPUT_HEAD_LINES,
  COMMAND_OUTPUT_TAIL_LINES,
  truncateCommandOutput,
} from "./toolExecutor.js";

const THRESHOLD = COMMAND_OUTPUT_HEAD_LINES + COMMAND_OUTPUT_TAIL_LINES; // 150

function makeLines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("truncateCommandOutput", () => {
  it("returns short output unchanged (wasTruncated: false)", () => {
    const output = makeLines(50);
    const result = truncateCommandOutput(output);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(output);
    expect(result.originalLineCount).toBe(50);
  });

  it("returns output at exactly the threshold unchanged", () => {
    const output = makeLines(THRESHOLD);
    const result = truncateCommandOutput(output);
    expect(result.wasTruncated).toBe(false);
    expect(result.originalLineCount).toBe(THRESHOLD);
  });

  it("truncates output one line above threshold", () => {
    const output = makeLines(THRESHOLD + 1);
    const result = truncateCommandOutput(output);
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLineCount).toBe(THRESHOLD + 1);
  });

  it("produces head + marker + tail for 200-line output", () => {
    const output = makeLines(200);
    const result = truncateCommandOutput(output);
    expect(result.wasTruncated).toBe(true);

    const lines = result.truncated.split("\n");
    // Structure: HEAD_LINES + empty + marker + empty + TAIL_LINES
    const expectedLineCount = COMMAND_OUTPUT_HEAD_LINES + 1 + 1 + 1 + COMMAND_OUTPUT_TAIL_LINES;
    expect(lines).toHaveLength(expectedLineCount);

    // Head: first HEAD_LINES lines are original lines 1..HEAD_LINES
    expect(lines[0]).toBe("line 1");
    expect(lines[COMMAND_OUTPUT_HEAD_LINES - 1]).toBe(`line ${COMMAND_OUTPUT_HEAD_LINES}`);

    // Tail: last TAIL_LINES lines are original lines 151..200
    const tailStart = lines.length - COMMAND_OUTPUT_TAIL_LINES;
    expect(lines[tailStart]).toBe(`line ${200 - COMMAND_OUTPUT_TAIL_LINES + 1}`);
    expect(lines[lines.length - 1]).toBe("line 200");
  });

  it("handles very long output (10 000 lines) and still caps correctly", () => {
    const output = makeLines(10_000);
    const result = truncateCommandOutput(output);
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLineCount).toBe(10_000);

    const lines = result.truncated.split("\n");
    const expectedLineCount = COMMAND_OUTPUT_HEAD_LINES + 1 + 1 + 1 + COMMAND_OUTPUT_TAIL_LINES;
    expect(lines).toHaveLength(expectedLineCount);
    expect(lines[0]).toBe("line 1");
    expect(lines[lines.length - 1]).toBe("line 10000");
  });

  it("returns empty string unchanged", () => {
    const result = truncateCommandOutput("");
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe("");
    expect(result.originalLineCount).toBe(1); // "".split("\n") → [""] → length 1
  });

  it("returns a single long line (no newlines) unchanged", () => {
    const bigLine = "x".repeat(100_000);
    const result = truncateCommandOutput(bigLine);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(bigLine);
    expect(result.originalLineCount).toBe(1);
  });

  it("marker includes the elided line count", () => {
    const totalLines = 200;
    const output = makeLines(totalLines);
    const { truncated } = truncateCommandOutput(output);
    const elidedCount = totalLines - COMMAND_OUTPUT_HEAD_LINES - COMMAND_OUTPUT_TAIL_LINES;
    expect(truncated).toContain(`${elidedCount} lines truncated`);
  });

  it("marker contains a human-readable label", () => {
    const output = makeLines(THRESHOLD + 10);
    const { truncated } = truncateCommandOutput(output);
    expect(truncated).toContain("context budget");
  });
});
