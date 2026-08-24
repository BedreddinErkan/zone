import type {
  LlmPatchProgressUpdate,
  ZoneStructuredProgressEvent,
} from "../core/agentLifecycleEvents.js";
import { promptCommandApproval, promptScopeRevision } from "./approvals.js";
import { resolvePlanApproval } from "../llm/planApprovals.js";
import { formatCompactionNarration } from "../core/compactionNarration.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
  pauseForPrompt(): void;
  resumeAfterPrompt(): void;
}

export function createSpinner(isTTY: boolean, noColor: boolean): Spinner {
  let frame = 0;
  let currentText = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  const green = noColor ? "" : "\x1b[32m";
  const red = noColor ? "" : "\x1b[31m";
  const cyan = noColor ? "" : "\x1b[36m";
  const reset = noColor ? "" : "\x1b[0m";

  function render(): void {
    if (!isTTY || paused) return;
    process.stderr.write(`\r${cyan}${FRAMES[frame % FRAMES.length]}${reset} ${currentText}  `);
    frame++;
  }

  function clear(): void {
    if (!isTTY) return;
    process.stderr.write("\r\x1b[K");
  }

  function stopTimer(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
  }

  return {
    start(text) { currentText = text; frame = 0; if (isTTY && !timer) { timer = setInterval(render, FRAME_INTERVAL_MS); } else if (!isTTY) { process.stderr.write(`${text}\n`); } },
    update(text) { currentText = text; if (!isTTY) { process.stderr.write(`${text}\n`); } },
    succeed(text) { stopTimer(); clear(); process.stdout.write(`${green}✓${reset} ${text}\n`); },
    fail(text) { stopTimer(); clear(); process.stdout.write(`${red}✗${reset} ${text}\n`); },
    stop() { stopTimer(); clear(); },
    pauseForPrompt() { paused = true; clear(); },
    resumeAfterPrompt() { paused = false; if (isTTY && !timer && currentText) { timer = setInterval(render, FRAME_INTERVAL_MS); } },
  };
}

export interface CliSinkOptions {
  verbose: boolean;
  quiet: boolean;
  noColor: boolean;
  isTTY: boolean;
  autoApprove?: boolean;
  noRevision?: boolean;
}

export interface CliSink {
  onProgress: (update: LlmPatchProgressUpdate) => void;
}

