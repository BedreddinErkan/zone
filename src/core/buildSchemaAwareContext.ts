import type { TaskIntent } from "./taskIntentParser.js";
import type { SchemaSnapshot } from "../types/schema.js";
import type { ProjectPatternAnalysis, ResourceStorageInsight } from "../types/analysis.js";

export type SchemaAwareContext = {
  intent: TaskIntent;
  schema: SchemaSnapshot | null;
  projectPatterns: ProjectPatternAnalysis;
  storageInsight: ResourceStorageInsight | null;
  summaryLines: string[];
};

type BuildSchemaAwareContextInput = {
  intent: TaskIntent;
  schema: SchemaSnapshot | null;
  projectPatterns: ProjectPatternAnalysis;
  storageInsight: ResourceStorageInsight | null;
};

export function buildSchemaAwareContext(input: BuildSchemaAwareContextInput): SchemaAwareContext {
  const summaryLines: string[] = [];

  summaryLines.push(`Intent action: ${input.intent.action}`);
  summaryLines.push(`Intent resource kind: ${input.intent.resourceKind}`);
  summaryLines.push(`Intent scope: ${input.intent.scope}`);

  if (input.intent.parentResource) {
    summaryLines.push(`Parent resource: ${input.intent.parentResource}`);
  }

  if (input.intent.nestedResource) {
    summaryLines.push(`Nested resource: ${input.intent.nestedResource}`);
  }

  if (input.schema) {
    summaryLines.push(`Schema loaded with ${input.schema.tables.length} tables.`);
  } else {
    summaryLines.push("No schema snapshot available.");
  }

  summaryLines.push(`Detected DB client: ${input.projectPatterns.dbClient}`);
  summaryLines.push(`Detected response shape: ${input.projectPatterns.responseShape}`);

  if (input.projectPatterns.authMiddlewareName) {
    summaryLines.push(`Detected auth middleware: ${input.projectPatterns.authMiddlewareName}`);
  }

  if (input.storageInsight) {
    summaryLines.push(`Detected storage kind: ${input.storageInsight.storageKind}`);

    if (input.storageInsight.tableName) {
      summaryLines.push(`Detected storage table: ${input.storageInsight.tableName}`);
    }

    if (input.storageInsight.parentTableName) {
      summaryLines.push(`Detected parent table: ${input.storageInsight.parentTableName}`);
    }

    if (input.storageInsight.jsonFieldName) {
      summaryLines.push(`Detected JSON field: ${input.storageInsight.jsonFieldName}`);
    }

    for (const evidence of input.storageInsight.evidence) {
      summaryLines.push(`Storage evidence: ${evidence}`);
    }
  }

  return {
    intent: input.intent,
    schema: input.schema,
    projectPatterns: input.projectPatterns,
    storageInsight: input.storageInsight,
    summaryLines
  };
}