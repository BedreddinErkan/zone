import { describe, it, expect } from "vitest";
import { sanitizeDiagnostics } from "./sanitizeDiagnostics.js";

describe("sanitizeDiagnostics", () => {
  it("redacts Anthropic sk-ant- keys", () => {
    const input = "key: sk-ant-api03-abcdef1234567890abcdef1234567890";
    expect(sanitizeDiagnostics(input)).toBe("key: [REDACTED]");
  });

  it("redacts OpenAI sk- keys (20+ chars)", () => {
    const input = "token sk-ABCDEF1234567890ABCDEF extra";
    expect(sanitizeDiagnostics(input)).toBe("token [REDACTED] extra");
  });

  it("does not redact short sk- tokens", () => {
    const input = "sk-short";
    expect(sanitizeDiagnostics(input)).toBe("sk-short");
  });

  it("redacts Bearer tokens (20+ chars)", () => {
    const input = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(sanitizeDiagnostics(input)).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts key= patterns with long values", () => {
    const input = "config: key=supersecretvalue12345678 other";
    expect(sanitizeDiagnostics(input)).toBe("config: key=[REDACTED] other");
  });

  it("redacts token= patterns with long values", () => {
    const input = "token=abcdef1234567890abcdef";
    expect(sanitizeDiagnostics(input)).toBe("token=[REDACTED]");
  });

  it("redacts secret= patterns", () => {
    const input = 'secret="mysupersecretvalue12345678"';
    expect(sanitizeDiagnostics(input)).toBe("secret=[REDACTED]");
  });

  it("leaves normal log content untouched", () => {
    const input = '{"model":"claude-sonnet-4-6","iterIndex":1,"costUsd":0.0025}';
    expect(sanitizeDiagnostics(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(sanitizeDiagnostics("")).toBe("");
  });

  it("handles multiple secrets in one string", () => {
    const input = "sk-ant-secret123456789abc Bearer longtoken12345678901234";
    const result = sanitizeDiagnostics(input);
    expect(result).not.toContain("sk-ant-secret");
    expect(result).not.toContain("longtoken");
    expect(result).toContain("[REDACTED]");
  });
});
