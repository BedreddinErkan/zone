import React from "react";
import { Box, Text } from "ink";
import type { RunTodo, TodoStatus } from "../../../core/todoLifecycle.js";

function glyphFor(status: TodoStatus): { glyph: string; color?: string; dim?: boolean } {
  switch (status) {
    case "completed":   return { glyph: "✓", color: "green" };
    case "in_progress": return { glyph: "▶", color: "cyan" };
    case "skipped":     return { glyph: "⊘", dim: true };
    case "pending":
    default:            return { glyph: "○", dim: true };
  }
}

export function PlanPanel({ todos }: { todos: RunTodo[] }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2}>
      {todos.map((todo) => {
        const { glyph, color, dim } = glyphFor(todo.status);
        return (
          <Box key={todo.id}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <Text color={color as any} dimColor={dim}>{glyph}{" "}</Text>
            <Box flexGrow={1}>
              <Text dimColor={todo.status === "skipped"}>{todo.text}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
