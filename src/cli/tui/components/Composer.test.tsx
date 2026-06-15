import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ImageAttachment } from "../../../api/imageUpload.js";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { StoreProvider, useStore } from "../store.js";
import { Composer } from "./Composer.js";
import {
  chipLabel,
  expandSentinels,
  renderBuffer,
  PUA_STRIP_RE,
} from "./Composer.js";

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Reads the last user_prompt transcript entry and renders it into lastFrame() with a
// detectable prefix, so T3 can assert what USER_PROMPT dispatch received.
function DispatchLogger(): React.ReactElement {
  const { state } = useStore();
  const last = [...state.transcript].reverse().find((e) => e.kind === "user_prompt");
  return <Text>{`[DISPATCH]${last?.text ?? ""}`}</Text>;
}

// Helper: create PUA sentinel char for paste #N (1-indexed, matching PUA_BASE = 0xe000).
const pua = (n: number) => String.fromCharCode(0xe000 + n - 1);

type PasteEntry = { num: number; fullText: string; lines: number };

function makeEntry(overrides?: Partial<PasteEntry>): PasteEntry {
  return { num: 1, fullText: "full text", lines: 3, ...overrides };
}

function makeMap(entries: [string, PasteEntry][]): Map<string, PasteEntry> {
  return new Map(entries);
}

// ─── chipLabel ────────────────────────────────────────────────────────────────

describe("chipLabel", () => {
  it("formats the label correctly", () => {
    expect(chipLabel({ num: 3, fullText: "x", lines: 12 })).toBe(
      "[Pasted text #3 +12 lines]"
    );
  });

  it("handles singular line count", () => {
    expect(chipLabel({ num: 1, fullText: "x", lines: 1 })).toBe(
      "[Pasted text #1 +1 lines]"
    );
  });
});

// ─── expandSentinels ──────────────────────────────────────────────────────────

describe("expandSentinels", () => {
  it("passes through normal text unchanged", () => {
    expect(expandSentinels("hello", new Map())).toBe("hello");
  });

  it("expands a registered sentinel in the middle of text", () => {
    const s = pua(1);
    const map = makeMap([[s, makeEntry({ num: 1, lines: 6 })]]);
    expect(expandSentinels(`before${s}after`, map)).toBe(
      "before[Pasted text #1 +6 lines]after"
    );
  });

  it("expands a sentinel at the start", () => {
    const s = pua(1);
    const map = makeMap([[s, makeEntry({ num: 1, lines: 8 })]]);
    expect(expandSentinels(`${s}tail`, map)).toBe(
      "[Pasted text #1 +8 lines]tail"
    );
  });

  it("expands a sentinel at the end", () => {
    const s = pua(1);
    const map = makeMap([[s, makeEntry({ num: 1, lines: 6 })]]);
    expect(expandSentinels(`head${s}`, map)).toBe(
      "head[Pasted text #1 +6 lines]"
    );
  });

  it("passes through an unknown PUA char that is not a registered sentinel", () => {
    const unknown = pua(5); // paste slot #5, but never registered
    expect(expandSentinels(`x${unknown}y`, new Map())).toBe(`x${unknown}y`);
  });

  it("expands two sequentially-numbered sentinels", () => {
    const s1 = pua(1);
    const s2 = pua(2);
    const map = makeMap([
      [s1, makeEntry({ num: 1, lines: 6 })],
      [s2, makeEntry({ num: 2, lines: 10 })],
    ]);
    expect(expandSentinels(`${s1}mid${s2}`, map)).toBe(
      "[Pasted text #1 +6 lines]mid[Pasted text #2 +10 lines]"
    );
  });
});

// ─── renderBuffer ─────────────────────────────────────────────────────────────

