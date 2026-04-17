"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startZoneApiPerfRun = startZoneApiPerfRun;
function getNowMs() {
    return typeof globalThis.performance?.now === "function"
        ? globalThis.performance.now()
        : Date.now();
}
function formatMs(ms) {
    return `${Math.round(ms)}ms`;
}
function startZoneApiPerfRun(label) {
    const startedAt = getNowMs();
    let lastMarkAt = startedAt;
    console.log(`[zone-api-perf] ${label} start`);
    return {
        mark(stage) {
            const current = getNowMs();
            console.log(`[zone-api-perf] ${label} ${stage} +${formatMs(current - lastMarkAt)}`);
            lastMarkAt = current;
        },
        finish(stage = "complete") {
            const current = getNowMs();
            console.log(`[zone-api-perf] ${label} ${stage} total ${formatMs(current - startedAt)}`);
        },
    };
}
//# sourceMappingURL=zoneApiPerf.js.map