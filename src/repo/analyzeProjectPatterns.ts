import type { ProjectPatternAnalysis } from "../types/analysis.js";

type FileInput = {
  path: string;
  content: string;
};

export function analyzeProjectPatterns(files: FileInput[]): ProjectPatternAnalysis {
  let authMiddlewareName: string | undefined;
  let responseShape: ProjectPatternAnalysis["responseShape"] = "unknown";
  let dbClient: ProjectPatternAnalysis["dbClient"] = "unknown";
  let backendStyle: ProjectPatternAnalysis["backendStyle"] = "unknown";
  let frontendStyle: ProjectPatternAnalysis["frontendStyle"] = "unknown";

  const routePatterns: string[] = [];
  const evidence: string[] = [];

  for (const file of files) {
    const content = file.content;

    if (file.path.includes("/routes/") && /express|router\.(get|post|put|patch|delete)/.test(content)) {
      backendStyle = "express";
      routePatterns.push(file.path);
    }

    if (/requireAuth/.test(content)) {
      authMiddlewareName = "requireAuth";
      evidence.push(`Detected requireAuth in ${file.path}`);
    }

    if (/success\s*:\s*(true|false)/.test(content) && /message\s*:/.test(content) && /data\s*:/.test(content)) {
      responseShape = "success-message-data";
    } else if (/data\s*:/.test(content) && /error\s*:/.test(content)) {
      responseShape = "data-error";
    }

    if (/from\(["'`]([a-zA-Z0-9_]+)["'`]\)/.test(content) || /supabase/.test(content)) {
      dbClient = "supabase";
      evidence.push(`Detected Supabase usage in ${file.path}`);
    }

    if (/react|useState|useEffect|jsx/.test(content)) {
      frontendStyle = "react";
    }
  }

  return {
    authMiddlewareName,
    responseShape,
    dbClient,
    backendStyle,
    frontendStyle,
    routePatterns,
    evidence
  };
}