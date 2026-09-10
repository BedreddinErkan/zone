import { describe, it, expect } from "vitest";
import React, { useEffect, useRef } from "react";
import { render } from "ink-testing-library";
import { StoreProvider, useStore, reducer, buildInitialState } from "../store.js";
import { PlanCursor } from "./PlanCursor.js";
import type { RunTodo } from "../../../core/todoLifecycle.js";
import type { StoreAction } from "../store-core.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTodos(count: number, completedCount = 0, activeIndex = 0): RunTodo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `todo-${i}`,
    text: `Step ${i + 1}: ${"task description ".repeat(3).trim()}`,
    status: (i < completedCount ? "completed" : i === activeIndex ? "in_progress" : "pending") as RunTodo["status"],
  }));
}

/** Sets up store state with todos and running runState via dispatch on mount. */
function SetupAndRender({ todos, runState }: { todos: RunTodo[]; runState?: string }): React.ReactElement {
  const { dispatch } = useStore();
  const fired = useRef(false);
  if (!fired.current) {
    fired.current = true;
    // Set runState to running via a SPINNER_START (which sets runState to "running")
    if (runState === "running") {
      dispatch({ type: "SPINNER_START", label: "Working" });
    }
    dispatch({ type: "TODOS_SET", todos } as StoreAction);
  }
  return <PlanCursor />;
}

describe("PlanCursor — 1-line invariant", () => {
  it("returns null when no todos", () => {
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <PlanCursor />
      </StoreProvider>
    );
    expect(instance.lastFrame()).toBe("");
    instance.unmount();
  });

  it("1 todo renders exactly 1 line", async () => {
    const todos = makeTodos(1, 0, 0);
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <SetupAndRender todos={todos} runState="running" />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    const lines = frame.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("0/1");
    instance.unmount();
  });

  it("5 todos renders exactly 1 line", async () => {
    const todos = makeTodos(5, 2, 2);
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <SetupAndRender todos={todos} runState="running" />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    const lines = frame.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("2/5");
    instance.unmount();
  });

  it("30 todos renders exactly 1 line", async () => {
    const todos = makeTodos(30, 15, 15);
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <SetupAndRender todos={todos} runState="running" />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    const lines = frame.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("15/30");
    instance.unmount();
  });

  it("shows active step text truncated with ellipsis", async () => {
    const todos: RunTodo[] = [{
      id: "t1",
      text: "A".repeat(100),
      status: "in_progress",
    }];
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <SetupAndRender todos={todos} runState="running" />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("…");
    instance.unmount();
  });

  it("shows counts without active step when all completed", async () => {
    const todos = makeTodos(3, 3, -1);
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <SetupAndRender todos={todos} runState="running" />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("3/3");
    // No " · " separator when no active step
    expect(frame).not.toContain(" · ");
    instance.unmount();
  });
});

describe("PlanCursor — store integration", () => {
  it("TODOS_SET appends a plan_snapshot entry", () => {
    const s = buildInitialState({ model: "test", capUsd: 10 });
    const todos = makeTodos(3, 0, 0);
    const next = reducer(s, { type: "TODOS_SET", todos } as StoreAction);
    const snapshots = next.transcript.filter(e => e.kind === "plan_snapshot");
    expect(snapshots.length).toBe(1);
    if (snapshots[0]?.kind === "plan_snapshot") {
      expect(snapshots[0].todos.length).toBe(3);
    }
  });

  it("identical TODOS_SET does not append duplicate snapshot", () => {
    const s = buildInitialState({ model: "test", capUsd: 10 });
    const todos = makeTodos(3, 0, 0);
    const next1 = reducer(s, { type: "TODOS_SET", todos } as StoreAction);
    const next2 = reducer(next1, { type: "TODOS_SET", todos } as StoreAction);
    const snapshots = next2.transcript.filter(e => e.kind === "plan_snapshot");
    expect(snapshots.length).toBe(1); // No duplicate
  });

  it("RUN_DONE appends final snapshot when todos changed", () => {
    let s = buildInitialState({ model: "test", capUsd: 10 });
    const todos = makeTodos(2, 0, 0);
    s = reducer(s, { type: "TODOS_SET", todos } as StoreAction);
    s = reducer(s, { type: "TODO_STATUS_SET", todoId: "todo-0", status: "completed" });
    s = reducer(s, { type: "RUN_DONE" });
    const snapshots = s.transcript.filter(e => e.kind === "plan_snapshot");
    expect(snapshots.length).toBe(2); // init + final
  });

  it("empty todos does not append snapshot", () => {
    const s = buildInitialState({ model: "test", capUsd: 10 });
    const next = reducer(s, { type: "TODOS_SET", todos: [] } as StoreAction);
    const snapshots = next.transcript.filter(e => e.kind === "plan_snapshot");
    expect(snapshots.length).toBe(0);
  });
});
