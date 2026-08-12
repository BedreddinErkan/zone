/**
 * Tool-mention defect sweep — do prompt instructions still name a tool this run's own
 * capability filter doesn't offer?
 *
 * Item 100 (docs/deferred-work.md) catalogued eight tools instructed unconditionally across
 * nine of nineteen tested configurations — the prompt telling the agent to use a tool its own
 * filter denies. Four commits (a8b40589, 4080f9e2, 3a1bc7cf, 77fbd3e1) threaded offeredToolNames
 * through assembleAgentSystemPrompt and gated six blocks/bundles plus three special cases.
 * Re-measurement after those four found the CONFIGURATION-level count unchanged at 9 of 19 — one
 * genuinely unconditional bullet (inside PRIOR RUN CONTEXT) alone kept every one of the nine
 * flagged, hiding what the binary count cannot show: of 41 original (tool, configuration) pairs,
 * 29 were already resolved by those four commits. A fifth commit (eb0a3d25) closed the remaining
 * two pairs — Task via PRIOR RUN CONTEXT's own "Suggested:" bullet, revert_patch via
 * VERIFICATION WARNINGS' own options line — both the same shape as the multi_edit bullet fixed
 * in the four-commit pass: a bundle-level gate correctly keeps a block open because ONE of
 * several named tools is offered, but one bullet inside is really about a different tool that
 * isn't.
 *
 * FIGURES AT eb0a3d25 (the commit before this script's own): 41 original pairs, 41 resolved, 0
 * remaining — expected zero defective pairs and zero defective configurations when this script
 * is run against dist/ built from eb0a3d25 or later. Numbers this script prints are a snapshot
 * of that run, not cached in this comment — run it for the current figure.
 *
 * WHY THIS FILE EXISTS: the classifier behind these figures has been rebuilt from scratch twice
 * across this arc's own passes (the item-100 ledger pass's own build; this session's rebuild,
 * after the scratchpad that held the first one did not survive between conversations) — the same
 * problem scripts/notice-regression-probe.mjs already solved for a different instrument (commit
 * 08ceb75e): an instrument worth re-running belongs in the repo, not in a session transcript.
 *
 * WHAT IT MEASURES: for each of 19 real configurations (task archetypes, tool tiers, subagent
 * kinds, mode defaults, plan-investigation, scope-audit, answer-only), resolves the REAL offered
 * tool set via resolveToolList, assembles the REAL system prompt via assembleAgentSystemPrompt /
 * assembleInvestigationSystemPrompt — threading offeredToolNames correctly, which the item-100
 * ledger pass's own first classifier never did, so it kept silently measuring pre-fix behaviour
 * even after the fix had landed — splits the assembled prompt into SENTENCES, not lines (a line
 * can carry a prohibition and an instruction about two different tools; a whole-line verdict
 * hides the second, which is exactly how the APPLY_ROLLED_BACK residual survived one full
 * measurement pass before a direct source read caught it), classifies each sentence naming an
 * absent tool as instruction / prohibition / incidental, and reports every (tool, configuration)
 * pair where an instruction-grade sentence survives.
 *
 * FAILS LOUDLY, NOT SILENTLY (essay 23, docs/deferred-work.md — a measurement's own setup can
 * silently substitute a placeholder for the part of the artefact it means to measure):
 * planProgressBlock's real text is a local const inside agentLoop.ts (assembleAgentSystemPrompt's
 * own caller), not exported — this script cannot import it verbatim. It uses a documented
 * placeholder and ASSERTS (throws, not warns) that the placeholder is non-empty and contains the
 * real header before sweeping, rather than silently passing "" — which is exactly the mistake the
 * item-100 establish pass's own first sweep made, silently dropping TodoWrite's entire defect
 * from that sweep's results until it was caught and re-derived by hand.
 *
 * Usage:
 *   npm run build && node scripts/tool-mention-defect-sweep.mjs
 *
 * RE-RUN THIS WHEN:
 *   - a new prompt block is added to assembleAgentSystemPrompt or assembleInvestigationSystemPrompt
 *   - a tool is added to or removed from the registry (src/tools/toolDefinitions.ts)
 *   - the offeredToolNames threading at the call site (agentLoop.ts) changes
 *   Numbers this script prints are a snapshot of that run against the CURRENT dist/ build —
 *   nothing here caches or reuses a prior run's figures.
 */

