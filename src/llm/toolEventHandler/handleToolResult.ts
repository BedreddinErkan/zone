import { debugLog } from "../../utils/logger.js";
import { handleSubagentResult, logSubagentDispatched } from "../subagentDispatch.js";
import {
  classifyVerifyCommand,
  detectTruncation,
  parseVerifyOutputToKeySet,
  computeFeederAction,
} from "../noProgressFeeder.js";
import { emitToolResultSize } from "../loopTelemetry.js";
import { LOOP_DETECT_EXEMPT_TOOLS } from "../loopDetector.js";
import type { ToolResult } from "../../tools/toolExecutor.js";
import type { ToolEventContext, ToolEventResult, HandleToolResultDeps } from "./types.js";

export async function handleToolResult(
  name: string,
  parsedArgs: Record<string, unknown>,
  callId: string,
  result: ToolResult,
  ctx: ToolEventContext,
  deps: HandleToolResultDeps
): Promise<ToolEventResult> {
  // Step 1: abort check + caller notification
  deps.throwIfAborted("after_tool");
  deps.onToolResult?.(name, result);

  // Step 2: log Task dispatch only after success (budget gate may block)
  if (name === "Task" && result.success) {
    logSubagentDispatched(parsedArgs, deps.runId, deps.iter);
  }

  // Step 3: diagnostic
  debugLog("[zone-agent-tool-result]", JSON.stringify({
    iter: deps.iter + 1,
    tool: name,
    success: result.success,
    outputPreview: result.output.slice(0, 300),
    error: result.error ?? null,
  }));

  // Step 4: failure flags — MUST happen before responseInput.push
  if (!result.success) {
    ctx.failureDetected = true;
    ctx.failedToolName = name;
    ctx.failedToolOutput = result.output;
    ctx.failedToolError = result.error ?? "";
    ctx.failedToolFilePath =
      typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
  }

  // Step 5: toolCallLog
  ctx.toolCallLog.push({
    id: callId,
    tool: name,
    args: parsedArgs,
    result: result.output.slice(0, 4000),
    success: result.success,
  });

  // Step 6: filesReadThisRun + filesReadCountThisRun
  if (name === "read_file" && result.success && typeof parsedArgs.filePath === "string" && parsedArgs.filePath) {
    ctx.filesReadThisRun.add(parsedArgs.filePath);
    ctx.filesReadCountThisRun.set(
      parsedArgs.filePath,
      (ctx.filesReadCountThisRun.get(parsedArgs.filePath) ?? 0) + 1,
    );
  }

  // Step 7: apply_patch failure → failureHistory + failedFilesThisIter
  if (name === "apply_patch" && !result.success) {
    const parsedFilePath =
      typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
    if (parsedFilePath) ctx.failedFilesThisIter.add(parsedFilePath);
    const filePath = parsedFilePath ?? "unknown";
    const classifiedTrigger = deps.classifyFailure(name, result.output, result.error);
    const trigger =
      classifiedTrigger === "apply_patch_semantic_smell"
        ? deps.extractSemanticSmellName(result.output)
        : classifiedTrigger;
    const errorLine = deps.extractErrorLine(result.output);
    const patchHash = deps.hashPatchBlocks(parsedArgs);
    const list = ctx.failureHistory.get(filePath) ?? [];
    list.push({ trigger, errorLine, patchHash, iter: deps.iter + 1 });
    ctx.failureHistory.set(filePath, list);
  }

  // Step 8: rollback counter
  if (name === "apply_patch" && typeof result.output === "string" &&
      result.output.startsWith("APPLY_ROLLED_BACK")) {
    ctx.rollbackCount += 1;
  }

  // Step 9: filesModified
  if ((name === "write_file" || name === "apply_patch") && parsedArgs.filePath != null) {
    ctx.filesModified.add(String(parsedArgs.filePath));
  }

  // Step 9.6: P3 no_progress feeder — populate ring buffer from agent's own tsc/test run_command outputs
  if (name === "run_command" && ctx.noProgressBaselines && ctx.recentVerifyKeySets) {
    const cmd = String(parsedArgs.command ?? "");
    const kind = classifyVerifyCommand(cmd);
    if (kind) {
      const output = String(result.output ?? "");
      const truncated = detectTruncation(output);
      const postKeys = parseVerifyOutputToKeySet(kind, output, deps.repoPath);
      const successfulApplies = ctx.toolCallLog.filter(
        (e) => (e.tool === "apply_patch" || e.tool === "multi_edit") && e.success === true,
      ).length;
      const action = computeFeederAction(postKeys, successfulApplies, ctx.noProgressBaselines[kind], deps.iter, truncated);
      if (action.kind === "setBaseline") {
        ctx.noProgressBaselines[kind] = action.keys;
      } else if (action.kind === "pushSnapshot") {
        ctx.recentVerifyKeySets.push(action.snapshot);
        if (ctx.recentVerifyKeySets.length > 4) ctx.recentVerifyKeySets.shift();
      }
    }
  }

  // Step 10: Task subagent result aggregation
  if (name === "Task" && result.success) {
    const sdResult = handleSubagentResult({
      result,
      iterNumber: deps.iter,
      runId: deps.runId,
      onStructuredEvent: deps.onStructuredEvent,
      filesModified: ctx.filesModified,
      subagentTokenTotal: deps.budget.subagentTokenTotal,
      subagentCostTotal: deps.budget.subagentCostTotal,
      mainAgentTokens: () => deps.budget.mainAgentTokens,
      effectiveTokenBudgetCap: deps.effectiveTokenBudgetCap,
      iterCostAccumulator: deps.budget.iterCostAccumulator,
      lastIterCostPayload: deps.budget.lastIterCostPayload,
    });
    if (sdResult.subagentTokenDelta > 0) {
      const { ratio } = deps.budget.recordSubagentResult(
        { tokens: sdResult.subagentTokenDelta, cost: sdResult.subagentCostDelta },
        deps.iter + 1,
        deps.onStructuredEvent
      );
      if (ratio >= deps.tokenBudgetHardThreshold) {
        ctx.responseInput.push({
          role: "tool",
          tool_call_id: callId,
          content: result.output,
        });
        emitToolResultSize({
          runId: deps.runId ?? "anon",
          tool: name,
          bytes: Buffer.byteLength(result.output, "utf8"),
          callId,
          iter: deps.iter,
        });
        const exit = await deps.synthesizeTokenBudgetExit(deps.iter + 1, ctx.responseInput);
        return { kind: "early_exit", exit };
      }
    } else {
      deps.budget.recordSubagentCostOnly(sdResult.subagentCostDelta);
    }
  }

  // Step 11: role:tool reply (normal flow)
  ctx.responseInput.push({
    role: "tool",
    tool_call_id: callId,
    content: result.output,
  });
  emitToolResultSize({
    runId: deps.runId ?? "anon",
    tool: name,
    bytes: Buffer.byteLength(result.output, "utf8"),
    callId,
    iter: deps.iter,
  });

  // Step 11.5: scope-block circuit breaker
  // Counts consecutive write attempts blocked by the plan scope guard. Resets
  // on any successful write. At 3 blocks a coaching nudge is appended (Pattern A);
  // at 5 the run is force-terminated to prevent budget exhaustion on a bad plan.
  {
    const isScopeBlock =
      !result.success &&
      (result.error === "apply_patch_blocked_out_of_plan_scope" ||
       result.error === "write_file_blocked_out_of_plan_scope");
    const isSuccessfulWrite =
      result.success && (name === "apply_patch" || name === "write_file");

    if (isScopeBlock) {
      ctx.consecutiveScopeBlocks += 1;

      if (ctx.consecutiveScopeBlocks === 3) {
        // Pattern A: append coaching nudge to the role:tool message just pushed in step 11
        const last = ctx.responseInput[ctx.responseInput.length - 1];
        if (last?.role === "tool" && typeof last.content === "string") {
          last.content +=
            `\n\n[SCOPE-BLOCK COACHING — ${ctx.consecutiveScopeBlocks} consecutive blocks]\n` +
            `Your plan's filesLikely paths do not match the files that need editing ` +
            `(likely an extension mismatch such as .ts vs .tsx, or a stale path). ` +
            `Do NOT retry the same blocked path. Either work within the already-allowed ` +
            `scope, or end the run with a FINAL SUMMARY explaining the mismatch.`;
        }
      }

      if (ctx.consecutiveScopeBlocks >= 5) {
        deps.onStructuredEvent?.({
          type: "scope_block_circuit_terminal",
          blockedCount: ctx.consecutiveScopeBlocks,
          title: `Scope-block circuit breaker: write blocked ${ctx.consecutiveScopeBlocks}× consecutively`,
          status: "error",
        });
        return {
          kind: "early_exit",
          exit: deps.synthesizeScopeBlockExit(deps.iter + 1, ctx.consecutiveScopeBlocks),
        };
      }
    }
    if (isSuccessfulWrite) {
      ctx.consecutiveScopeBlocks = 0;
    }
  }

  // Step 12: loop detection (exempt polling tools — repeated identical calls are legitimate)
  if (!LOOP_DETECT_EXEMPT_TOOLS.has(name)) {
    const loopHash = deps.hashToolCall(name, parsedArgs);
    const loopResult = deps.recordAndDetect(deps.detectorState, loopHash);
    ctx.lastLoopResult = loopResult;
    if (loopResult.status === "terminate") {
      deps.onStructuredEvent?.({
        type: "loop_detected_terminal",
        toolName: name,
        count: loopResult.count,
        title: `Loop detected: \`${name}\` repeated ${loopResult.count}×`,
        status: "error",
      });
      return { kind: "early_exit", exit: deps.synthesizeLoopDetectedExit(deps.iter + 1, name, loopResult.count) };
    }
  }

  return { kind: "continue" };
}
