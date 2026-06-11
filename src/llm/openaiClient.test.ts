import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildEmptyModelResponseDetailsLine,
  extractResponsesApiOutputText,
  formatResponsesTextExtractionFailure,
  getResponsesApiDiagnosticSnapshot,
  getModelName,
  _resetGpt5WarnForTest,
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

describe("getModelName — cross-provider override rejection (924285f regression guard)", () => {
  // This block guards the loud-rejection / no-silent-swap behavior that 924285f
  // restored. Previously a cross-provider override (provider=openai + model=claude-*)
  // silently fell back to the openai default with no user-visible signal. The fix
  // warns and names the fallback target so the user can never believe Claude ran
  // when OpenAI ran. These tests pin that behavior for the remaining providers.

  beforeEach(() => { _resetGpt5WarnForTest(); });

  it("invalid claude-* override for openai warns and falls back to openai standard default", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = getModelName("standard", "openai", { standard: "claude-sonnet-4-6" });
    expect(result).toBe("gpt-4o-mini");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("is not valid for provider"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to gpt-4o-mini"));
    warnSpy.mockRestore();
  });

  it("invalid gpt-* override for anthropic warns and falls back to anthropic high default", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = getModelName("high", "anthropic", { high: "gpt-5.4" });
    expect(result).toBe("claude-sonnet-4-6");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("is not valid for provider"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to claude-sonnet-4-6"));
    warnSpy.mockRestore();
  });

  it("valid non-reasoning same-provider override (gpt-4o) is accepted without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = getModelName("high", "openai", { high: "gpt-4o" });
    expect(result).toBe("gpt-4o");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("getModelName — gpt-5.x mid-session guard", () => {
  // Covers the dispatch.ts path: modelOverride:{high:"gpt-5.x"} from store state bypasses
  // config.ts; getModelName is the single convergence point that intercepts it.

  beforeEach(() => { _resetGpt5WarnForTest(); });

  it("gpt-5.4 override returns gpt-4o and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getModelName("high", "openai", { high: "gpt-5.4" })).toBe("gpt-4o");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Responses API"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call: flag already set — no additional warn
    expect(getModelName("high", "openai", { high: "gpt-5.4" })).toBe("gpt-4o");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("all gpt-5 family members fall back to gpt-4o", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const id of ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"]) {
      _resetGpt5WarnForTest();
      expect(getModelName("high", "openai", { high: id })).toBe("gpt-4o");
    }
    warnSpy.mockRestore();
  });

  it("gpt-4o override is accepted without triggering the guard", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getModelName("high", "openai", { high: "gpt-4o" })).toBe("gpt-4o");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("standard default (no override) resolves to gpt-4o-mini without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getModelName("standard", "openai")).toBe("gpt-4o-mini");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("high default (no override) resolves to gpt-4o without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getModelName("high", "openai")).toBe("gpt-4o");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("anthropic path is unaffected", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getModelName("high", "anthropic", { high: "claude-sonnet-4-6" })).toBe("claude-sonnet-4-6");
    expect(warnSpy).not.toHaveBeenCalled();
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
