type ZoneApiPerfRun = {
  mark: (stage: string) => void;
  finish: (stage?: string) => void;
};

function getNowMs(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

export function startZoneApiPerfRun(label: string): ZoneApiPerfRun {
  const startedAt = getNowMs();
  let lastMarkAt = startedAt;
  console.log(`[zone-api-perf] ${label} start`);

  return {
    mark(stage: string) {
      const current = getNowMs();
      console.log(
        `[zone-api-perf] ${label} ${stage} +${formatMs(current - lastMarkAt)}`
      );
      lastMarkAt = current;
    },
    finish(stage = "complete") {
      const current = getNowMs();
      console.log(
        `[zone-api-perf] ${label} ${stage} total ${formatMs(current - startedAt)}`
      );
    },
  };
}
