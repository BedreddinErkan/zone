"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankRelevantFiles = rankRelevantFiles;
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
function rankRelevantFiles(files, task) {
    return [...files]
        .map((file) => ({
        file,
        score: scoreFile(file, task)
    }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((item) => item.file);
}
//# sourceMappingURL=rankRelevantFiles.js.map