export type SchemaColumn = {
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  defaultValue?: string | null;
};

export type SchemaForeignKey = {
  tableName: string;
  columnName: string;
  foreignTableName: string;
  foreignColumnName: string;
};

export type SchemaIndex = {
  tableName: string;
  indexName: string;
  isUnique: boolean;
  columns: string[];
};

export type SchemaSnapshot = {
  tables: string[];
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
  source: "manual-json" | "sql-parse" | "supabase-introspection" | "unknown";
  loadedAt: string;
};