import { resolveToolList } from "../dist/tools/toolRegistry.js";
import * as disp from "../dist/llm/archetypeDispatcher.js";
import * as al from "../dist/llm/agentLoop.js";
import { tierToolFilter } from "../dist/tools/tierToolSubsets.js";
import { CHAT_TOOLS, INVESTIGATION_TOOLS } from "../dist/tools/toolDefinitions.js";
import { AUDIT_ALLOWED_TOOLS } from "../dist/llm/subagents.js";
import { resolveSubagentCapabilityFilter } from "../dist/llm/subagentDispatch.js";

// Real header line from the real planProgressBlock (agentLoop.ts, local const inside the
// assembleAgentSystemPrompt caller — not exported, so not importable verbatim). Only the
// header's own truthiness/shape matters to this sweep (the gate this script measures is
// `input.planProgressBlock && isOffered("TodoWrite")` — the block's OWN body content plays no
// part in whether TodoWrite's mention survives), so a short, honestly-labelled placeholder
// containing the real header is sufficient — checked below rather than assumed.
const PLAN_PROGRESS_BLOCK_PLACEHOLDER = "PLAN VISIBILITY (TodoWrite):\n(placeholder body — see agentLoop.ts for the real block)";

/** Fails loudly on essay 23's own lesson: an empty or malformed placeholder here would
 *  silently drop TodoWrite's own defect from every config's results, the same way the
 *  establish pass's first sweep silently did with an empty planProgressBlock. */
export function assertPlaceholderSane(placeholder) {
  if (!placeholder || typeof placeholder !== "string" || placeholder.trim().length === 0) {
    throw new Error(
      "tool-mention-defect-sweep: PLAN_PROGRESS_BLOCK_PLACEHOLDER is empty or missing. " +
      "An empty placeholder silently suppresses TodoWrite's own defect from every config's " +
      "results (see essay 23, docs/deferred-work.md) — fix the placeholder, do not swallow this."
    );
  }
  if (!placeholder.includes("PLAN VISIBILITY (TodoWrite)")) {
    throw new Error(
      "tool-mention-defect-sweep: PLAN_PROGRESS_BLOCK_PLACEHOLDER no longer contains the real " +
      "header \"PLAN VISIBILITY (TodoWrite)\" — the gate this script measures keys off " +
      "input.planProgressBlock's own truthiness, but a placeholder that has drifted from the " +
      "real block's own header is a sign the source changed underneath this script. Update the " +
      "placeholder (and re-check it against agentLoop.ts) before trusting this sweep's output."
    );
  }
  return true;
}

const ALL_TOOL_NAMES = resolveToolList(undefined).map((t) => t.name);
const BY_LEN = [...ALL_TOOL_NAMES].sort((a, b) => b.length - a.length);

/** Every registered tool name mentioned in `line`, longest-name-first so a prefix-sharing
 *  sibling (run_command / run_command_readonly) cannot steal its extension's own hits. */
export function maskedLine(line, toolNames = BY_LEN) {
  let work = line;
  const found = [];
  for (const name of toolNames) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    if (re.test(work)) found.push(name);
    work = work.replace(re, " ".repeat(name.length));
  }
  return found;
}

/** Splits a rendered prompt line into sentences. Deliberately conservative — splits only on
 *  a sentence-ending punctuation mark followed by whitespace and a capital letter, opening
 *  quote, or paren, so it doesn't fragment decimals, ratios (10-15), or a line's own trailing
 *  parenthetical. This is the fix for the shape that hid the PRIOR RUN CONTEXT / VERIFICATION
 *  WARNINGS residuals from a whole-LINE classifier: APPLY_ROLLED_BACK's own original text
 *  ("Do NOT use shell commands to bypass. Re-investigate, then retry with apply_patch or
 *  Task...") put a prohibition and an instruction about two different tools on one rendered
 *  line, and a single verdict per line can only report one of them. */
