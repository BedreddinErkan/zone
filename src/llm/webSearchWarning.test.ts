import { describe, it, expect, beforeEach } from "vitest";
import {
  warnWebSearchDegradationOnce,
  _resetWebSearchDegradationWarnedForTest,
} from "./webSearchWarning.js";

beforeEach(() => {
  _resetWebSearchDegradationWarnedForTest();
});

describe("warnWebSearchDegradationOnce", () => {
  it("fires once when provider is non-Anthropic and webSearchEnabled=true", () => {
    const messages: string[] = [];
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: true, isSubagent: false, onProgress: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("openai");
    expect(messages[0]).toContain("Anthropic");
  });

  it("is silent on a second call with the same provider", () => {
    const messages: string[] = [];
    const opts = { provider: "openai", webSearchEnabled: true, isSubagent: false, onProgress: (m: string) => messages.push(m) };
    warnWebSearchDegradationOnce(opts);
    warnWebSearchDegradationOnce(opts);
    expect(messages).toHaveLength(1);
  });

  it("fires again for a different provider", () => {
    const messages: string[] = [];
    const cb = (m: string) => messages.push(m);
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: true, isSubagent: false, onProgress: cb });
    warnWebSearchDegradationOnce({ provider: "gemini", webSearchEnabled: true, isSubagent: false, onProgress: cb });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("gemini");
  });

  it("is silent when webSearchEnabled=false", () => {
    const messages: string[] = [];
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: false, isSubagent: false, onProgress: (m) => messages.push(m) });
    expect(messages).toHaveLength(0);
  });

  it("is silent when provider is anthropic", () => {
    const messages: string[] = [];
    warnWebSearchDegradationOnce({ provider: "anthropic", webSearchEnabled: true, isSubagent: false, onProgress: (m) => messages.push(m) });
    expect(messages).toHaveLength(0);
  });

  it("is silent for subagents", () => {
    const messages: string[] = [];
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: true, isSubagent: true, onProgress: (m) => messages.push(m) });
    expect(messages).toHaveLength(0);
  });

  it("fires again after reset", () => {
    const messages: string[] = [];
    const cb = (m: string) => messages.push(m);
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: true, isSubagent: false, onProgress: cb });
    _resetWebSearchDegradationWarnedForTest();
    warnWebSearchDegradationOnce({ provider: "openai", webSearchEnabled: true, isSubagent: false, onProgress: cb });
    expect(messages).toHaveLength(2);
  });
});
