import type { BootData, SubagentThread, TranscriptEntry } from "./store-core.js";

export const PRINT_BATCH_SIZE = 64;

/** Runtime-only output, independent of compacted/persisted logical history. */
export type PrintContent =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "welcome"; boot: BootData }
  | { kind: "group_header"; thread: SubagentThread }
  | { kind: "group_footer"; thread: SubagentThread };
export type PrintRecord = Readonly<PrintContent & { seq: number }>;
export interface PrintDelivery {
  epoch: number;
  nextSeq: number;
  acknowledged: number;
  pending: PrintRecord[];
  active: { from: number; through: number; submitted: boolean } | null;
  openChild: SubagentThread | null;
}

export function enqueuePrint(delivery: PrintDelivery, content: PrintContent): PrintDelivery {
  // Snapshot payloads, including restored entries and tool argument/result arrays.
  // Never retain already-acknowledged records. Pending memory follows the unflushed
  // backlog, not session duration; a stalled terminal has no lossless hard cap here.
  return { ...delivery, nextSeq: delivery.nextSeq + 1,
    pending: [...delivery.pending, { ...structuredClone(content), seq: delivery.nextSeq }] };
}

export function closePrintGroup(delivery: PrintDelivery, threads: Record<string, SubagentThread>): PrintDelivery {
  if (!delivery.openChild) return delivery;
  const thread = threads[delivery.openChild.subagentId] ?? delivery.openChild;
  return { ...enqueuePrint(delivery, { kind: "group_footer", thread }), openChild: null };
}

export function enqueuePrintEntry(delivery: PrintDelivery, entry: TranscriptEntry,
  threads: Record<string, SubagentThread>): PrintDelivery {
  const sid = "subagentId" in entry ? entry.subagentId : undefined;
  if (sid && delivery.openChild?.subagentId !== sid) {
    delivery = closePrintGroup(delivery, threads);
    const thread = threads[sid] ?? { subagentId: sid, subagentType: "worker", title: "", status: "running", toolCallCount: 0 };
    delivery = { ...enqueuePrint(delivery, { kind: "group_header", thread }), openChild: { ...thread } };
  }
  return enqueuePrint(delivery, { kind: "entry", entry });
}

/** Explicit presentation only: startup, restore, or the existing clear-and-redraw operation. */
export function createPrintDelivery(epoch: number, transcript: TranscriptEntry[],
  threads: Record<string, SubagentThread>, boot: BootData | null): PrintDelivery {
  let delivery: PrintDelivery = { epoch, nextSeq: 1, acknowledged: 0, pending: [], active: null, openChild: null };
  if (boot) delivery = enqueuePrint(delivery, { kind: "welcome", boot });
  for (const entry of transcript) {
    const sid = "subagentId" in entry ? entry.subagentId : undefined;
    if (delivery.openChild && delivery.openChild.subagentId !== sid) delivery = closePrintGroup(delivery, threads);
    delivery = enqueuePrintEntry(delivery, entry, threads);
  }
  return closePrintGroup(delivery, threads);
}
