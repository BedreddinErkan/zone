import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildFileReadManifest } from "../compaction/ContextCompactor.js";
import { classifyTurns } from "../compaction/classifyTurns.js";
import type { ToolCallRecord } from "../compaction/types.js";
import type { ProcessorConfig, ProcessorContext, ProcessorResult, HistoryProcessor } from "./types.js";

export class ManifestInjectionProcessor implements HistoryProcessor {
  readonly config: ProcessorConfig;
  readonly name = "manifest-injection";
  readonly priority = 50;
  private _prevEntrySet: Set<string> = new Set();

  constructor(config: Extract<ProcessorConfig, { kind: "manifest_injection" }>) {
    this.config = config;
  }

  process(messages: ChatCompletionMessageParam[], ctx: ProcessorContext): ProcessorResult {
    const classified = classifyTurns(messages, ctx.toolCallLog as ToolCallRecord[]);
    const { manifest, entryCount, structuredEntries, capped } = buildFileReadManifest(messages, classified);
    if (entryCount === 0) return { kind: "passthrough" };
    const totalReads = structuredEntries.reduce((s, e) => s + e.readCount, 0);
    const topEntry = structuredEntries.reduce(
      (best, e) => (e.readCount > (best?.readCount ?? 0) ? e : best),
      structuredEntries[0] as (typeof structuredEntries)[0] | undefined,
    );
    ctx.emit("log", "[zone-file-manifest-injected]", {
      iter: ctx.iter + 1,
      entryCount,
      totalReads,
      topFile: topEntry?.filePath ?? null,
      topCount: topEntry?.readCount ?? 1,
      topLineRange: topEntry?.lineRange ?? "outline",
      runId: ctx.runId,
    });

    const currentEntrySet = new Set(structuredEntries.map((e) => e.filePath));
    const addedFiles = [...currentEntrySet].filter((f) => !this._prevEntrySet.has(f));
    const droppedFiles = [...this._prevEntrySet].filter((f) => !currentEntrySet.has(f));
    if (this._prevEntrySet.size > 0 && (addedFiles.length > 0 || droppedFiles.length > 0)) {
      ctx.emit("log", "[zone-manifest-set-growth]", {
        runId: ctx.runId,
        iter: ctx.iter + 1,
        prevEntryCount: this._prevEntrySet.size,
        newEntryCount: currentEntrySet.size,
        addedFiles,
        droppedFiles,
        cappedAtMax: capped,
      });
    }
    this._prevEntrySet = currentEntrySet;

    const manifestMsg: ChatCompletionMessageParam = {
      role: "user",
      content:
        `## Files already read this run\n${manifest}\n\n` +
        `Re-read ONLY if the file was modified since your last read.\n` +
        `Reference prior content by line number instead of re-reading.`,
    };
    return { kind: "transformed", messages: [...messages, manifestMsg] };
  }
}
