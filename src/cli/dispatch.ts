import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runLlmPatchFlow, isChitchat, isVagueDeveloperTask, type LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";
import {
  rejectPendingApprovalsForRun,
  clearTrustedCommandsForRun,
  setTrustAllForRun,
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { requestPlanApproval, rejectPendingPlansForRun, emitPlanEmptyApproval } from "../llm/planApprovals.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";
import { loadCliConfig, validateCliConfig, applyDiskKeyFallbacks, type CliConfig, type CliFlags } from "./config.js";
import { loadDiskModelSync } from "../api/diskModel.js";
import { runPlanInvestigation } from "../llm/planInvestigation.js";
import { createSpinner, buildCliSink } from "./sink.js";
import type { LlmPatchProgressUpdate, ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import { preparePlanContext } from "../core/preparePlanContext.js";
import { generateExecutionPlan, isNoChangePlan, isCannotVerifyPlan, isAnswerOnlyPlan, synthesizeMinimalPlan, planTerminalShape } from "../llm/executionPlan.js";
import { taskAssertsProblem, isPureAddition, matchedLeadVerb } from "../llm/taskShape.js";
import { rejectPendingEditsForRun } from "../api/editApprovals.js";
import { rejectPendingStagedForRun } from "../api/stagedApprovals.js";
import { rejectPendingQuestionsForRun } from "../api/questionApprovals.js";
import { debugLog, log } from "../utils/logger.js";
import { isProjectTrusted, addTrustedProject, resolveProjectRoot, canonicalizePath } from "../api/diskTrustedProjects.js";
import { requestTrustApproval, rejectPendingTrustForRun } from "../api/trustApprovals.js";
import { classifyPath } from "../core/pathSafety.js";
import { ApiKeyError, ProviderRequestError, PlanRefusalError } from "../llm/factory.js";
import { sep } from "node:path";
import { withRequestContext } from "../llm/openaiContext.js";
import { applyStdoutInterception } from "./tui/stdoutShield.js";
import {
  loadRunEnvelope,
  reconcileEnvelopeStaging,
  buildResumeContextBlock,
} from "../api/diskRunEnvelope.js";

// Phase 2a quick-plan seeding cost guard
const QUICK_PLAN_FILES = 5;
const QUICK_PLAN_FILE_CAP = 3_000;   // chars per file
const QUICK_PLAN_TOTAL_CAP = 12_000; // chars total budget

// Maps planTerminalShape's discriminator to the reason-field name
// emitPlanEmptyApproval expects — used at both replan arms below, written once
// so the two can't drift into naming the same shape two different ways.
const SHAPE_TO_REASON_FIELD = {
  no_change: "noChangeReason",
  cannot_verify: "cannotVerifyReason",
  answer: "answerOnlyReason",
  unknown: "unknown",
} as const;

export type TuiMode = "normal" | "autoAccept" | "plan";

export interface OneShotOpts {
  conversationId?: string;
  /** When provided (TUI/REPL mode), the caller manages AbortController and SIGINT. */
  externalAc?: AbortController;
  /** Custom progress callback; when provided, the built-in sink is bypassed. */
  onProgress?: (update: LlmPatchProgressUpdate) => void;
  mode?: TuiMode;
  /** Session-memory summary from prior task in this TUI session (Phase 1 opt-in). */
  priorSessionSummary?: string;
  /** Local image attachments from the user to include in the agent's first message. */
  images?: import("../api/imageUpload.js").ImageAttachment[];
  /** User-facing hooks — trust-checked in-memory snapshot from .zone/hooks.json. */
  userHooks?: import("../api/diskHooks.js").UserHooksConfig | null;
  /** MCP client manager — proxies mcp__<server>__<tool> calls. */
  mcpManager?: import("../mcp/mcpClientManager.js").McpClientManager | null;
  /** Opt-in for embed consumers: "manual" arms per-edit approval gate (requestEditApproval).
   *  Default "auto"; plan-mode's "manually approve changes" decision overrides to "manual" regardless. */
  editApprovalMode?: "auto" | "manual";
  /** Durable resume: stable per-session ID threaded into the agent loop for envelope checkpointing. */
  sessionId?: string;
  /** ALLOWLIST for ask_user — only a caller that positively declares an
   *  interactive channel may park the loop on a question. See AgentLoopInput. */
  interactiveChannel?: "tui";
  /** Durable resume: pre-reconciled staging + context to inject on restart. */
  resume?: {
    stagingFiles: Map<string, string>;
    todos: import("../core/todoLifecycle.js").RunTodo[];
    failureHistory: Array<{ path: string; records: import("../api/diskRunEnvelope.js").FailureRecordLite[] }>;
    contextBlock: string;
    messages?: unknown[];
    /** True when the envelope recorded the conversation as dropped for size.
     *  Surfaced to the user — a silent cold start is the failure mode. */
    messagesOmitted?: boolean;
  };
  /** Durable resume: pre-generated plan from the envelope; when set in plan mode,
   *  bypasses preparePlanContext + generateExecutionPlan + PlanReadyModal. */
  preGeneratedPlan?: ExecutionPlan;
}

/** Core one-shot runner. Returns the flow result — does NOT call process.exit. */
export async function runOneShotInner(
  task: string,
  config: CliConfig,
  runId: string,
  opts: OneShotOpts = {}
): Promise<LlmPatchFlowResult> {
  const ac = opts.externalAc ?? new AbortController();

  const effectiveConfig = opts.mode === "autoAccept"
    ? { ...config, autoApprove: true }
    : config;

  // Re-merge disk keys so a key set via /keys in the same session takes effect immediately.
  // applyDiskKeyFallbacks fills empty fields only — env/config.json keys always win.
  try { await applyDiskKeyFallbacks(effectiveConfig); } catch { /* non-critical */ }

  // No-key pre-flight: surface a clear error before any LLM call rather than letting
  // the classifier/plan-gen silently swallow ApiKeyError.
  {
    const _activeKey = effectiveConfig.provider === "openai"
      ? effectiveConfig.openaiApiKey
      : effectiveConfig.anthropicApiKey;
    if (!_activeKey) {
      const _envVar = effectiveConfig.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      throw new ApiKeyError(
        `No API key found for ${effectiveConfig.provider}. Add one with /keys, or set ${_envVar}.`
      );
    }
  }

  const spinner = createSpinner(process.stdout.isTTY === true, effectiveConfig.noColor);
  const sink = buildCliSink(
    {
      verbose: effectiveConfig.verbose,
      quiet: effectiveConfig.quiet,
      noColor: effectiveConfig.noColor,
      isTTY: process.stdout.isTTY === true,
      autoApprove: effectiveConfig.autoApprove,
      noRevision: effectiveConfig.noRevision,
    },
    spinner
  );
  const progressCallback = opts.onProgress ?? sink.onProgress;

  // --- Phase 2 trust gate ---
  {
    const projectRoot = resolveProjectRoot(effectiveConfig.repoPath);

    // Reuses the exact event shape validated by Phase-1's "Folder not trusted" line.
    const emitNarration = (message: string): void =>
      progressCallback({
        progress: {
          type: "narration",
          runId,
          ts: Date.now(),
          title: message,
          text: message,
          status: "complete",
        } as unknown as ZoneStructuredProgressEvent,
      } as unknown as LlmPatchProgressUpdate);

    // 1. Hard blocks — no flag overrides
    const pathClass = classifyPath(projectRoot);
    if (pathClass === "system") {
      emitNarration(`Cannot operate in the system directory ${projectRoot}.`);
      const result: LlmPatchFlowResult = { ok: false as const, reason: "system_path_blocked" };
      return result;
    }
    if (pathClass === "home_root") {
      emitNarration("This is your home directory, not a project — cd into a project folder.");
      const result: LlmPatchFlowResult = { ok: false as const, reason: "home_root_blocked" };
      return result;
    }

    // 2. --no-trust: force-deny even if registered
    if (effectiveConfig.trust === false) {
      emitNarration("Trust explicitly declined for this run (--no-trust).");
      const result: LlmPatchFlowResult = { ok: false as const, reason: "trust_explicitly_declined" };
      return result;
    }

    // 3. Determine trust from all sources
    const isTrustedByEnvAll   = process.env.ZONE_TRUST_ALL === "1";
    const isTrustedByFlag     = effectiveConfig.trust === true;
    const isTrustedByDir      = (() => {
      const envDir = process.env.ZONE_TRUST_DIR;
      if (!envDir) return false;
      const canonical = canonicalizePath(envDir);
      return projectRoot === canonical || projectRoot.startsWith(canonical + sep);
    })();
    const isTrustedByRegistry = isProjectTrusted(projectRoot);

    if (isTrustedByEnvAll || isTrustedByFlag || isTrustedByDir || isTrustedByRegistry) {
      // Persist only when --trust was the trust source (ZONE_TRUST_ALL/ZONE_TRUST_DIR are run-only)
      if (isTrustedByFlag) {
        addTrustedProject(projectRoot, "flag"); // idempotent — safe even if already in registry
      }
      // fall through → proceed with the run
    } else {
      // 4. Untrusted normal dir — interactive prompt or fail-closed (Phase-1 behavior)
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(
          `zone: folder not trusted — ${projectRoot}\nRun interactively to grant trust, or set ZONE_TRUST_ALL=1.\n`
        );
        const result: LlmPatchFlowResult = { ok: false as const, reason: "project_not_trusted_noninteractive" };
        return result;
      }
      const emitTrustApproval = (evt: {
        type: "trust_approval_required"; runId: string; ts: number;
        title: string; projectPath: string; approvalId: string;
      }): void => {
        progressCallback({ progress: evt as unknown as ZoneStructuredProgressEvent } as unknown as LlmPatchProgressUpdate);
      };
      const trusted = await requestTrustApproval({
        runId,
        projectPath: projectRoot,
        emit: emitTrustApproval,
        abortSignal: ac.signal,
      });
      if (trusted) {
        addTrustedProject(projectRoot, "user");
      } else {
        emitNarration("Folder not trusted — no changes made.");
        const result: LlmPatchFlowResult = { ok: false as const, reason: "project_not_trusted" };
        return result;
      }
    }
  }
  // --- end Phase 2 trust gate ---

  let planForExecution: ExecutionPlan | undefined;
  let editApprovalMode: "auto" | "manual" = opts.editApprovalMode ?? "auto";
  let feedbackForExecution = "";
  let useCheckpointLoop = false;
  // Set only inside the "quick" plan-gen gate below — stays undefined for the
  // strict/checkpoint path and the durable-resume path, neither of which
  // computes this gate at all. [zone-archetype] threading reads these as
  // optional, so undefined here means "not applicable", not "lost".
  let gateLeadVerb: string | null | undefined;
  let gateModeValue: string | undefined;

  if (opts.mode === "plan") {
    if (isChitchat(task) || isVagueDeveloperTask(task)) {
      return {
        ok: true as const,
        decisionMode: "chat" as const,
        chatResponse: "That's a bit vague — what would you like me to change?",
        patches: [],
        filesModified: [],
        iterCount: 0,
        costUsd: 0,
      } as unknown as LlmPatchFlowResult;
    }

    const planUserApiKey =
      effectiveConfig.provider === "openai" ? effectiveConfig.openaiApiKey :
                                             effectiveConfig.anthropicApiKey;

    // Context for plan-gen: honors user's selected model (fixes silent-Sonnet bug).
    // runId included so generateExecutionPlan's usage records attribute to this run —
    // without it they land in the ledger's empty-runId bucket and getRunCost() (the
    // number the footer shows) silently excludes them.
    const planGenCtx = {
      provider: effectiveConfig.provider,
      modelOverride: { high: effectiveConfig.model, standard: effectiveConfig.model },
      effort: effectiveConfig.effort,
      runId,
    };

    const diskSettings = loadDiskModelSync(effectiveConfig.repoPath);
    const planDepth = diskSettings?.planDepth ?? "quick";

    if (planDepth === "investigate" || planDepth === "strict") {
      // Strict / legacy-investigate: staged-diff checkpoint (opt-in).
      useCheckpointLoop = true;
    } else if (!opts.preGeneratedPlan) {
      // "quick" path: seed top-5 file bodies, generate plan, show PlanReadyModal.
      let planCtxRepoSummary = "";
      let planCtxRelevantFiles: string[] = [];
      let preGeneratedPlan: ExecutionPlan | undefined;
      progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Planning…" } } as unknown as LlmPatchProgressUpdate);
      try {
        const planCtx = await withRequestContext(planGenCtx, () =>
          preparePlanContext({
            task,
            repoPath: effectiveConfig.repoPath,
            userApiKey: planUserApiKey,
            provider: effectiveConfig.provider,
          })
        );
        planCtxRepoSummary = planCtx.projectSummary;
        planCtxRelevantFiles = planCtx.relevantFilePaths;

        const investigationFlag = process.env["ZONE_PLAN_INVESTIGATION_FIRST"];
        const shouldInvestigate =
          investigationFlag === "1" ? true :
          investigationFlag === "0" ? false :
          !isPureAddition(task);   // default: investigate unless a clear pure addition
        const investigationModel = process.env["ZONE_PLAN_INVESTIGATION_MODEL"];
        // Single source of truth for both the marker below and the fields threaded
        // into runLlmPatchFlow -> [zone-archetype] further down — not two independent
        // computations of the same decision. Assigns the outer-scope locals declared
        // near planForExecution, since this block closes before the common
        // runLlmPatchFlow call that needs them.
        gateLeadVerb = matchedLeadVerb(task);
        gateModeValue = shouldInvestigate ? "investigate-first" : "quick-lexical";
        log("[zone-plan-mode]", JSON.stringify({
          runId,
          mode: gateModeValue,
          gatedBy: investigationFlag === undefined ? "default-non-additive" : "env",
          leadVerb: gateLeadVerb,
          ...(shouldInvestigate ? { model: investigationModel ?? "inherit" } : {}),
        }));
        if (shouldInvestigate) {
          const invCtx = investigationModel
            ? { ...planGenCtx, modelOverride: { ...planGenCtx.modelOverride, high: investigationModel } }
            : planGenCtx;
          preGeneratedPlan = await withRequestContext(invCtx, () =>
            runPlanInvestigation({
              task,
              repoPath: effectiveConfig.repoPath,
              runId,
              relevantFiles: planCtxRelevantFiles,
              repoSummary: planCtxRepoSummary,
              userApiKey: planUserApiKey,
              provider: effectiveConfig.provider,
              abortSignal: ac.signal,
              progressCallback,
            })
          );
        } else {
          // "quick" path: seed top-5 file bodies (Option B, Phase 2a).
          let seededFileContents: string | undefined;
          {
            const candidates = planCtxRelevantFiles.slice(0, QUICK_PLAN_FILES);
            const parts: string[] = [];
            let cumChars = 0;
            for (const fp of candidates) {
              try {
                let content = await readFile(fp, "utf-8");
                if (content.length > QUICK_PLAN_FILE_CAP) content = content.slice(0, QUICK_PLAN_FILE_CAP);
                if (cumChars + content.length > QUICK_PLAN_TOTAL_CAP) break;
                parts.push(`=== ${fp} ===\n${content}`);
                cumChars += content.length;
              } catch { /* skip unreadable */ }
            }
            if (parts.length > 0) seededFileContents = parts.join("\n\n");
          }
          preGeneratedPlan = await withRequestContext(planGenCtx, () =>
            generateExecutionPlan({
              task,
              repoSummary: planCtxRepoSummary,
              relevantFiles: planCtxRelevantFiles,
              userApiKey: planUserApiKey,
              provider: effectiveConfig.provider,
              seededFileContents,
            })
          );
        }
      } catch (e) {
        if (e instanceof ProviderRequestError) throw e; // propagate to outer TUI/headless catch
        if (e instanceof PlanRefusalError) throw e;     // propagate graceful decline to outer catch
        const failReason = planCtxRelevantFiles.length === 0 ? "empty-context" : "parse-error";
        debugLog("[zone-plan-gen-failed]", { reason: failReason, taskLength: task.length });
        progressCallback({
          stage: "narration",
          progress: {
            type: "narration",
            runId,
            ts: Date.now(),
            title: "Planning skipped",
            text: "Could not generate a plan — running agent directly.",
          },
        });
      }

      if (!preGeneratedPlan) {
        // Plan-gen failed (logged above). Fall through to runLlmPatchFlow without a plan.
      } else {

      // E8a: reproduce command did not run — premise unverified, do not fabricate a fix.
      // Gate: only honor for tasks that assert a pre-existing problem (fix/debug).
      // Additive tasks (create/add/refactor) must never be verdict-killed here.
      if (taskAssertsProblem(task) && isCannotVerifyPlan(preGeneratedPlan)) {
        progressCallback({
          stage: "narration",
          progress: {
            type: "narration",
            runId,
            ts: Date.now(),
            title: "Could not verify",
            text: preGeneratedPlan.cannotVerifyReason ?? "Reproduce command did not run — premise unconfirmed.",
          },
        });
        const result: LlmPatchFlowResult = { ok: false as const, reason: "could_not_verify" };
        return result;
      }

      // E8b: premise verified false — investigation confirmed no problem exists.
      // Gate: same — only honor for problem-asserting tasks.
      if (taskAssertsProblem(task) && isNoChangePlan(preGeneratedPlan)) {
        progressCallback({
          stage: "narration",
          progress: {
            type: "narration",
            runId,
            ts: Date.now(),
            title: "Nothing to fix",
            text: preGeneratedPlan.noChangeReason ?? "Build verified clean — no changes needed.",
          },
        });
        const result: LlmPatchFlowResult = { ok: false as const, reason: "no_change_needed" };
        return result;
      }

      // Safety net: a non-problem task whose plan returned empty steps must still reach the modal.
      // Answer-only plans are excluded — that shape must survive to the modal
      // unconverted, not get force-stepped into concrete work nobody asked for.
      if (preGeneratedPlan.steps.length === 0 && !isAnswerOnlyPlan(preGeneratedPlan)) {
        // Hoisted purely so the synthesis marker can name what failed just before
        // it: `e` is scoped to the catch below and out of scope at the fallback.
        let forceStepsFailReason: string | undefined;
        try {
          preGeneratedPlan = await withRequestContext(planGenCtx, () =>
            generateExecutionPlan({
              task,
              repoSummary: planCtxRepoSummary,
              relevantFiles: planCtxRelevantFiles,
              userApiKey: planUserApiKey,
              provider: effectiveConfig.provider,
              forceSteps: true,
            })
          );
        } catch (e) {
          forceStepsFailReason = e instanceof Error ? e.message : String(e);
          debugLog("[zone-plan-force-steps-failed]", forceStepsFailReason);
        }
        if (preGeneratedPlan.steps.length === 0) {
          preGeneratedPlan = synthesizeMinimalPlan(task, planCtxRelevantFiles, forceStepsFailReason);
        }
      }

      // Merge explicit path tokens from the task text into steps[0].filesLikely as a scopeGuard floor.
      if (!taskAssertsProblem(task)) {
        const taskPathTokens = [...task.matchAll(/\b[\w./][\w./-]*\.\w{2,5}\b/g)].map(m => m[0]);
        if (taskPathTokens.length > 0 && preGeneratedPlan.steps.length > 0) {
          const step0 = preGeneratedPlan.steps[0]!;
          const merged = [...new Set([...step0.filesLikely, ...taskPathTokens])];
          preGeneratedPlan = {
            ...preGeneratedPlan,
            steps: [{ ...step0, filesLikely: merged }, ...preGeneratedPlan.steps.slice(1)],
          };
        }
      }

      if (preGeneratedPlan) {
        // Default: cheap requestPlanApproval loop with feedback/refine/approve_with_feedback.
        let currentPlan = preGeneratedPlan;
        let looping = true;
        let planFirstRefineCount = 0;
        while (looping) {
          const result = await requestPlanApproval({
            proposal: {
              runId,
              planId: randomUUID(),
              objective: currentPlan.objective,
              steps: currentPlan.steps,
              scopeNotes: currentPlan.scopeNotes,
              noChangeReason: currentPlan.noChangeReason,
              cannotVerifyReason: currentPlan.cannotVerifyReason,
              answerOnlyReason: currentPlan.answerOnlyReason,
              riskHints: currentPlan.riskHints,
              scopeSummary: currentPlan.scopeSummary,
            },
            emit: (evt) => progressCallback({ stage: evt.type, progress: evt } as unknown as LlmPatchProgressUpdate),
            abortSignal: ac.signal,
            autoApprove: effectiveConfig.autoApprove,
          });
          switch (result.decision) {
            case "reject":
            case "timeout":
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision, planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              ac.abort();
              return { ok: false as const, reason: "plan_rejected_by_user" } as unknown as LlmPatchFlowResult;
            case "feedback":
            case "refine":
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision, planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Replanning…" } } as unknown as LlmPatchProgressUpdate);
              try {
                currentPlan = await withRequestContext(planGenCtx, () =>
                  generateExecutionPlan({
                    task,
                    repoSummary: planCtxRepoSummary,
                    relevantFiles: planCtxRelevantFiles,
                    userApiKey: planUserApiKey,
                    provider: effectiveConfig.provider,
                    previousPlan: currentPlan,
                    userFeedback: result.feedback,
                    abortSignal: ac.signal,
                  })
                );
                if (result.feedback?.trim()) {
                  feedbackForExecution = feedbackForExecution
                    ? `${feedbackForExecution}\n${result.feedback.trim()}`
                    : result.feedback.trim();
                }
              } catch (e) {
                debugLog("[zone-plan-replan-failed]", e instanceof Error ? e.message : String(e));
                progressCallback({ stage: "narration", progress: { type: "narration", ts: Date.now(), runId, title: "Re-planning failed — continuing with the previous plan outline. Your feedback will still be applied during execution." } } as unknown as LlmPatchProgressUpdate);
              }
              // None of E8a/E8b/the forceSteps safety net re-run on a replan, so a
              // schema-valid stepless-with-reason response can reach here. This
              // arm loops back to requestPlanApproval — the user WILL see it.
              // planTerminalShape, not isNoChangePlan/isCannotVerifyPlan: fires for
              // all four non-"steps" shapes (including "answer" and "unknown"), not
              // just two, so a shape this ternary never anticipated is still recorded.
              {
                const shape = planTerminalShape(currentPlan);
                if (shape !== "steps") {
                  emitPlanEmptyApproval({
                    runId,
                    reasonField: SHAPE_TO_REASON_FIELD[shape],
                    reviewed: true,
                  });
                }
              }
              planFirstRefineCount++;
              continue;
            case "approve_with_feedback":
              progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Replanning…" } } as unknown as LlmPatchProgressUpdate);
              try {
                currentPlan = await withRequestContext(planGenCtx, () =>
                  generateExecutionPlan({
                    task,
                    repoSummary: planCtxRepoSummary,
                    relevantFiles: planCtxRelevantFiles,
                    userApiKey: planUserApiKey,
                    provider: effectiveConfig.provider,
                    previousPlan: currentPlan,
                    userFeedback: result.feedback,
                    abortSignal: ac.signal,
                  })
                );
                if (result.feedback?.trim()) {
                  feedbackForExecution = feedbackForExecution
                    ? `${feedbackForExecution}\n${result.feedback.trim()}`
                    : result.feedback.trim();
                }
              } catch (e) {
                debugLog("[zone-plan-replan-failed]", e instanceof Error ? e.message : String(e));
                progressCallback({ stage: "narration", progress: { type: "narration", ts: Date.now(), runId, title: "Re-planning failed — continuing with the previous plan outline. Your feedback will still be applied during execution." } } as unknown as LlmPatchProgressUpdate);
              }
              // This arm does NOT loop back to requestPlanApproval — currentPlan
              // goes straight to execution below (planForExecution = currentPlan).
              // A stepless-with-reason plan here is shown to no one; this is the
              // arm the reviewed:false count exists to measure.
              {
                const shape = planTerminalShape(currentPlan);
                if (shape !== "steps") {
                  emitPlanEmptyApproval({
                    runId,
                    reasonField: SHAPE_TO_REASON_FIELD[shape],
                    reviewed: false,
                  });
                }
              }
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision, planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              looping = false;
              break;
            case "accept_all":
              setTrustAllForRun(runId);
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision, planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              looping = false;
              break;
            case "manual":
              editApprovalMode = "manual";
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision, planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              looping = false;
              break;
            default:
              log("[zone-plan-decision]", JSON.stringify({ runId, planId: result.planId, decision: result.decision ?? "unknown", planAttempt: planFirstRefineCount + 1, reviewed: result.modalEmitted }));
              looping = false;
          }
        }
        planForExecution = currentPlan;
      }
      } // end else (preGeneratedPlan defined — plan-dependent code)
    } else {
      // Durable resume: use envelope plan directly — no re-planning, no PlanReadyModal.
      planForExecution = opts.preGeneratedPlan;
    }
  }

  // Close the gap between plan_ready_for_approval SPINNER_STOP and
  // agent_loop_start SPINNER_START: show a "Working…" spinner while
  // classifyTask / scanRepo / ranking runs before the agent loop starts.
  if (planForExecution) {
    progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Working…" } } as unknown as LlmPatchProgressUpdate);
  }

  // Only register an internal SIGINT handler when caller doesn't manage AbortController.
  let sigintHandler: (() => void) | null = null;
  if (!opts.externalAc) {
    sigintHandler = (): void => {
      rejectPendingApprovalsForRun(runId);
      rejectPendingRevisionsForRun(runId);
      rejectPendingQuestionsForRun(runId);
      clearTrustedCommandsForRun(runId);
      ac.abort();
    };
    process.once("SIGINT", sigintHandler);
  }

  try {
    const userApiKey =
      effectiveConfig.provider === "openai" ? effectiveConfig.openaiApiKey :
                                             effectiveConfig.anthropicApiKey;

    if (useCheckpointLoop) {
      // R3 Stage 2b: investigate path — run straight to execution with staged-checkpoint seam.
      const REFINE_RESTAGE_ITER_CAP = 6;
      let refineFeedback = "";
      let restageSeed: Map<string, string> | undefined;
      let refineTask = task;
      let strictRefineCount = 0;
      for (;;) {
        const result = await withRequestContext(
          {
            userApiKey,
            provider: effectiveConfig.provider,
            modelOverride: { high: effectiveConfig.model, standard: effectiveConfig.model },
            effort: effectiveConfig.effort,
          },
          () => runLlmPatchFlow({
            task: refineTask,
            repoPath: effectiveConfig.repoPath,
            runId,
            conversationId: opts.conversationId,
            sessionId: opts.sessionId,
            onProgress: progressCallback,
            abortSignal: ac.signal,
            userApiKey,
            provider: effectiveConfig.provider,
            forceTier: effectiveConfig.forceTier,
            mode: "patch",
            summaryFormat: effectiveConfig.summaryFormat,
            priorSessionSummary: opts.priorSessionSummary,
            webSearchEnabled: effectiveConfig.webSearchEnabled,
            interactiveChannel: opts.interactiveChannel,
            stagedCheckpoint: true,
            // Non-TTY (headless) has no StagedDiffModal — auto-approve to prevent hang.
            autoApprove: effectiveConfig.autoApprove || process.stdout.isTTY !== true,
            images: opts.images,
            userHooks: opts.userHooks,
            mcpManager: opts.mcpManager,
            ...(restageSeed !== undefined ? { restageSeed, maxIterationsOverride: REFINE_RESTAGE_ITER_CAP } : {}),
            resume: opts.resume,
          })
        );
        if (!result.ok) {
          const failResult = result as { ok: false; reason: string; refineFeedback?: string; discardedStaging?: Map<string, string> };
          if (failResult.reason === "staged_refine_requested") {
            const fb = failResult.refineFeedback ?? "";
            refineFeedback = refineFeedback ? `${refineFeedback}\n${fb}` : fb;
            restageSeed = failResult.discardedStaging;
            refineTask = refineFeedback
              ? `${task}\n\nUSER REFINEMENT (overrides any conflicting detail above):\n${refineFeedback}`
              : task;
            strictRefineCount++;
            continue;
          }
          if (failResult.reason === "staged_rejected") {
            debugLog("[zone-plan-decision]", { mode: "strict", decision: "reject", refineCount: strictRefineCount });
            ac.abort();
            return { ok: false as const, reason: "plan_rejected_by_user" } as unknown as LlmPatchFlowResult;
          }
        }
        debugLog("[zone-plan-decision]", { mode: "strict", decision: "approve", refineCount: strictRefineCount });
        return result;
      }
    }

    const effectiveTask = feedbackForExecution
      ? `${task}\n\nUSER REFINEMENT (overrides any conflicting detail above):\n${feedbackForExecution}`
      : task;

    const result = await withRequestContext(
      {
        userApiKey,
        provider: effectiveConfig.provider,
        modelOverride: { high: effectiveConfig.model, standard: effectiveConfig.model },
        effort: effectiveConfig.effort,
      },
      () => runLlmPatchFlow({
        task: effectiveTask,
        repoPath: effectiveConfig.repoPath,
        runId,
        conversationId: opts.conversationId,
        sessionId: opts.sessionId,
        onProgress: progressCallback,
        abortSignal: ac.signal,
        userApiKey,
        provider: effectiveConfig.provider,
        forceTier: effectiveConfig.forceTier,
        mode: "patch",
        preGeneratedPlan: planForExecution ?? opts.preGeneratedPlan,
        gateLeadVerb,
        gateMode: gateModeValue,
        summaryFormat: effectiveConfig.summaryFormat,
        priorSessionSummary: opts.priorSessionSummary,
        webSearchEnabled: effectiveConfig.webSearchEnabled,
        interactiveChannel: opts.interactiveChannel,
        editApprovalMode,
        showPostFlushDiffs: !!planForExecution,
        images: opts.images,
        userHooks: opts.userHooks,
        mcpManager: opts.mcpManager,
        resume: opts.resume,
      })
    );

    return result;
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    rejectPendingPlansForRun(runId);
    rejectPendingEditsForRun(runId);
    rejectPendingTrustForRun(runId);
    rejectPendingStagedForRun(runId);
    rejectPendingQuestionsForRun(runId);
    clearTrustedCommandsForRun(runId);
    spinner.stop();
  }
}

function printResult(result: LlmPatchFlowResult, noColor: boolean, quiet: boolean): void {
  if (quiet) {
    if (!("ok" in result && result.ok)) {
      const reason = ("reason" in result && result.reason) ? `: ${result.reason}` : "";
      process.stderr.write(`error: task did not complete${reason}\n`);
    } else if (result.warnings?.length) {
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
    }
    return;
  }

  const green = noColor ? "" : "\x1b[32m";
  const red = noColor ? "" : "\x1b[31m";
  const dim = noColor ? "" : "\x1b[2m";
  const reset = noColor ? "" : "\x1b[0m";

  if ("ok" in result && result.ok) {
    const mode = result.decisionMode ?? result.finalState ?? "done";
    process.stdout.write(`\n${green}✓${reset} ${mode}\n`);
    if (result.warnings?.length) {
      for (const w of result.warnings) {
        process.stdout.write(`${dim}  ⚠ ${w}${reset}\n`);
      }
    }
  } else {
    const reason = ("reason" in result && result.reason) ? `: ${result.reason}` : "";
    process.stdout.write(`\n${red}✗${reset} Task did not complete${reason}\n`);
  }
}

export interface HeadlessOpts {
  outputFormat?: "text" | "json";
}

/** CLI entry-point for headless one-shot: loads config, validates, runs, exits. */
export async function runHeadless(
  task: string,
  flags: Partial<CliFlags>,
  headlessOpts: HeadlessOpts = {}
): Promise<void> {
  const config = loadCliConfig(flags);
  // Merge disk keys so a /keys-saved key is visible before validateCliConfig checks.
  try { await applyDiskKeyFallbacks(config); } catch { /* non-critical */ }

  const isJson = headlessOpts.outputFormat === "json";

  // Swallow [zone-*] telemetry lines in headless text mode; ZONE_VERBOSE_LOGS=1
  // reroutes them to stderr instead. JSON mode emits a single envelope — no shield needed.
  const restoreStdout = isJson ? (): void => {} : applyStdoutInterception();
  process.once("exit", restoreStdout);

  try {
    validateCliConfig(config);
  } catch (err) {
    restoreStdout();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const runId = randomUUID();
  const sessionId = randomUUID();  // stable per-session envelope key (headless has no DiskSession)
  const startMs = Date.now();
  let result: LlmPatchFlowResult;

  try {
    if (isJson) {
      // Suppress all sink output; we'll emit a single JSON envelope at end.
      const nullSink = { onProgress: () => undefined };
      const ac = new AbortController();
      process.once("SIGINT", () => { rejectPendingApprovalsForRun(runId); rejectPendingRevisionsForRun(runId); clearTrustedCommandsForRun(runId); ac.abort(); });
      const userApiKey = config.provider === "openai" ? config.openaiApiKey : config.anthropicApiKey;
      result = await runLlmPatchFlow({ task, repoPath: config.repoPath, runId, sessionId, onProgress: nullSink.onProgress, abortSignal: ac.signal, userApiKey, provider: config.provider, forceTier: config.forceTier, mode: "patch" }).finally(() => { rejectPendingApprovalsForRun(runId); rejectPendingRevisionsForRun(runId); clearTrustedCommandsForRun(runId); });
    } else {
      result = await runOneShotInner(task, config, runId, { sessionId });
    }
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, error_kind: err.kind, error: err.userMessage }) + "\n");
      else process.stderr.write(`\nerror: ${err.userMessage}\n`);
      process.exit(1);
    }
    if (err instanceof PlanRefusalError) {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, reason: "plan_refusal", message: err.declineReason, cost_usd: err.costUsd }) + "\n");
      else process.stderr.write(`\nPlan declined: ${err.declineReason}\n`);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AbortError") || msg.includes("aborted")) {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 130, error: "aborted" }) + "\n");
      else process.stderr.write("\nAborted.\n");
      process.exit(130);
    }
    if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, error: msg }) + "\n");
    else process.stderr.write(`\nerror: ${msg}\n`);
    process.exit(1);
  }

  const success = "ok" in result && result.ok === true;

  if (isJson) {
    const envelope = {
      success,
      exit_code: success ? 0 : 1,
      cost_usd: ("costUsd" in result ? result.costUsd : null) ?? null,
      duration_ms: Date.now() - startMs,
      turn_count: ("iterCount" in result ? result.iterCount : null) ?? null,
      summary: ("decisionMode" in result ? result.decisionMode : null) ?? ("finalState" in result ? result.finalState : null) ?? null,
    };
    process.stdout.write(JSON.stringify(envelope) + "\n");
  } else {
    printResult(result, config.noColor, config.quiet);
  }

  process.exit(success ? 0 : 1);
}

