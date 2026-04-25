import { describe, expect, it } from "vitest";
import {
  buildEmptyModelResponseDetailsLine,
  extractResponsesApiOutputText,
  formatResponsesTextExtractionFailure,
  getResponsesApiDiagnosticSnapshot,
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
