import { describe, expect, it } from "vitest";
import {
  completeTodo,
  executionPlanToTodos,
  finalizeTodos,
  findTodoIdForFile,
  parseTodoProgressMarkers,
  startTodo,
} from "./todoLifecycle.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";

const plan: ExecutionPlan = {
  objective: "Update UI",
  scopeSummary: "UI only",
  riskHints: [],
  steps: [
    {
      title: "Add state",
      description: "Create run-owned todo state",
      filesLikely: ["src/ui/index.html"],
    },
    {
      title: "Wire backend",
      description: "Emit todo events",
      filesLikely: ["src/core/runLlmPatchFlow.ts"],
    },
  ],
};

describe("todo lifecycle", () => {
  it("converts execution plan steps to stable todos", () => {
    const todos = executionPlanToTodos(plan);

    expect(todos).toEqual([
      {
        id: "todo-0",
        text: "Add state",
        description: "Create run-owned todo state",
        filesLikely: ["src/ui/index.html"],
        status: "pending",
      },
      {
        id: "todo-1",
        text: "Wire backend",
        description: "Emit todo events",
        filesLikely: ["src/core/runLlmPatchFlow.ts"],
        status: "pending",
      },
    ]);
  });

  it("applies status transitions and final cascade", () => {
    const initial = executionPlanToTodos(plan);
    const started = startTodo(initial, "todo-0");
    const completed = completeTodo(started, "todo-0");
    const nextStarted = startTodo(completed, "todo-1");
    const final = finalizeTodos(nextStarted, "completed");

    expect(started[0]?.status).toBe("in_progress");
    expect(completed[0]?.status).toBe("completed");
    expect(nextStarted[1]?.status).toBe("in_progress");
    expect(final.map((todo) => todo.status)).toEqual(["completed", "completed"]);
  });

  it("marks unfinished todos skipped on unsuccessful finalization", () => {
    const final = finalizeTodos(startTodo(executionPlanToTodos(plan), "todo-0"), "skipped");

    expect(final.map((todo) => todo.status)).toEqual(["skipped", "skipped"]);
  });

  it("supports marker and file fallback mapping", () => {
    expect(parseTodoProgressMarkers("[step:start:2]\n[step:done:2]")).toEqual([
      { todoId: "todo-1", status: "in_progress" },
      { todoId: "todo-1", status: "completed" },
    ]);
    expect(findTodoIdForFile(executionPlanToTodos(plan), "./src/ui/index.html")).toBe("todo-0");
  });
});
