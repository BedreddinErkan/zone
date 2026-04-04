"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreTopRisks = scoreTopRisks;
function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}
function toSeverity(score) {
    if (score >= 80)
        return "high";
    if (score >= 50)
        return "medium";
    return "low";
}
function severityRank(severity) {
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
function normalizeCategory(issue) {
    if (issue.code.startsWith("SCHEMA_") || issue.code.startsWith("schema_")) {
        return "schema";
    }
    if (issue.code.startsWith("ARCH_") ||
        issue.code.startsWith("arch_") ||
        issue.code === "ARCHITECTURE_WARNING") {
        return "architecture";
    }
    if (issue.code.startsWith("CONFIDENCE_") || issue.code.startsWith("confidence_")) {
        return "confidence";
    }
    if (issue.code.includes("PATCH") ||
        issue.code === "PATH_TRAVERSAL" ||
        issue.code === "PROTECTED_FILE" ||
        issue.code === "DUPLICATE_TARGET") {
        return "patch";
    }
    // Fallback: issue.source alanını kullan (özellikle custom kod'lar için)
    if (issue.source === "schema")
        return "schema";
    if (issue.source === "architecture")
        return "architecture";
    if (issue.source === "confidence")
        return "confidence";
    if (issue.source === "patch")
        return "patch";
    return "validation";
}
function buildRisk(input) {
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
function scoreFromIssue(issue) {
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
            if (issue.severity === "error")
                return 78;
            if (issue.severity === "warning")
                return 52;
            return 28;
    }
}
function titleFromIssue(issue) {
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
function normalizeDetails(details) {
    if (Array.isArray(details)) {
        return details.join("; ");
    }
    return details;
}
function descriptionFromIssue(issue) {
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
function mapIssueToRisk(issue) {
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
function mapDecisionToRisk(mode) {
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
function dedupeRisks(risks) {
    const byId = new Map();
    for (const risk of risks) {
        const existing = byId.get(risk.id);
        if (!existing || risk.score > existing.score) {
            byId.set(risk.id, risk);
        }
    }
    return Array.from(byId.values());
}
function sortRisks(risks) {
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
function scoreTopRisks(input) {
    const risks = input.issues.map(mapIssueToRisk);
    const decisionRisk = mapDecisionToRisk(input.decisionMode);
    if (decisionRisk) {
        risks.push(decisionRisk);
    }
    return sortRisks(dedupeRisks(risks)).slice(0, input.limit ?? 5);
}
//# sourceMappingURL=scoreTopRisks.js.map