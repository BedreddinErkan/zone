const REDACT_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+\S{20,}/g,
  /(?:key|token|secret)=["']?[A-Za-z0-9._-]{20,}["']?/gi,
];

export function sanitizeDiagnostics(text: string): string {
  let result = text;
  for (const re of REDACT_PATTERNS) {
    result = result.replace(re, (match) => {
      if (/^Bearer\s/i.test(match)) return "Bearer [REDACTED]";
      const eqIdx = match.indexOf("=");
      if (eqIdx !== -1) return match.slice(0, eqIdx + 1) + "[REDACTED]";
      return "[REDACTED]";
    });
  }
  return result;
}
