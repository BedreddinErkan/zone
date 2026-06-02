import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildEmptyModelResponseDetailsLine,
  extractResponsesApiOutputText,
  formatResponsesTextExtractionFailure,
  getResponsesApiDiagnosticSnapshot,
  getModelName,
} from "./openaiClient.js";

describe("extractResponsesApiOutputText", () => {
  it("reads response.output_text", () => {
    const r = extractResponsesApiOutputText({
      output_text: "  hello world  ",
      output: [],
    });
    expect(r).toEqual({ ok: true, text: "hello world" });
  });

  it("reads message content output_text blocks", () => {
    const r = extractResponsesApiOutputText({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "patch\nbody" },
            { type: "text", text: "ignored duplicate" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("patch");
  });

  it("reads choices[0].message.content string (chat-completions shape)", () => {
    const r = extractResponsesApiOutputText({
      choices: [{ message: { content: "from chat" } }],
    });
    expect(r).toEqual({ ok: true, text: "from chat" });
  });

  it("returns refusal when present and no text", () => {
    const r = extractResponsesApiOutputText({
      output: [],
      refusal: "policy block",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("refusal");
      expect(formatResponsesTextExtractionFailure(r)).toContain("policy");
    }
  });

  it("returns incomplete when incomplete_details set", () => {
    const r = extractResponsesApiOutputText({
      output: [],
      incomplete_details: { reason: "max_tokens" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("incomplete");
  });
});

describe("getModelName — gemini branch (Bug A fix)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns gemini-3.5-flash for standard tier", () => {
    expect(getModelName("standard", "gemini", undefined)).toBe("gemini-3.5-flash");
  });

  it("returns gemini-3.1-pro for high tier", () => {
    expect(getModelName("high", "gemini", undefined)).toBe("gemini-3.1-pro");
  });

  it("ZONE_GEMINI_MODEL env var takes precedence over catalog default", () => {
    vi.stubEnv("ZONE_GEMINI_MODEL", "gemini-custom-model");
    expect(getModelName("standard", "gemini", undefined)).toBe("gemini-custom-model");
  });

  it("invalid claude-* override for gemini warns and falls back to catalog default, not gpt-5.4-mini", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = getModelName("standard", "gemini", { standard: "claude-sonnet-4-6" });
    expect(result).toBe("gemini-3.5-flash");
    expect(result).not.toBe("gpt-5.4-mini");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("is not valid for provider"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to gemini-3.5-flash"));
    warnSpy.mockRestore();
  });
});

describe("getResponsesApiDiagnosticSnapshot / buildEmptyModelResponseDetailsLine", () => {
  it("builds non-empty JSON details for empty body", () => {
    const response = {
      status: "completed",
      output: [{ type: "message", content: [{ type: "text", text: "" }] }],
      output_text: "",
    };
    const ext = extractResponsesApiOutputText(response);
    expect(ext.ok).toBe(false);
    const line = buildEmptyModelResponseDetailsLine({
      response,
      extraction: ext as Extract<
        ReturnType<typeof extractResponsesApiOutputText>,
        { ok: false }
      >,
      linearReasonWhenExtractionOk: "unused",
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.outputLength).toBe(1);
    expect(parsed.responseStatus).toBe("completed");
    expect(getResponsesApiDiagnosticSnapshot(response).contentTypes.length).toBeGreaterThan(
      0
    );
  });
});
