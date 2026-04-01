import type { SchemaSnapshot } from "../types/schema.js";
import type { PatchValidationIssue } from "../types/patch.js";

type PatchPreviewItem = {
  path: string;
  contentPreview?: string;
};

function extractTableNames(content: string): string[] {
  const matches = [...content.matchAll(/from\(["'`]([a-zA-Z0-9_]+)["'`]\)/g)];
  return matches.map((match) => match[1]);
}

function extractEqColumns(content: string): string[] {
  const matches = [...content.matchAll(/\.eq\(["'`]([a-zA-Z0-9_]+)["'`]\s*,/g)];
  return matches.map((match) => match[1]);
}

function extractSelectColumns(content: string): string[] {
  const matches = [...content.matchAll(/select\(["'`]([^"'`]+)["'`]\)/g)];
  const rawColumns = matches.flatMap((match) =>
    match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );

  return rawColumns
    .map((col) => col.replace(/\s+/g, ""))
    .filter((col) => col !== "*" && !col.includes("(") && !col.includes(")"));
}

function extractUpdateColumns(content: string): string[] {
  const matches = [...content.matchAll(/update\(\s*\{([\s\S]*?)\}\s*\)/g)];
  const columns: string[] = [];

  for (const match of matches) {
    const objectBody = match[1];
    const keyMatches = [...objectBody.matchAll(/([a-zA-Z0-9_]+)\s*:/g)];
    for (const keyMatch of keyMatches) {
      columns.push(keyMatch[1]);
    }
  }

  return columns;
}

export function validatePatchAgainstSchema(
  patchItems: PatchPreviewItem[],
  schema: SchemaSnapshot | null
): PatchValidationIssue[] {
  const issues: PatchValidationIssue[] = [];

  if (!schema) {
    issues.push({
      level: "warning",
      message: "No schema snapshot loaded. Schema-level patch validation skipped."
    });
    return issues;
  }

  const knownTables = new Set(schema.tables);
  const columnsByTable = new Map<string, Set<string>>();

  for (const column of schema.columns) {
    if (!columnsByTable.has(column.tableName)) {
      columnsByTable.set(column.tableName, new Set());
    }
    columnsByTable.get(column.tableName)?.add(column.columnName);
  }

  for (const item of patchItems) {
    const content = item.contentPreview ?? "";
    const referencedTables = extractTableNames(content);

    for (const tableName of referencedTables) {
      if (!knownTables.has(tableName)) {
        issues.push({
          level: "warning",
          message: `Referenced table '${tableName}' not found in schema snapshot.`,
          filePath: item.path
        });
      }
    }

    if (referencedTables.length !== 1) {
      continue;
    }

    const activeTable = referencedTables[0];
    const knownColumns = columnsByTable.get(activeTable);

    if (!knownColumns) {
      continue;
    }

    const referencedColumns = [
      ...extractEqColumns(content),
      ...extractSelectColumns(content),
      ...extractUpdateColumns(content)
    ];

    for (const columnName of referencedColumns) {
      if (!knownColumns.has(columnName)) {
        issues.push({
          level: "warning",
          message: `Referenced column '${activeTable}.${columnName}' not found in schema snapshot.`,
          filePath: item.path
        });
      }
    }
  }

  return issues;
}