export function buildCliSink(opts: CliSinkOptions, spinner: Spinner): CliSink {
  const { verbose, quiet, noColor, isTTY } = opts;

  const dim = noColor ? "" : "\x1b[2m";
  const cyan = noColor ? "" : "\x1b[36m";
  const green = noColor ? "" : "\x1b[32m";
  const yellow = noColor ? "" : "\x1b[33m";
  const red = noColor ? "" : "\x1b[31m";
  const bold = noColor ? "" : "\x1b[1m";
  const reset = noColor ? "" : "\x1b[0m";

  function out(line: string): void {
    process.stdout.write(line + "\n");
  }

  function handleStructuredEvent(evt: ZoneStructuredProgressEvent): void {
    const type = evt.type;

    switch (type) {
      case "agent_loop_start":
        if (!quiet) spinner.start("Starting...");
        break;

      case "agent_loop_complete": {
        const iter = evt.iter_count ?? evt.iter ?? 0;
        const cost =
          evt.cumulativeCost != null ? `$${evt.cumulativeCost.toFixed(4)}` : "";
        const summary = [
          iter > 0 ? `${iter}it` : null,
          cost || null,
        ]
          .filter(Boolean)
          .join(" / ");

        const detail = (evt as { detail?: string }).detail ?? "";
        if (detail.trim()) {
          process.stdout.write(detail.trim() + "\n");
        }

        if (quiet) {
          if (summary) process.stderr.write(`Done — ${summary}\n`);
        } else {
          spinner.succeed(summary ? `Done — ${summary}` : "Done");
        }
        break;
      }

      case "narration":
        if (!quiet && evt.text) {
          spinner.stop();
          out(`${evt.text}`);
        }
        break;

      case "tool_call":
        if (!quiet) {
          spinner.stop();
          const label = evt.title ?? evt.command ?? evt.filePath ?? "tool";
          out(`${cyan}▸${reset} ${label}`);
        }
        break;

      case "tool_result":
        if (!quiet) {
          const ok = evt.status === "success" || evt.status === "active";
          const prefix = ok ? `${green}  ✓${reset}` : `${red}  ✗${reset}`;
          if (evt.detail) out(`${prefix} ${dim}${evt.detail}${reset}`);
        }
        break;

      case "reading_file":
        if (!quiet && verbose) {
          out(`${dim}  reading ${evt.filePath ?? evt.title}${reset}`);
        }
        break;

      case "ranking_context":
        spinner.update("Ranking context...");
        break;

      case "generating_patch":
        spinner.update("Generating patch...");
        break;

      case "verification":
      case "verification_investigating":
      case "verification_fixing":
        spinner.update("Verifying...");
        break;

      case "verification_fixed":
        if (!quiet) out(`${green}  ✓${reset} ${dim}Verification fixed${reset}`);
        break;

      case "patch_converted":
        if (!quiet) out(`${green}  ✓${reset} ${dim}Patch validated${reset}`);
        break;

      case "patch_rejected":
        out(`${red}  ✗${reset} Patch rejected${evt.detail ? `: ${evt.detail}` : ""}`);
        break;

      case "iter_cost_update":
        if (isTTY && !quiet && evt.iter != null && evt.cumulativeCost != null) {
          const line = `${dim}  iter ${evt.iter} · $${evt.cumulativeCost.toFixed(4)}${reset}`;
          if (verbose) out(line);
        }
        break;

      case "token_budget_status": {
        const ratio = evt.tokenBudgetRatio ?? 0;
        if (ratio >= 0.9) {
          out(`${red}${bold}⚠ Token budget critical (${Math.round(ratio * 100)}%)${reset}`);
        } else if (ratio >= 0.7) {
          out(`${yellow}⚠ Token budget at ${Math.round(ratio * 100)}%${reset}`);
        }
        break;
      }

      case "loop_warning_emitted":
        out(
          `${yellow}⚠ Possible loop${evt.detail ? ` — ${evt.detail}` : ""}${reset}`
        );
        break;

      case "loop_detected_terminal":
        spinner.fail("Loop detected — aborting");
        break;

      case "llm_retry_in_progress":
        spinner.update(`Retrying${evt.detail ? ` (${evt.detail})` : ""}...`);
        break;

      case "task_classified":
        if (!quiet) {
          const tier = evt.tier ?? "";
          const detail = evt.detail ?? "";
          const parts = [tier, detail].filter(Boolean).join(", ");
          out(`${dim}[${parts || evt.title}]${reset}`);
        }
        break;

      case "tier_constraints_applied":
        if (verbose) out(`${dim}[tier constraints applied]${reset}`);
        break;

      case "scope_audit_started":
        if (!quiet) spinner.update("Auditing scope...");
        break;

      case "scope_audit_skipped":
        if (verbose) out(`${dim}(scope audit skipped${evt.detail ? `: ${evt.detail}` : ""})${reset}`);
        break;

      case "scope_audit_completed":
        if (!quiet) out(`${green}  ✓${reset} ${dim}Scope audit complete${reset}`);
        break;

      case "command_approval_required": {
        const approvalId = evt.approvalId;
        const command = evt.command ?? evt.title ?? "";
        const runId = evt.runId;
        if (approvalId) {
          void promptCommandApproval(approvalId, command, runId, {
            autoApprove: opts.autoApprove ?? false,
            noRevision: opts.noRevision ?? false,
            isTTY,
            noColor,
          }, spinner).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            out(`${red}error: command approval failed: ${msg}${reset}`);
          });
        } else if (!quiet) {
          out(`${yellow}⚠ Command approval required: ${command}${reset}`);
        }
        break;
      }

      case "command_auto_approved":
        if (!quiet) out(`${dim}  ✓ auto-approved (safe)${reset}`);
        break;

      case "command_trusted":
        if (!quiet) out(`${dim}  ✓ trusted${reset}`);
        break;

      case "terminal_output":
        if (!quiet && evt.detail) process.stdout.write(evt.detail);
        break;

      case "terminal_done":
        if (!quiet && evt.exitCode != null && evt.exitCode !== 0) {
          out(`${red}  exit ${evt.exitCode}${reset}`);
        }
        break;

      case "scope_revision_proposed": {
        const revisionId = evt.revisionId;
        const summary = evt.detail ?? evt.revisionRevisedPlanSummary ?? evt.title ?? "";
        const runId = evt.runId;
        if (revisionId) {
          void promptScopeRevision(revisionId, summary, runId, {
            autoApprove: opts.autoApprove ?? false,
            noRevision: opts.noRevision ?? false,
            isTTY,
            noColor,
          }, spinner).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            out(`${red}error: scope revision failed: ${msg}${reset}`);
          });
        } else if (!quiet) {
          out(`${yellow}⚠ Scope revision proposed: ${summary}${reset}`);
        }
        break;
      }

      case "scope_revision_resolved":
        if (!quiet) out(`${dim}  Scope revision: ${evt.detail ?? evt.revisionDecision ?? "resolved"}${reset}`);
        break;

      case "plan_ready_for_approval": {
        const planId = evt.planId;
        const runId = evt.runId;
        if (!planId) break;
        if (opts.autoApprove) {
          resolvePlanApproval({ planId, runId, decision: "accept_all" });
        } else {
          if (!quiet) out(`${yellow}⚠ Plan approval requires interactive (TUI) mode. Use --yes to auto-accept.${reset}\n`);
          resolvePlanApproval({ planId, runId, decision: "reject" });
        }
        break;
      }

      case "plan_summary":
        if (!quiet && evt.planSummaryFiles?.length) {
          out(`${dim}Plan: ${evt.planSummaryFiles.join(", ")}${reset}`);
        }
        break;

      case "phase_changed":
        if (!quiet) out(`${dim}── Phase ${evt.phase ?? ""} ──${reset}`);
        break;

      case "compaction_started":
        if (!quiet && verbose) out(`${dim}  Compacting context…${reset}`);
        break;

      case "compaction_status": {
        const text = formatCompactionNarration({
          tokensBefore: evt.tokensBefore ?? 0,
          tokensAfter:  evt.tokensAfter  ?? 0,
          savedTokens:  evt.savedTokens  ?? 0,
          count:        evt.count        ?? 0,
        });
        if (quiet) process.stderr.write(text + "\n");
        else out(text);
        break;
      }

      case "compaction_exhausted": {
        const line = `${yellow}⚠ Compaction exhausted — context may overflow. Break this task into subtasks.${reset}`;
        if (quiet) process.stderr.write(line + "\n");
        else out(line);
        break;
      }

      case "compaction_overflow_warning": {
        const line = `${yellow}⚠ Context window full — no compactable history. Consider breaking into subtasks.${reset}`;
        if (quiet) process.stderr.write(line + "\n");
        else out(line);
        break;
      }

      case "subagent_started":
        if (!quiet) out(`${dim}  ↳ subagent started${reset}`);
        break;

      case "subagent_completed":
        if (!quiet) {
          const status = evt.subagentStatus ?? "done";
          out(`${dim}  ↳ subagent ${status}${reset}`);
        }
        break;

      case "handoff_report":
        if (!quiet && evt.report?.summary) out(evt.report.summary);
        break;

      case "run_summary":
        if (!quiet && evt.cost) {
          const { totalUsd, iterCount, cacheHitPct } = evt.cost;
          out(
            `\n${bold}Run summary${reset}: $${totalUsd.toFixed(4)} · ${iterCount} iter · ${Math.round(cacheHitPct)}% cache hit`
          );
        }
        if (!quiet && evt.filesChanged?.length) {
          for (const f of evt.filesChanged) {
            out(`  ${dim}${f.filePath}  +${f.addedLines} -${f.removedLines}${reset}`);
          }
        }
        break;

      case "chat_chunk":
      case "chat_response":
        // chat_chunk carries its fragment in `delta` (matching tool_input_delta's naming for
        // a streamed increment, not a complete block); chat_response carries the whole text in
        // `text`. Same fallback chain the TUI's own handleTextEvent already uses for this
        // trio, so headless mode and the TUI agree on which field each type actually uses.
        if (!quiet) {
          const chunk = evt.text ?? evt.delta;
          if (chunk) process.stdout.write(chunk);
        }
        break;

      case "chat_start":
      case "chat_done":
        break;

      case "patch_stream_delta":
      case "patch_stream_target":
      case "tool_input_delta":
      case "todos_initialized":
      case "todo_status_changed":
      case "todo_revised":
      case "context_ready":
      case "planner_result":
      case "fallback":
      case "fallback_success":
      case "validated":
        break;

      default:
        if (verbose) out(`${dim}[unhandled] type=${type}${reset}`);
        break;
    }
  }

  return {
    onProgress(update: LlmPatchProgressUpdate): void {
      if (typeof update === "string") {
        if (update) spinner.update(update);
        return;
      }

      const evt = update.progress;
      if (evt) {
        handleStructuredEvent(evt);
        return;
      }

      if (!quiet && update.stage) {
        spinner.update(update.stage);
      }
    },
  };
}
