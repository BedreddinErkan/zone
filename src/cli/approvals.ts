import { createInterface } from "node:readline";
import {
  resolveCommandApproval,
} from "../api/commandApprovals.js";
import {
  resolveRevisionApproval,
} from "../llm/revisionApprovals.js";
import type { Spinner } from "./sink.js";

export interface ApprovalOpts {
  autoApprove: boolean;
  noRevision: boolean;
  isTTY: boolean;
  noColor: boolean;
}

async function readlineQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function promptCommandApproval(
  approvalId: string,
  command: string,
  runId: string,
  opts: ApprovalOpts,
  spinner: Spinner
): Promise<void> {
  if (opts.autoApprove) {
    resolveCommandApproval({ approvalId, approved: true, runId });
    return;
  }

  if (!opts.isTTY) {
    resolveCommandApproval({ approvalId, approved: false, runId });
    process.stderr.write(
      "error: command approval required but no TTY. Use --yes to auto-approve.\n"
    );
    return;
  }

  spinner.pauseForPrompt();

  const yellow = opts.noColor ? "" : "\x1b[33m";
  const reset = opts.noColor ? "" : "\x1b[0m";
  const bold = opts.noColor ? "" : "\x1b[1m";

  process.stdout.write(`\n${yellow}Approve command:${reset} ${bold}${command}${reset}\n`);
  const answer = await readlineQuestion("  [y]es / [N]o / [t]rust-for-run: ");

  spinner.resumeAfterPrompt();

  const approved = answer === "y" || answer === "yes";
  const trust = answer === "t" || answer === "trust";

  resolveCommandApproval({
    approvalId,
    approved: approved || trust,
    runId,
    trust,
  });
}

export async function promptScopeRevision(
  revisionId: string,
  summary: string,
  runId: string,
  opts: ApprovalOpts,
  spinner: Spinner
): Promise<void> {
  if (opts.noRevision) {
    resolveRevisionApproval({ revisionId, runId, decision: "reject" });
    return;
  }

  if (opts.autoApprove) {
    resolveRevisionApproval({ revisionId, runId, decision: "approve" });
    return;
  }

  if (!opts.isTTY) {
    resolveRevisionApproval({ revisionId, runId, decision: "reject" });
    process.stderr.write(
      "warning: scope revision proposed but no TTY. Rejected. Use --yes to approve or --no-revision to suppress.\n"
    );
    return;
  }

  spinner.pauseForPrompt();

  const yellow = opts.noColor ? "" : "\x1b[33m";
  const reset = opts.noColor ? "" : "\x1b[0m";

  process.stdout.write(`\n${yellow}Scope revision proposed:${reset} ${summary}\n`);
  const answer = await readlineQuestion("  Apply revision? [y/N]: ");

  spinner.resumeAfterPrompt();

  const decision =
    answer === "y" || answer === "yes" ? "approve" : "reject";
  resolveRevisionApproval({ revisionId, runId, decision });
}
