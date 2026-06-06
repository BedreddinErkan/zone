import { describe, it, expect } from "vitest";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import type { StoreAction } from "../store.js";
import {
  handleTodosInitialized,
  handleTodoRevised,
  handleTodoStatusChanged,
} from "./useAgentEvents.js";

function capture(): { calls: StoreAction[]; dispatch: (a: StoreAction) => void } {
  const calls: StoreAction[] = [];
  return { calls, dispatch: (a) => { calls.push(a); } };
}

const TODO_ITEM = { id: "todo-0", text: "Fix the bug", status: "in_progress" as const };

describe("handleTodosInitialized", () => {
  it("dispatches TODOS_SET with the todos array", () => {
    const { calls, dispatch } = capture();
    handleTodosInitialized(
      { type: "todos_initialized", todos: [TODO_ITEM] } as unknown as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "TODOS_SET", todos: [TODO_ITEM] });
  });

  it("dispatches TODOS_SET with [] when todos field is absent", () => {
    const { calls, dispatch } = capture();
    handleTodosInitialized(
      { type: "todos_initialized" } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls[0]).toEqual({ type: "TODOS_SET", todos: [] });
  });
});

describe("handleTodoRevised", () => {
  it("dispatches TODOS_SET with the revised todos array", () => {
    const { calls, dispatch } = capture();
    const revised = [{ id: "todo-0", text: "Fix the bug", status: "completed" as const }];
    handleTodoRevised(
      { type: "todo_revised", todos: revised } as unknown as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls[0]).toEqual({ type: "TODOS_SET", todos: revised });
  });
});

describe("handleTodoStatusChanged", () => {
  it("dispatches TODO_STATUS_SET with todoId and status", () => {
    const { calls, dispatch } = capture();
    handleTodoStatusChanged(
      { type: "todo_status_changed", todoId: "todo-1", todoStatus: "completed" } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "TODO_STATUS_SET", todoId: "todo-1", status: "completed" });
  });

  it("noop when todoId is absent", () => {
    const { calls, dispatch } = capture();
    handleTodoStatusChanged(
      { type: "todo_status_changed" } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(0);
  });
});
