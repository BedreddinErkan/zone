import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolResult } from "../tools/toolExecutor.js";

// ── HookResult discriminated union ────────────────────────────────────────────

export type HookResult =
  | { kind: "passthrough" }
  | {
      kind: "appendContext";
      content: string;
      target: "responseInput" | "wireMessages";
      mode: "append-to-tool" | "push-user";
      /**
       * mode=push-user to responseInput shifts Anthropic cache breakpoint #2
       * off the original task — cache miss every iter the content varies.
       * Must opt in explicitly. Legal only when no preceding role:tool exists
       * (iter 0 before any tool ran). Default false enforces Pattern A discipline.
       */
      allowResponseInputUserPush?: boolean;
    }
  | {
      kind: "mutateResult";
      /** Replaces the just-pushed tool_result content. PostToolUse only. */
      updatedOutput: string;
    }
  | {
      kind: "block";
      reason: string;
      /** terminate=true ends the run with terminationReason="hook_blocked". */
      terminate: boolean;
    }
  | {
      kind: "failure";
      /** Wrapped from a hook that threw. Framework emits [zone-hook-error] then rethrows. */
      error: unknown;
    };

// ── Pre-iteration hook (sites 1, 2, 3 — fires before the LLM call) ───────────

export interface PreIterationContext {
  iter: number;
  runId: string | null;
  /** Read-only view — mutations are returned via HookResult, not in-place. */
  responseInput: readonly ChatCompletionMessageParam[];
  /** Read-only view of the R.2-pruned message set built this iter. */
  wireMessages: readonly ChatCompletionMessageParam[];
  iterationBudget: { maxIterationsForRun: number };
  cumulativeTokens: number;
  /** Cache-discounted token sum: cache_read × 0.1, others × 1.0. Use for budget-ratio checks. */
  effectiveCumulativeTokens: number;
  effectiveTokenBudgetCap: number;
  midWarnInjected: boolean;
  emit: (level: "log" | "debugLog", marker: string, payload: object) => void;
}

export interface PreIterationHook {
  name: string;
  /** Lower fires first. Default 100. Ties broken FIFO (registration order). */
  priority?: number;
  shouldRun?(ctx: PreIterationContext): boolean;
  run(ctx: PreIterationContext): HookResult;
}

// ── Post-tool-use hook (sites 5, 6 — fires after each tool result is pushed) ──

export interface PostToolUseContext {
  iter: number;
  runId: string | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  toolResult: ToolResult;
  /** Read-only view including the just-pushed role:tool message. */
  responseInput: readonly ChatCompletionMessageParam[];
  loopDetectorState: { count: number; status: "ok" | "warn" | "terminate" };
  selfCorrectionAttempts: number;
  effectiveMaxCoachingAttempts: number;
  emit: (level: "log" | "debugLog", marker: string, payload: object) => void;
}

export interface PostToolUseHook {
  name: string;
  priority?: number;
  shouldRun?(ctx: PostToolUseContext): boolean;
  run(ctx: PostToolUseContext): HookResult;
}

// ── Framework runners ─────────────────────────────────────────────────────────

function sortHooks<T extends { priority?: number }>(hooks: T[]): T[] {
  return [...hooks].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

export interface PreIterationMutations {
  /** Content to append or push, collected in order from all hooks. */
  appendOps: Array<{
    content: string;
    target: "responseInput" | "wireMessages";
    mode: "append-to-tool" | "push-user";
    allowResponseInputUserPush?: boolean;
  }>;
  /** When true, the calling site should abort the iteration and terminate the run. */
  blocked: boolean;
  blockReason?: string;
}

export interface PostToolUseMutations {
  appendOps: Array<{
    content: string;
    target: "responseInput" | "wireMessages";
    mode: "append-to-tool" | "push-user";
    allowResponseInputUserPush?: boolean;
  }>;
  mutatedOutput?: string;
  blocked: boolean;
  blockReason?: string;
}

export function runPreIterationHooks(
  hooks: PreIterationHook[],
  ctx: PreIterationContext,
  emitLog: (marker: string, payload: object) => void,
): PreIterationMutations {
  const result: PreIterationMutations = { appendOps: [], blocked: false };
  for (const hook of sortHooks(hooks)) {
    if (hook.shouldRun && !hook.shouldRun(ctx)) continue;
    let hr: HookResult;
    try {
      hr = hook.run(ctx);
    } catch (err) {
      emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: String(err) });
      throw err;
    }
    if (hr.kind === "passthrough") continue;
    if (hr.kind === "appendContext") {
      if (hr.mode === "push-user" && hr.target === "responseInput" && !hr.allowResponseInputUserPush) {
        const msg = `Hook ${hook.name}: push-user to responseInput is cache-unsafe. Set allowResponseInputUserPush:true to opt in.`;
        emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: msg });
        throw new Error(msg);
      }
      result.appendOps.push({
        content: hr.content,
        target: hr.target,
        mode: hr.mode,
        allowResponseInputUserPush: hr.allowResponseInputUserPush,
      });
      continue;
    }
    if (hr.kind === "block") {
      result.blocked = true;
      result.blockReason = hr.reason;
      break;
    }
    if (hr.kind === "failure") {
      emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: String(hr.error) });
      throw hr.error instanceof Error ? hr.error : new Error(String(hr.error));
    }
    // mutateResult is invalid in pre-iter phase — treat as passthrough
  }
  return result;
}