export function splitSentences(line) {
  return line
    .split(/(?<=[.!?])\s+(?=[A-Z"(“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** instruction / prohibition / incidental, per item 100's own three-way classification
 *  (docs/deferred-work.md): an instruction to use an absent tool is the defect; a prohibition
 *  on an absent tool is noise; an incidental mention (describing a result format, what a tool
 *  does) is neither. */
export function classifySentence(sentence) {
  const neg = /\b(do not|don't|Do NOT|never|Never)\b/i.test(sentence);
  if (neg) return "prohibition";
  const instr = /\b(use|Use|call|Call|via|dispatch|retry with|apply that direction)\b/.test(sentence);
  if (instr) return "instruction";
  return "incidental";
}

function offeredFor(filter) {
  return resolveToolList(filter).map((t) => t.name).sort();
}

const BASE_AGENT_INPUT = {
  agentIntro: "You are Zone.",
  frameworkLines: [],
  hasFramework: false,
  projectMemoryBlock: "",
  importContextSummary: undefined,
  baseMaxIterations: 15,
  canRunCommand: false,
  backgroundCommandBlock: "",
  repoPath: "/repo",
  planProgressBlock: PLAN_PROGRESS_BLOCK_PLACEHOLDER,
  planAnnotationsBlock: "",
  auditFindings: undefined,
  planApproved: undefined,
  toolAbsenceBlock: "",
};

/** Builds all 19 configurations item 100 originally tested, resolving each one's real offered
 *  set through the real resolveToolList and assembling the real prompt — threading
 *  offeredToolNames correctly (the ledger pass's own classify.mjs never did this, so it kept
 *  measuring pre-fix behaviour even after the fix landed; fixed here from the start). */
export function buildConfigs() {
  assertPlaceholderSane(PLAN_PROGRESS_BLOCK_PLACEHOLDER);
  const configs = [];

  const pipelines = {
    simple_add: disp.SIMPLE_ADD_PIPELINE,
    question: disp.QUESTION_PIPELINE,
    investigation: disp.INVESTIGATION_PIPELINE,
    targeted_fix: disp.TARGETED_FIX_PIPELINE,
    refactor: disp.REFACTOR_PIPELINE,
  };
  for (const [name, pipe] of Object.entries(pipelines)) {
    const filter = disp.buildDispatcherCapabilityFilter({ ...pipe });
    const offered = offeredFor(filter);
    const hasRC = offered.includes("run_command");
    const hasRCR = offered.includes("run_command_readonly");
    configs.push({
      label: `archetype:${name}`,
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        archetype: name,
        canRunCommand: hasRC,
        qaCommandTool: hasRC ? "run_command" : hasRCR ? "run_command_readonly" : null,
        offeredToolNames: new Set(offered),
      }),
    });
  }

  for (const name of ["debug", "complex_multi_file"]) {
    const offered = offeredFor(undefined);
    configs.push({
      label: `archetype:${name}`,
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        archetype: name,
        canRunCommand: true,
        qaCommandTool: "run_command",
        offeredToolNames: new Set(offered),
      }),
    });
  }

  for (const tier of ["simple", "medium", "complex"]) {
    const filter = tierToolFilter(tier);
    const offered = offeredFor(filter);
    const hasRC = offered.includes("run_command");
    configs.push({
      label: `tier:${tier}`,
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        canRunCommand: hasRC,
        qaCommandTool: hasRC ? "run_command" : offered.includes("run_command_readonly") ? "run_command_readonly" : null,
        offeredToolNames: new Set(offered),
      }),
    });
  }

  {
    const offered = offeredFor({ allowToolNames: new Set(CHAT_TOOLS) });
    // assembleChatSystemPrompt is module-private (no `export`) — reproduced verbatim here,
    // matching the item-100 establish pass's own standalone verification. Its tool set is
    // fixed by construction (read_file/list_files only), so it needs no offeredToolNames
    // gating and is included for completeness, not because it can regress.
    const chatPrompt = [
      "You are Zone, answering conversationally about the user's codebase.",
      "",
      "Rules:",
      "- Do not modify files.",
      "- Do not run shell commands.",
      "- Use read_file and list_files only when code context is needed.",
      "- If the user asks for an edit, tell them to switch to patch mode.",
      "- Be concise, but include file references when they help.",
      "",
      "Repo path: /repo",
      "",
      "You may use up to 15 iterations, but stop as soon as you can answer well.",
      "FINAL SUMMARY: End with a brief 2-3 sentence prose summary of your answer. No code blocks (unless a snippet clarifies the point), no section headers.",
    ].join("\n");
    configs.push({ label: "mode-default:chat", assembler: "chat", offered, prompt: chatPrompt });
  }

  {
    const filter = { allow: new Set(["fs.read"]) };
    const offered = offeredFor(filter);
    const hasRC = offered.includes("run_command");
    configs.push({
      label: "mode-default:investigate",
      assembler: "investigation",
      offered,
      prompt: al.assembleInvestigationSystemPrompt({
        repoPath: "/repo",
        projectMemoryBlock: "",
        baseMaxIterations: 6,
        commandTool: hasRC ? "run_command" : offered.includes("run_command_readonly") ? "run_command_readonly" : null,
      }),
    });
  }

  {
    const offered = offeredFor(undefined);
    configs.push({
      label: "mode-default:patch",
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        canRunCommand: true,
        qaCommandTool: "run_command",
        offeredToolNames: new Set(offered),
      }),
    });
  }

  {
    const filter = { allowToolNames: new Set(INVESTIGATION_TOOLS) };
    const offered = offeredFor(filter);
    configs.push({
      label: "plan-investigation",
      assembler: "investigation",
      offered,
      prompt: al.assembleInvestigationSystemPrompt({
        repoPath: "/repo",
        projectMemoryBlock: "",
        baseMaxIterations: 6,
        commandTool: offered.includes("run_command") ? "run_command" : offered.includes("run_command_readonly") ? "run_command_readonly" : null,
        suppressOutputFormat: true,
      }),
    });
  }

  {
    const filter = { allowToolNames: new Set(AUDIT_ALLOWED_TOOLS) };
    const offered = offeredFor(filter);
    configs.push({
      label: "scope-audit",
      assembler: "investigation",
      offered,
      prompt: al.assembleInvestigationSystemPrompt({
        repoPath: "/repo",
        projectMemoryBlock: "",
        baseMaxIterations: 6,
        commandTool: offered.includes("run_command") ? "run_command" : offered.includes("run_command_readonly") ? "run_command_readonly" : null,
      }),
    });
  }

  for (const kind of ["worker", "explore", "verifier"]) {
    let filter;
    try { filter = resolveSubagentCapabilityFilter(kind); } catch { filter = undefined; }
    const offered = offeredFor(filter);
    const hasRC = offered.includes("run_command");
    configs.push({
      label: `subagent:${kind}`,
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        canRunCommand: hasRC,
        qaCommandTool: hasRC ? "run_command" : offered.includes("run_command_readonly") ? "run_command_readonly" : null,
        offeredToolNames: new Set(offered),
      }),
    });
  }

  {
    const filter = disp.buildDispatcherCapabilityFilter({ ...disp.QUESTION_PIPELINE });
    const offered = offeredFor(filter);
    configs.push({
      label: "answerOnly:true",
      assembler: "agent",
      offered,
      prompt: al.assembleAgentSystemPrompt({
        ...BASE_AGENT_INPUT,
        answerOnly: true,
        canRunCommand: false,
        qaCommandTool: "run_command_readonly",
        offeredToolNames: new Set(offered),
      }),
    });
  }

  return configs;
}

