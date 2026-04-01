export interface ExecutionPhase {
  name: string;
  start: number;
  end?: number;
}

export class ExecutionTracker {
  private phases: ExecutionPhase[] = [];
  private startedAt = Date.now();

  startPhase(name: string) {
    this.phases.push({
      name,
      start: Date.now()
    });
  }

  endPhase(name: string) {
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