describe("renderBuffer", () => {
  const s = pua(1);
  const label = "[Pasted text #1 +6 lines]";
  let map: Map<string, PasteEntry>;

  beforeEach(() => {
    map = makeMap([[s, makeEntry({ num: 1, lines: 6 })]]);
  });

  it("cursor before a sentinel → ▋ appears before the chip label", () => {
    // buf = sentinel, cursor at raw pos 0 (before sentinel)
    expect(renderBuffer(s, 0, map)).toBe(`▋${label}`);
  });

  it("cursor after a sentinel → ▋ appears after the chip label", () => {
    // buf = sentinel, cursor at raw pos 1 (after sentinel)
    expect(renderBuffer(s, 1, map)).toBe(`${label}▋`);
  });

  it("cursor in plain text before sentinel → ▋ in text, chip after", () => {
    // buf = "ab" + sentinel, cursor at raw pos 1 (between 'a' and 'b')
    expect(renderBuffer(`ab${s}`, 1, map)).toBe(`a▋b${label}`);
  });

  it("cursor in plain text after sentinel → chip, then ▋ in text", () => {
    // buf = sentinel + "ab", cursor at raw pos 2 (between 'a' and 'b')
    expect(renderBuffer(`${s}ab`, 2, map)).toBe(`${label}a▋b`);
  });

  it("no sentinel → plain string with cursor spliced in", () => {
    expect(renderBuffer("hello", 3, new Map())).toBe("hel▋lo");
  });

  it("cursor at end of buffer with sentinel", () => {
    expect(renderBuffer(`text${s}`, 5, map)).toBe(`text${label}▋`);
  });
});

// ─── Single-pass expansion safety (T6) ────────────────────────────────────────
// Verifies that fullText containing a PUA char is NOT double-expanded when that
// char also happens to match a different sentinel slot.

describe("single-pass expansion safety", () => {
  it("PUA char in fullText not treated as another sentinel during expansion", () => {
    const s1 = pua(1); // paste slot #1 = U+E000
    const puaInContent = pua(2); // U+E001 — present in the content, NOT a registered sentinel
    const fullText = `line1\nline2\nline3\nline4\nline5\n${puaInContent}line6`;
    const map = makeMap([[s1, makeEntry({ num: 1, fullText, lines: 6 })]]);

    // Simulate the single-pass submitBuffer loop over a buffer that is just s1:
    let agentText = "";
    for (const ch of s1) {
      const entry = map.get(ch);
      agentText += entry ? entry.fullText : ch;
    }

    // fullText emitted verbatim; the PUA char inside it is NOT further processed
    expect(agentText).toBe(fullText);
    expect(agentText).toContain(puaInContent);
  });
});

// ─── PUA_STRIP_RE (T7) ────────────────────────────────────────────────────────

describe("PUA_STRIP_RE", () => {
  it("strips U+E000 (first BMP PUA slot)", () => {
    const s = pua(1); // U+E000
    expect(s.replace(PUA_STRIP_RE, "")).toBe("");
  });

  it("strips U+F8FF (last BMP PUA slot)", () => {
    const last = String.fromCharCode(0xf8ff);
    expect(last.replace(PUA_STRIP_RE, "")).toBe("");
  });

  it("strips a PUA char embedded in plain text", () => {
    const pua5 = pua(6); // U+E005
    expect(`hello${pua5}world`.replace(PUA_STRIP_RE, "")).toBe("helloworld");
  });

  it("does NOT strip U+F900 (CJK compat ideographs, just above PUA)", () => {
    const f900 = "豈"; // 豈 — first CJK Compatibility Ideograph, outside PUA
    expect(f900.replace(PUA_STRIP_RE, "")).toBe(f900);
  });

  it("does NOT strip U+DFFF (last surrogate, below PUA range)", () => {
    // U+DFFF is a surrogate code unit — not in E000-F8FF range
    // We compare with a char just below PUA_BASE
    const belowPua = String.fromCharCode(0xdfff);
    expect(belowPua.replace(PUA_STRIP_RE, "")).toBe(belowPua);
  });

  it("does NOT strip regular ASCII or Unicode text", () => {
    const text = "Hello, 世界! 🎉";
    expect(text.replace(PUA_STRIP_RE, "")).toBe(text);
  });
});

