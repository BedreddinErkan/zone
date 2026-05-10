import type { ExecutionPlan } from "../llm/executionPlan.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "skipped";

export type RunTodo = {
  id: string;
  text: string;
  description?: string;
  filesLikely?: string[];
  status: TodoStatus;
};

export function executionPlanToTodos(plan: ExecutionPlan): RunTodo[] {
  return plan.steps.map((step, index) => ({
    id: `todo-${index}`,
    text: String(step.title || step.description || `Step ${index + 1}`),
    description: step.description || undefined,
    filesLikely: Array.isArray(step.filesLikely) ? [...step.filesLikely] : [],
    status: "pending",
  }));
}

export function transitionTodo(
  todos: RunTodo[],
  todoId: string,
  status: TodoStatus
): RunTodo[] {
  return todos.map((todo) =>
    todo.id === todoId ? { ...todo, status } : todo
  );
}

export function startTodo(todos: RunTodo[], todoId: string): RunTodo[] {
  let startedIndex = -1;
  const next = todos.map((todo, index) => {
    if (todo.id !== todoId) return todo;
    startedIndex = index;
    return { ...todo, status: "in_progress" as TodoStatus };
  });
  if (startedIndex < 0) return todos;
  return next.map((todo, index) =>
    index < startedIndex && todo.status === "pending"
      ? { ...todo, status: "completed" }
      : todo
  );
}

export function completeTodo(todos: RunTodo[], todoId: string): RunTodo[] {
  return transitionTodo(todos, todoId, "completed");
}

export function finalizeTodos(
  todos: RunTodo[],
  outcome: "completed" | "skipped"
): RunTodo[] {
  return todos.map((todo) =>
    todo.status === "completed"
      ? todo
      : { ...todo, status: outcome }
  );
}

export function todoIdForStepIndex(stepIndex: number): string {
  return `todo-${stepIndex}`;
}

function normalizePathForTodoMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function findTodoIdForFile(
  todos: RunTodo[],
  filePath: string | null | undefined
): string | null {
  const target = normalizePathForTodoMatch(String(filePath || ""));
  if (!target) return null;
  for (const todo of todos) {
    const files = Array.isArray(todo.filesLikely) ? todo.filesLikely : [];
    if (files.some((file) => normalizePathForTodoMatch(String(file)) === target)) {
      return todo.id;
    }
  }
  return null;
}

export function parseTodoProgressMarkers(text: string): Array<{
  todoId: string;
  status: Extract<TodoStatus, "in_progress" | "completed">;
}> {
  const markers: Array<{
    todoId: string;
    status: Extract<TodoStatus, "in_progress" | "completed">;
  }> = [];
  const re = /\[step:(start|done):(\d+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const stepNumber = Number(match[2]);
    if (!Number.isInteger(stepNumber) || stepNumber < 1) continue;
    markers.push({
      todoId: todoIdForStepIndex(stepNumber - 1),
      status: match[1].toLowerCase() === "done" ? "completed" : "in_progress",
    });
  }
  return markers;
}
