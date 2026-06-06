import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import type { RunTodo } from "../../../core/todoLifecycle.js";
import { PlanPanel } from "./PlanPanel.js";

const TODOS: RunTodo[] = [
  { id: "1", text: "Locate the bug", status: "completed" },
  { id: "2", text: "Patch it", status: "in_progress" },
  { id: "3", text: "Run tests", status: "pending" },
  { id: "4", text: "Skipped step", status: "skipped" },
];

describe("PlanPanel", () => {
  it("renders all todo texts", () => {
    const { lastFrame, unmount } = render(<PlanPanel todos={TODOS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Locate the bug");
    expect(frame).toContain("Patch it");
    expect(frame).toContain("Run tests");
    expect(frame).toContain("Skipped step");
    unmount();
  });

  it("renders ✓ for completed and ▶ for in_progress", () => {
    const { lastFrame, unmount } = render(<PlanPanel todos={TODOS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("▶");
    unmount();
  });

  it("renders nothing visible for empty todos", () => {
    const { lastFrame, unmount } = render(<PlanPanel todos={[]} />);
    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("");
    unmount();
  });
});
