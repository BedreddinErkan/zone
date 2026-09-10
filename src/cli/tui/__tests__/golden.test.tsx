import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayEvents } from "./replayHarness.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

const fixturesDir = join(__dirname, "fixtures");

function loadFixture(name: string): ZoneStructuredProgressEvent[] {
  return readFileSync(join(fixturesDir, name), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ZoneStructuredProgressEvent);
}

describe("golden replay tests", () => {
  it("run-with-tool-calls renders expected transcript", async () => {
    const events = loadFixture("run-with-tool-calls.jsonl");
    const harness = await replayEvents(events);
    expect(harness.lastFrame()).toMatchSnapshot();
    harness.unmount();
  });

  it("approval-modal-cycle renders approval modal", async () => {
    const events = loadFixture("approval-modal-cycle.jsonl");
    const harness = await replayEvents(events);
    expect(harness.lastFrame()).toMatchSnapshot();
    harness.unmount();
  });

  it("resize-sequence remounts transcript cleanly", async () => {
    const events = loadFixture("resize-sequence.jsonl");
    const harness = await replayEvents(events);
    expect(harness.lastFrame()).toMatchSnapshot();
    harness.unmount();
  });

  it("todos-run: plan_snapshot entries rendered in transcript frame", async () => {
    const events = loadFixture("todos-run.jsonl");
    const harness = await replayEvents(events);
    const frame = harness.lastFrame();
    // plan_snapshot entries render todo text — verify key steps appear
    expect(frame).toContain("Read the source files");
    expect(frame).toContain("Implement the fix");
    expect(frame).toContain("Run the tests");
    // The revised plan added a 4th todo
    expect(frame).toContain("Update documentation");
    // The frame should contain snapshot glyphs (successMark for completed)
    expect(frame).toContain("✓");
    harness.unmount();
  });

  it("flood test: 10,000 synthetic events do not crash the reducer", async () => {
    const events: ZoneStructuredProgressEvent[] = [];
    events.push({
      runId: "flood-test",
      ts: Date.now(),
      type: "agent_loop_start",
      title: "Starting flood test",
    });

    for (let i = 0; i < 10000; i++) {
      events.push({
        runId: "flood-test",
        ts: Date.now() + i,
        type: "narration",
        title: "",
        text: `Fragment ${i}`,
      } as ZoneStructuredProgressEvent);
    }

    events.push({
      runId: "flood-test",
      ts: Date.now() + 10001,
      type: "agent_loop_complete",
      title: "Done",
      iter_count: 1,
    } as ZoneStructuredProgressEvent);

    // This should not throw.
    const harness = await replayEvents(events);
    expect(harness.lastFrame()).toBeTruthy();
    harness.unmount();
  });
});
