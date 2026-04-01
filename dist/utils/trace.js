"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTraceId = generateTraceId;
function generateTraceId() {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `trace_${ts}_${rand}`;
}
//# sourceMappingURL=trace.js.map