export function runPostToolUseHooks(
  hooks: PostToolUseHook[],
  ctx: PostToolUseContext,
  emitLog: (marker: string, payload: object) => void,
): PostToolUseMutations {
  const result: PostToolUseMutations = { appendOps: [], blocked: false };
  for (const hook of sortHooks(hooks)) {
    if (hook.shouldRun && !hook.shouldRun(ctx)) continue;
    let hr: HookResult;
    try {
      hr = hook.run(ctx);
    } catch (err) {
      emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: String(err) });
      throw err;
    }
    if (hr.kind === "passthrough") continue;
    if (hr.kind === "appendContext") {
      if (hr.mode === "push-user" && hr.target === "responseInput" && !hr.allowResponseInputUserPush) {
        const msg = `Hook ${hook.name}: push-user to responseInput is cache-unsafe. Set allowResponseInputUserPush:true to opt in.`;
        emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: msg });
        throw new Error(msg);
      }
      result.appendOps.push({
        content: hr.content,
        target: hr.target,
        mode: hr.mode,
        allowResponseInputUserPush: hr.allowResponseInputUserPush,
      });
      continue;
    }
    if (hr.kind === "mutateResult") {
      result.mutatedOutput = hr.updatedOutput;
      continue;
    }
    if (hr.kind === "block") {
      result.blocked = true;
      result.blockReason = hr.reason;
      break;
    }
    if (hr.kind === "failure") {
      emitLog("[zone-hook-error]", { hookName: hook.name, iter: ctx.iter, error: String(hr.error) });
      throw hr.error instanceof Error ? hr.error : new Error(String(hr.error));
    }
  }
  return result;
}

/**
 * Applies appendOps from a hook runner result to the live message arrays.
 * Mutates responseInput and/or wireMessages in place.
 */
export function applyAppendOps(
  ops: Array<{
    content: string;
    target: "responseInput" | "wireMessages";
    mode: "append-to-tool" | "push-user";
    allowResponseInputUserPush?: boolean;
  }>,
  responseInput: ChatCompletionMessageParam[],
  getPrunedMessages: () => ChatCompletionMessageParam[],
  setPrunedMessages: (msgs: ChatCompletionMessageParam[]) => void,
): void {
  for (const op of ops) {
    const target = op.target === "responseInput" ? responseInput : getPrunedMessages();
    if (op.mode === "append-to-tool") {
      let appended = false;
      for (let ci = target.length - 1; ci >= 0; ci--) {
        const m = target[ci];
        if (m.role === "tool") {
          m.content = (typeof m.content === "string" ? m.content : "") + op.content;
          appended = true;
          break;
        }
      }
      if (!appended && op.target === "responseInput") {
        const newMsg: ChatCompletionMessageParam = { role: "user", content: op.content };
        responseInput.push(newMsg);
        // Also push to wireMessages: it may have been built from responseInput before
        // this hook ran (R.2 runs before the pre-iter runner), so the new message would
        // otherwise be invisible to the LLM in the current iteration.
        setPrunedMessages([...getPrunedMessages(), newMsg]);
      } else if (!appended && op.target === "wireMessages") {
        setPrunedMessages([...getPrunedMessages(), { role: "user", content: op.content }]);
      }
    } else {
      // push-user
      if (op.target === "responseInput") {
        responseInput.push({ role: "user", content: op.content });
      } else {
        setPrunedMessages([...getPrunedMessages(), { role: "user" as const, content: op.content }]);
      }
    }
  }
}
