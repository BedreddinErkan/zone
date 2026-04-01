import type {
  AgentDecisionMode,
  ScoredRisk,
  ValidationIssue
} from "../../types/agent.js";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toSeverity(score: number): ScoredRisk["severity"] {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function severityRank(severity: ScoredRisk["severity"]): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function normalizeCategory(issue: ValidationIssue): ScoredRisk["category"] {
  if (issue.code.startsWith("SCHEMA_") || issue.code.startsWith("schema_")) {
    return "schema";
  }

  if (issue.code.startsWith("ARCH_") || issue.code.startsWith("arch_")) {
    return "architecture";
  }

  if (issue.code.startsWith("CONFIDENCE_") || issue.code.startsWith("confidence_")) {
    return "confidence";
  }

  if (
    issue.code.includes("PATCH") ||
    issue.code === "PATH_TRAVERSAL" ||
    issue.code === "PROTECTED_FILE" ||
    issue.code === "DUPLICATE_TARGET"
  ) {
    return "patch";
  }

  return "validation";
}

function buildRisk(input: {
  id: string;
  title: string;
  description: string;
  score: number;
  category: ScoredRisk["category"];
  source: ScoredRisk["source"];
  relatedCode?: string;
}): ScoredRisk {
  const score = clampScore(input.score);

  return {
    id: input.id,
    title: input.title,
    description: input.description,
    score,
    severity: toSeverity(score),
    category: input.category,
    source: input.source,
    relatedCode: input.relatedCode
  };
}

function scoreFromIssue(issue: ValidationIssue): number {
  switch (issue.code) {
    case "PATH_TRAVERSAL":
      return 100;
    case "PROTECTED_FILE":
      return 95;
    case "SCHEMA_INVALID":
      return 90;
    case "DUPLICATE_TARGET":
      return 72;
    case "AMBIGUOUS_TARGET":
      return 60;
    case "PATCH_RISK_WARNING":
      return 54;
    case "ARCHITECTURE_WARNING":
      return 55;
    default:
      if (issue.severity === "error") return 78;
      if (issue.severity === "warning") return 52;
      return 28;
  }
}

function titleFromIssue(issue: ValidationIssue): string {
  switch (issue.code) {
    case "PATH_TRAVERSAL":
      return "Path traversal riski";
    case "PROTECTED_FILE":
      return "Protected file değişikliği";
    case "SCHEMA_INVALID":
      return "Schema mismatch riski";
    case "DUPLICATE_TARGET":
      return "Çakışan patch hedefleri";
    case "AMBIGUOUS_TARGET":
      return "Belirsiz dosya hedefi";
    case "PATCH_RISK_WARNING":
      return "Patch riski";
    case "ARCHITECTURE_WARNING":
      return "Mimari uyum riski";
    default:
      return issue.message;
  }
}

function normalizeDetails(details?: string | string[]): string | undefined {
  if (Array.isArray(details)) {
    return details.join("; ");
  }

  return details;
}

function descriptionFromIssue(issue: ValidationIssue): string {
  switch (issue.code) {
    case "PATH_TRAVERSAL":
      return "Patch hedef yolu repo dışına çıkabilir ve beklenmeyen dosyaları etkileyebilir.";
    case "PROTECTED_FILE":
      return "Korunan dosyaların değiştirilmesi güvenlik veya kritik sistem davranışını bozabilir.";
    case "SCHEMA_INVALID":
      return "Patch çıktısı beklenen şemayla uyumlu değil; runtime veya apply aşaması kırılabilir.";
    case "DUPLICATE_TARGET":
      return "Aynı hedef üzerinde birden fazla patch çakışabilir ve beklenmeyen sonuç üretebilir.";
    case "AMBIGUOUS_TARGET":
      return "Değişikliğin uygulanacağı gerçek dosya net değil; yanlış hedef etkilenebilir.";
    case "PATCH_RISK_WARNING":
      return issue.message;
    case "ARCHITECTURE_WARNING":
      return issue.message;
    default:
      return normalizeDetails(issue.details) ?? "Validation aşamasında tespit edilen bir risk.";
  }
}

function mapIssueToRisk(issue: ValidationIssue): ScoredRisk {
  return buildRisk({
    id: `issue:${issue.code.toLowerCase()}`,
    title: titleFromIssue(issue),
    description: descriptionFromIssue(issue),
    score: scoreFromIssue(issue),
    category: normalizeCategory(issue),
    source: "validation_issue",
    relatedCode: issue.code
  });
}

function mapDecisionToRisk(mode: AgentDecisionMode): ScoredRisk | null {
  switch (mode) {
    case "blocked":
      return buildRisk({
        id: "decision:blocked",
        title: "Uygulama engellendi",
        description: "Sistem kritik riskler nedeniyle patch uygulamasını durdurdu.",
        score: 92,
        category: "validation",
        source: "decision",
        relatedCode: "blocked"
      });

    case "preview_only":
      return buildRisk({
        id: "decision:preview_only",
        title: "Sadece preview güvenli",
        description: "Sistem otomatik uygulama yerine manuel inceleme öneriyor.",
        score: 57,
        category: "validation",
        source: "decision",
        relatedCode: "preview_only"
      });

    case "safe_to_apply":
      return null;
  }
}

function dedupeRisks(risks: ScoredRisk[]): ScoredRisk[] {
  const byId = new Map<string, ScoredRisk>();

  for (const risk of risks) {
    const existing = byId.get(risk.id);

    if (!existing || risk.score > existing.score) {
      byId.set(risk.id, risk);
    }
  }

  return Array.from(byId.values());
}

function sortRisks(risks: ScoredRisk[]): ScoredRisk[] {
  return [...risks].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const severityDiff = severityRank(b.severity) - severityRank(a.severity);
    if (severityDiff !== 0) {
      return severityDiff;
    }

    return a.title.localeCompare(b.title, "tr");
  });
}

export function scoreTopRisks(input: {
  issues: ValidationIssue[];
  decisionMode: AgentDecisionMode;
  limit?: number;
}): ScoredRisk[] {
  const risks = input.issues.map(mapIssueToRisk);

  const decisionRisk = mapDecisionToRisk(input.decisionMode);
  if (decisionRisk) {
    risks.push(decisionRisk);
  }

  return sortRisks(dedupeRisks(risks)).slice(0, input.limit ?? 5);
}