"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionTracker = void 0;
class ExecutionTracker {
    phases = [];
    startedAt = Date.now();
    startPhase(name) {
        this.phases.push({
            name,
            start: Date.now()
        });
    }
    endPhase(name) {
        const phase = [...this.phases].reverse().find((p) => p.name === name && !p.end);
        if (phase) {
            phase.end = Date.now();
        }
    }
    build() {
        const finishedAt = Date.now();
        return {
            startedAt: new Date(this.startedAt).toISOString(),
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs: finishedAt - this.startedAt,
            phases: this.phases.map((p) => ({
                name: p.name,
                durationMs: p.end ? p.end - p.start : 0
            }))
        };
    }
}
exports.ExecutionTracker = ExecutionTracker;
//# sourceMappingURL=executionTracker.js.map