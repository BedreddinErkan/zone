/**
 * Cross-site agreement for the assistant-text streaming event type (ledger item 327).
 *
 * Two sites name this type: the producer (`textDeltaStream` in runLlmPatchFlow.ts, which emits it)
 * and the consumer (the `bus.on(...)` registration in useAgentEvents.ts, which routes it to the
 * live-preview handler). Before this file they carried two independent copies of the string and
 * nothing crossed them — a mutation changing the producer's literal from "chat_chunk" to
 * "narration" survived the ENTIRE suite (501 files, 6372 tests, all green), because every existing
 * test drives one side alone: the adapter/loop tests stop below the producer, and the transcript
 * tests emit onto the bus by hand, supplying the type themselves rather than reading it.
 *
 * That silence is not cosmetic. "narration" is bound to `handleTextEvent`, whose text is committed
 * to <Static> via NARRATION_COMMIT — the exact duplicate-content routing the live-preview design
 * exists to prevent. So a one-word drift at the producer silently re-introduces the defect, and
 * the assertion that catches it must span both sites.
 *
 * Every assertion here reads BOTH sides. A test that reads one side only belongs elsewhere.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FLOW = path.join(process.cwd(), "src", "core", "runLlmPatchFlow.ts");
const HOOK = path.join(process.cwd(), "src", "cli", "tui", "hooks", "useAgentEvents.ts");
const SINK = path.join(process.cwd(), "src", "cli", "sink.ts");
const WIRE = path.join(process.cwd(), "src", "remote", "toWireFrame.ts");

/** The type literal `textDeltaStream` actually emits. */
function producerType(): string {
  const src = fs.readFileSync(FLOW, "utf8");
  const start = src.indexOf("const textDeltaStream");
  // Harness floor: if the closure were not found, every assertion below would compare undefined
  // to undefined and pass vacuously.
  expect(start, "textDeltaStream closure absent from runLlmPatchFlow.ts").toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf("};", start));
  const m = /type:\s*"([a-z_]+)"/.exec(body);
  expect(m, "textDeltaStream emits no literal type").not.toBeNull();
  return m![1]!;
}

/** The type string the TUI routes to the live-preview handler. */
function consumerType(): string {
  const src = fs.readFileSync(HOOK, "utf8");
  const m = /bus\.on\("([a-z_]+)",\s*handleStreamingAnswerEvent\)/.exec(src);
  expect(m, "no bus.on registration for handleStreamingAnswerEvent").not.toBeNull();
  return m![1]!;
}

/** Every type string bound to the narration/commit handler. */
function committedTypes(): string[] {
  const src = fs.readFileSync(HOOK, "utf8");
  return [...src.matchAll(/bus\.on\("([a-z_]+)",\s*handleTextEvent\)/g)].map((m) => m[1]!);
}

/** Does a consumer file carry a switch arm for this type? */
function hasCaseArm(file: string, type: string): boolean {
  return new RegExp(`case "${type}":`).test(fs.readFileSync(file, "utf8"));
}

describe("assistant-text streaming — producer and consumer name the same event type", () => {
  it("the type textDeltaStream emits is the type the live-preview handler is registered for", () => {
    expect(producerType()).toBe(consumerType());
  });

  it("the emitted type is NOT bound to the narration/commit handler — that routing is the duplicate-content defect", () => {
    const committed = committedTypes();
    // Floor: an empty list would make the containment check vacuous.
    expect(committed.length, "no handleTextEvent registrations found — extraction is broken").toBeGreaterThan(0);
    expect(committed).not.toContain(producerType());
  });

  // The TUI is one of THREE consumers. The first version of this file crossed the producer with
  // the TUI registration only, so a rename coordinated across those two would have silently
  // stopped headless stdout and the remote wire relay from matching — both fail open (a switch
  // falls through to a default), so neither would have raised anything.
  it("the headless sink carries an arm for the type the producer actually emits", () => {
    expect(hasCaseArm(SINK, producerType())).toBe(true);
  });

  it("the remote wire frame carries an arm for the type the producer actually emits", () => {
    expect(hasCaseArm(WIRE, producerType())).toBe(true);
  });

  it("negative control — hasCaseArm discriminates: a type no consumer handles is not reported as handled", () => {
    // Without this, hasCaseArm returning true unconditionally would make both assertions above
    // pass for any producer string at all.
    expect(hasCaseArm(SINK, "definitely_not_an_event_type")).toBe(false);
    expect(hasCaseArm(WIRE, "definitely_not_an_event_type")).toBe(false);
  });

  it("negative control — the extractors discriminate: they do not both return the same constant regardless of input", () => {
    // If either helper returned a fixed string, assertion 1 would pass no matter what the source
    // said. Pinning the observed values proves the extraction tracks the source rather than a
    // hardcoded answer, and pins the type itself against a silent rename.
    expect(producerType()).toBe("chat_chunk");
    expect(consumerType()).toBe("chat_chunk");
    expect(committedTypes()).toEqual(expect.arrayContaining(["narration", "chat_response"]));
  });
});