// ─── T3: submitBuffer dispatch routing (component integration) ───────────────
// Verifies collapsed pastes route FULL text to both USER_PROMPT dispatch and
// onSubmit. Uses the real StoreProvider + DispatchLogger (defined at the top of
// this file) to observe what dispatch received without mocking the store module.
//
// Stage 1 test debt — not yet implemented (T3 harness established the pattern):
//   T1: chip label renders in composer frame while editing
//   T2: atomic backspace — one Backspace removes the whole chip
//   T4: counter numbering + reset — two pastes produce #1/#2; submit resets
//   T5: sub-threshold paste inlines (< PASTE_THRESHOLD_LINES AND < PASTE_THRESHOLD_BYTES)

describe("Composer — submitBuffer dispatch routing (T3)", () => {
  it("collapsed paste: USER_PROMPT dispatch and onSubmit both receive full pasted text", async () => {
    const mockOnSubmit = vi.fn();
    const SIX_LINES = "line1\nline2\nline3\nline4\nline5\nline6";

    const { stdin, lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Composer onSubmit={mockOnSubmit} onExit={() => {}} />
        <DispatchLogger />
      </StoreProvider>
    );

    // Paste 6 lines (>= PASTE_THRESHOLD_LINES = 6) via bracketed-paste sequence
    stdin.write(`\x1b[200~${SIX_LINES}\x1b[201~`);
    await wait(50);

    // Submit
    stdin.write("\r");
    await wait(50);

    // onSubmit receives the full pasted text, not a chip label
    expect(mockOnSubmit).toHaveBeenCalledOnce();
    expect(mockOnSubmit.mock.calls[0][0]).toBe(SIX_LINES);

    // USER_PROMPT dispatch carried the full text — DispatchLogger renders it into lastFrame()
    expect(lastFrame()).toContain("[DISPATCH]line1");

    unmount();
  });

  it("same-chunk paste+CR: onSubmit fires with full paste text (regression for paste+Enter race)", async () => {
    const mockOnSubmit = vi.fn();
    const SIX_LINES = "line1\nline2\nline3\nline4\nline5\nline6";

    const { stdin, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Composer onSubmit={mockOnSubmit} onExit={() => {}} />
        <DispatchLogger />
      </StoreProvider>
    );

    // Single stdin.write: bracketed-paste end marker + CR in same chunk — the bug scenario
    stdin.write(`\x1b[200~${SIX_LINES}\x1b[201~\r`);
    await wait(50);

    expect(mockOnSubmit).toHaveBeenCalledOnce();
    expect(mockOnSubmit.mock.calls[0][0]).toContain(SIX_LINES);

    unmount();
  });

  it("typed prefix then same-chunk paste+CR: onSubmit gets prefix + full paste", async () => {
    const mockOnSubmit = vi.fn();
    const SIX_LINES = "line1\nline2\nline3\nline4\nline5\nline6";

    const { stdin, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Composer onSubmit={mockOnSubmit} onExit={() => {}} />
        <DispatchLogger />
      </StoreProvider>
    );

    // Type a short prefix (below paste threshold — inlines directly into buffer)
    stdin.write("prefix ");
    await wait(50);

    // Single write: paste + CR in same chunk
    stdin.write(`\x1b[200~${SIX_LINES}\x1b[201~\r`);
    await wait(50);

    expect(mockOnSubmit).toHaveBeenCalledOnce();
    const submitted = mockOnSubmit.mock.calls[0][0] as string;
    expect(submitted).toContain("prefix");
    expect(submitted).toContain(SIX_LINES);

    unmount();
  });

  it("CRLF in pasted content is normalized to LF before onSubmit", async () => {
    const mockOnSubmit = vi.fn();
    const CRLF_LINES = "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6";

    const { stdin, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Composer onSubmit={mockOnSubmit} onExit={() => {}} />
        <DispatchLogger />
      </StoreProvider>
    );

    stdin.write(`\x1b[200~${CRLF_LINES}\x1b[201~`);
    await wait(50);

    stdin.write("\r");
    await wait(50);

    expect(mockOnSubmit).toHaveBeenCalledOnce();
    const received = mockOnSubmit.mock.calls[0][0] as string;
    expect(received).not.toContain("\r");
    expect(received).toContain("line1\nline2\nline3\nline4\nline5\nline6");

    unmount();
  });
});

// ─── @ file injection — wiring (T-AT) ──────────────────────────────────────
// Verifies the select→ref→submit→inject wiring end-to-end:
//   (a) onSubmit receives agentText WITH the injected file content block
//   (b) USER_PROMPT dispatch (transcript) sees only the path, NOT the content

