export type ResponseShape =
  | "success-message-data"
  | "data-error"
  | "raw-json"
  | "unknown";

export type StorageKind =
  | "separate_table"
  | "json_field"
  | "unknown";

export type DbClientKind =
  | "supabase"
  | "prisma"
  | "mongoose"
  | "unknown";

export type BackendStyle =
  | "express"
  | "unknown";

export type FrontendStyle =
  | "react"
  | "unknown";

export type ResourceStorageInsight = {
  parentResource: string;
  nestedResource?: string;
  storageKind: StorageKind;
  tableName?: string;
  parentTableName?: string;
  jsonFieldName?: string;
  evidence: string[];
};

export type ProjectPatternAnalysis = {
  authMiddlewareName?: string;
  responseShape: ResponseShape;
  dbClient: DbClientKind;
  backendStyle: BackendStyle;
  frontendStyle: FrontendStyle;
  routePatterns: string[];
  evidence: string[];
};