/** @deprecated Use runHeadless instead. */
export const runOneShotFromCli = runHeadless;

/**
 * Build a runLlmPatchFlow input that resumes a previously-interrupted run.
 * Loads the envelope, reconciles staged files against disk, and builds the
 * resume context block that is injected into the first user message.
 */
export async function buildResumeFlowInput(
  envelopeKey: string,
  flags: Partial<CliFlags>,
  headlessOpts: HeadlessOpts = {},
): Promise<Parameters<typeof runLlmPatchFlow>[0]> {
  const env = await loadRunEnvelope(envelopeKey);
  if (!env) throw new Error(`No envelope found for ${envelopeKey}`);
  const { restored, dropNotes } = reconcileEnvelopeStaging(env);
  const contextBlock = buildResumeContextBlock(env, dropNotes);
  const config = loadCliConfig({ ...flags, repo: env.repoPath });
  try { await applyDiskKeyFallbacks(config); } catch { /* non-critical */ }
  const runId = randomUUID();
  const userApiKey = config.provider === "openai" ? config.openaiApiKey : config.anthropicApiKey;
  return {
    task: env.task,
    repoPath: env.repoPath,
    runId,
    sessionId: env.sessionId,
    provider: config.provider,
    userApiKey,
    abortSignal: undefined,
    preGeneratedPlan: env.executionPlan ?? undefined,
    priorSessionSummary: env.priorSessionSummary || undefined,
    mode: "patch",
    onProgress: headlessOpts.outputFormat === "json" ? () => undefined : undefined,
    resume: {
      stagingFiles: restored,
      todos: env.todos,
      failureHistory: env.failureHistory,
      contextBlock,
      messages: env.messages,
      messagesOmitted: env.messagesOmitted === true,
      // Continue the envelope we loaded rather than starting a second one under
      // this run's freshly-minted runId.
      envelopeKey,
      // The question this run stopped on, so the TUI can put it back to the user
      // instead of answering it on their behalf with "no answer is available".
      pendingQuestion: env.pendingQuestion,
    },
  };
}

