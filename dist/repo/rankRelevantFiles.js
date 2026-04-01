"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankRelevantFiles = rankRelevantFiles;
const intentAwareScore_js_1 = require("../core/intentAwareScore.js");
function scoreFile(file, task) {
    const normalizedTask = task.toLowerCase();
    const filePath = file.path.toLowerCase();
    let score = 0;
    const keywords = normalizedTask
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length > 2);
    for (const keyword of keywords) {
        if (filePath.includes(keyword)) {
            score += 10;
        }
    }
    if (normalizedTask.includes("timeline") && filePath.includes("timeline")) {
        score += 25;
    }
    if (normalizedTask.includes("patient") && filePath.includes("patient")) {
        score += 20;
    }
    if (normalizedTask.includes("appointment") && filePath.includes("appointment")) {
        score += 20;
    }
    if (normalizedTask.includes("scan") && filePath.includes("scan")) {
        score += 20;
    }
    if (normalizedTask.includes("service") && filePath.includes("/services/")) {
        score += 10;
    }
    if (normalizedTask.includes("backend") && file.category === "backend") {
        score += 12;
    }
    if (normalizedTask.includes("frontend") && file.category === "frontend") {
        score += 12;
    }
    if (file.path.includes("/routes/")) {
        score += 4;
    }
    if (file.path.includes("/controllers/")) {
        score += 4;
    }
    if (file.path.includes("/pages/")) {
        score += 4;
    }
    return score;
}
function rankRelevantFiles(args) {
    const { task, files, intent } = args;
    return files
        .map((file) => {
        const baseScore = scoreFile(file, task);
        const boost = intent
            ? (0, intentAwareScore_js_1.getIntentAwareScoreBoost)(file.path, "", intent)
            : 0;
        return {
            ...file,
            score: baseScore + boost
        };
    })
        .sort((a, b) => b.score - a.score);
}
//# sourceMappingURL=rankRelevantFiles.js.map