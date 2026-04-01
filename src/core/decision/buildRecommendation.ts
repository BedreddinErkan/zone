import type { AgentDecisionMode, ValidationIssue } from "../types/agentResult.js";

export function buildRecommendation(input: {
  mode: AgentDecisionMode;
  issues: ValidationIssue[];
  confidenceScore: number;
}): string {
  const errorCount = input.issues.filter((item) => item.severity === "error").length;
  const warningCount = input.issues.filter((item) => item.severity === "warning").length;

  if (input.mode === "blocked") {
    if (errorCount > 0) {
      return "Apply yapma. Önce error seviyesindeki sorunları çöz ve tekrar çalıştır.";
    }

    return "Apply yapma. Karar nedenlerini ve riskleri inceleyip tekrar dene.";
  }

  if (input.mode === "preview_only") {
    if (warningCount > 0) {
      return "Preview çıktısını incele. Warning içeren riskler temizlenmeden otomatik apply önerilmez.";
    }

    if (input.confidenceScore < 70) {
      return "Confidence düşük. Önce manuel inceleme ve dry-run önerilir.";
    }

    return "Manuel inceleme sonrası ilerle. Dry-run ile doğrulama yapmak güvenli olur.";
  }

  return "Sonuç güvenli görünüyor. Apply öncesi patch preview ve top riskleri kısa kontrol et.";
}