/** Sentence-level analysis of one configuration: every instruction-grade sentence naming a
 *  tool this configuration's own offered set does not contain. */
export function sweepConfig(config) {
  const rows = [];
  for (const line of config.prompt.split("\n")) {
    const lineTools = maskedLine(line);
    if (lineTools.length === 0) continue;
    for (const sentence of splitSentences(line)) {
      const sentenceTools = maskedLine(sentence);
      const absentTools = sentenceTools.filter((t) => !config.offered.includes(t));
      if (absentTools.length === 0) continue;
      rows.push({ tools: absentTools, cls: classifySentence(sentence), sentence: sentence.trim() });
    }
  }
  const instructionRows = rows.filter((r) => r.cls === "instruction");
  return { label: config.label, offeredCount: config.offered.length, rows, instructionRows };
}

function main() {
  const configs = buildConfigs();
  const results = configs.map(sweepConfig);

  // Pair-level matrix — the headline. A "pair" is (tool, configuration): the unit that showed
  // 29 of 41 already resolved when the binary configuration count still read 9 of 19 unchanged.
  const pairs = [];
  for (const r of results) {
    for (const row of r.instructionRows) {
      for (const tool of row.tools) pairs.push({ tool, config: r.label, sentence: row.sentence });
    }
  }

  console.log("=".repeat(90));
  console.log("TOOL-MENTION DEFECT SWEEP — pair-level (headline)");
  console.log("=".repeat(90));
  if (pairs.length === 0) {
    console.log("0 defective (tool, configuration) pairs across", configs.length, "configurations.");
  } else {
    console.log(`${pairs.length} defective (tool, configuration) pairs:`);
    for (const p of pairs) {
      console.log(`  [${p.tool}] ${p.config} :: ${p.sentence.slice(0, 140)}`);
    }
  }

  const defectiveConfigs = results.filter((r) => r.instructionRows.length > 0);
  console.log("-".repeat(90));
  console.log(
    `SECONDARY — binary configuration count: ${defectiveConfigs.length} of ${configs.length} ` +
    `configurations carry at least one defective pair` +
    (defectiveConfigs.length > 0 ? `: ${defectiveConfigs.map((r) => r.label).join(", ")}` : ".")
  );
  console.log("=".repeat(90));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