const mockReadAtFileContext = vi.hoisted(() => vi.fn<[], Promise<string | null>>());
const mockFg = vi.hoisted(() => vi.fn<[], Promise<string[]>>());
const mockSupportsVisionFn = vi.hoisted(() => vi.fn<[string], boolean>());
const mockReadImageFromFileFn = vi.hoisted(() => vi.fn<[string], Promise<ImageAttachment>>());
const mockValidateAttachmentsFn = vi.hoisted(() => vi.fn<[ImageAttachment[]], { ok: boolean; error?: string }>());

vi.mock("../atFileContext.js", () => ({ readAtFileContext: mockReadAtFileContext }));
vi.mock("fast-glob", () => ({ default: mockFg }));
vi.mock("../../../llm/modelRegistry.js", () => ({ supportsVision: mockSupportsVisionFn }));
vi.mock("../../../api/imageUpload.js", () => ({
  readImageFromFile: mockReadImageFromFileFn,
  validateAttachments: mockValidateAttachmentsFn,
}));

describe("@ file injection — wiring (T-AT)", () => {
  it("onSubmit receives file content block; USER_PROMPT dispatch does not", async () => {
    const FILE_PATH = "src/foo.ts";
    const FILE_CTX = `=== ${FILE_PATH} ===\nconst x = 1;\n`;

    mockFg.mockResolvedValue([FILE_PATH]);
    mockReadAtFileContext.mockResolvedValue(FILE_CTX);

    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Composer onSubmit={onSubmit} onExit={() => {}} />
        <DispatchLogger />
      </StoreProvider>
    );

    // Open @ palette and wait for fg effect to resolve
    stdin.write("@");
    await wait(100);

    // Select the first file (buffer becomes "src/foo.ts", lastAtSelectedPath set)
    stdin.write("\r");
    await wait(50);

    // Submit; async submitBuffer reads file content then calls onSubmit
    stdin.write("\r");
    await wait(100);

    expect(onSubmit).toHaveBeenCalledOnce();
    // model sees task + injected content block
    expect(onSubmit.mock.calls[0][0]).toContain("=== src/foo.ts ===");

    // transcript (USER_PROMPT dispatch) contains only the path, not the content
    expect(lastFrame()).toContain(`[DISPATCH]${FILE_PATH}`);
    expect(lastFrame()).not.toContain("=== src/foo.ts ===");

    unmount();
  });
});

// ─── T-VISION: vision gate in submitBuffer ────────────────────────────────────
// Verifies that when the current model doesn't support vision and an image is
// staged, submitBuffer aborts and onSubmit is never called.

function ToastLogger(): React.ReactElement {
  const { state } = useStore();
  return (
    <>
      {state.toastQueue.map((toast, i) => (
        <Text key={i}>{`[TOAST]${toast.message}`}</Text>
      ))}
    </>
  );
}

describe("Composer — vision gate (T-VISION)", () => {
  beforeEach(() => {
    mockSupportsVisionFn.mockReturnValue(false);
    mockReadImageFromFileFn.mockResolvedValue({ mediaType: "image/png", base64: "abc123" });
    mockValidateAttachmentsFn.mockReturnValue({ ok: true });
  });

  it("non-vision model + staged image → onSubmit not called, warning toast shown", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "no-vision-model", capUsd: 10 }}>
        <Composer onSubmit={onSubmit} onExit={() => {}} />
        <ToastLogger />
      </StoreProvider>
    );

    // Stage an image via /image command with inline args.
    // Write the full string at once (not char-by-char) to avoid React batching
    // dropping intermediate setBuffer calls within the same synchronous tick.
    stdin.write("/image screenshot.png");
    await wait(50);
    stdin.write("\r"); // executes /image slash command with args
    await wait(200);   // wait for async readImageFromFile.then() to settle

    // Type a task and try to submit (whole string at once, same reason)
    stdin.write("describe this");
    await wait(50);
    stdin.write("\r"); // submitBuffer fires, vision gate should block
    await wait(100);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("doesn't support images");

    unmount();
  });
});