/** Headless entry-point for resuming an interrupted run by session ID. */
export async function runHeadlessResume(
  sessionId: string,
  flags: Partial<CliFlags>,
  headlessOpts: HeadlessOpts = {},
): Promise<void> {
  const isJson = headlessOpts.outputFormat === "json";
  const restoreStdout = isJson ? (): void => {} : applyStdoutInterception();
  process.once("exit", restoreStdout);

  let flowInput: Parameters<typeof runLlmPatchFlow>[0];
  try {
    flowInput = await buildResumeFlowInput(sessionId, flags, headlessOpts);
  } catch (err) {
    restoreStdout();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    validateCliConfig(loadCliConfig({ ...flags, repo: flowInput.repoPath }));
  } catch (err) {
    restoreStdout();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const startMs = Date.now();
  let result: LlmPatchFlowResult;
  try {
    result = await runLlmPatchFlow(flowInput);
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, error_kind: err.kind, error: err.userMessage }) + "\n");
      else process.stderr.write(`\nerror: ${err.userMessage}\n`);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, error: msg }) + "\n");
    else process.stderr.write(`\nerror: ${msg}\n`);
    process.exit(1);
  }

  const success = "ok" in result && result.ok === true;
  if (isJson) {
    process.stdout.write(JSON.stringify({
      success,
      exit_code: success ? 0 : 1,
      cost_usd: ("costUsd" in result ? result.costUsd : null) ?? null,
      duration_ms: Date.now() - startMs,
      resumed_session: sessionId,
    }) + "\n");
  } else {
    printResult(result, loadCliConfig(flags).noColor, loadCliConfig(flags).quiet);
  }

  process.exit(success ? 0 : 1);
}
