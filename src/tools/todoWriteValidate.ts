import type { RunTodo, TodoStatus } from "../core/todoLifecycle.js";

export type TodoWriteValidationResult =
  | { ok: true; normalized: RunTodo[] }
  | { ok: false; error: string };

const VALID_STATUSES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "skipped",
];

export function validateTodoWriteArgs(args: unknown): TodoWriteValidationResult {
  if (!args || typeof args !== "object") {
    return { ok: false, error: "args must be an object" };
  }
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return { ok: false, error: "todos must be an array" };
  }
  if (todos.length < 1) {
    return { ok: false, error: "todos must contain at least 1 item" };
  }
  if (todos.length > 12) {
    return { ok: false, error: "todos must contain at most 12 items" };
  }

  const seenIds = new Set<string>();
  let inProgressCount = 0;
  const normalized: RunTodo[] = [];

  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    if (!t || typeof t !== "object") {
      return { ok: false, error: `todos[${i}] must be an object` };
    }
    const td = t as Record<string, unknown>;

    const id = typeof td.id === "string" ? td.id.trim() : "";
    if (!id) {
      return { ok: false, error: `todos[${i}].id required (non-empty string)` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `todos[${i}].id duplicate: "${id}"` };
    }
    seenIds.add(id);

    const content = typeof td.content === "string" ? td.content.trim() : "";
    if (!content) {
      return {
        ok: false,
        error: `todos[${i}].content required (non-empty string)`,
      };
    }

    const statusRaw = typeof td.status === "string" ? td.status : "pending";
    if (!VALID_STATUSES.includes(statusRaw as TodoStatus)) {
      return {
        ok: false,
        error: `todos[${i}].status invalid: "${statusRaw}". Must be one of: ${VALID_STATUSES.join(", ")}`,
      };
    }
    const status = statusRaw as TodoStatus;
    if (status === "in_progress") inProgressCount++;

    const description =
      typeof td.description === "string" ? td.description.trim() : "";

    normalized.push({
      id,
      text: content,
      description: description || undefined,
      status,
    });
  }

  if (inProgressCount > 1) {
    return {
      ok: false,
      error: `exactly one todo may be in_progress, got ${inProgressCount}. Mark the prior in_progress step completed/skipped before starting the next.`,
    };
  }

  return { ok: true, normalized };
}
