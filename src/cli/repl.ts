import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { runOneShotInner } from "./dispatch.js";
import { loadCliConfig, validateCliConfig, type CliFlags } from "./config.js";
import type { LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";

function printReplResult(result: LlmPatchFlowResult, noColor: boolean): void {
  const green = noColor ? "" : "\x1b[32m";
  const red = noColor ? "" : "\x1b[31m";
  const dim = noColor ? "" : "\x1b[2m";
  const reset = noColor ? "" : "\x1b[0m";
  const ok = "ok" in result && result.ok === true;
  const mode =
    ok && "decisionMode" in result ? (result.decisionMode ?? "done") : "incomplete";
  process.stdout.write(
    `${ok ? green : red}  [${mode}]${reset} ${dim}— ready for next task${reset}\n\n`
  );
}

export async function runRepl(flags: Partial<CliFlags>): Promise<void> {
  const config = loadCliConfig(flags);

  try {
    validateCliConfig(config);
  } catch (err) {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  const conversationId = `repl-${randomUUID().slice(0, 8)}`;

  const dim = config.noColor ? "" : "\x1b[2m";
  const cyan = config.noColor ? "" : "\x1b[36m";
  const bold = config.noColor ? "" : "\x1b[1m";
  const reset = config.noColor ? "" : "\x1b[0m";

  process.stdout.write(
    `${bold}${cyan}Zone REPL${reset}${dim} — type a task, or "exit" / Ctrl-D to quit${reset}\n\n`
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let activeAc: AbortController | null = null;
  let sigintCount = 0;

  const sigintHandler = (): void => {
    if (activeAc) {
      activeAc.abort();
      activeAc = null;
      process.stdout.write("\n  (task aborted — enter a new task)\n\n");
      sigintCount = 0;
    } else {
      sigintCount++;
      if (sigintCount >= 2) {
        rl.close();
      } else {
        process.stdout.write("\n  (^C again to exit)\n\n");
      }
    }
  };

  process.on("SIGINT", sigintHandler);

  const question = (prompt: string): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (val: string | null): void => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      rl.question(prompt, settle);
      rl.once("close", () => settle(null));
    });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const input = await question(`${cyan}zone>${reset} `);
      if (input === null) break; // EOF (Ctrl-D) or rl.close()

      const trimmed = input.trim();
      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") break;

      sigintCount = 0;
      const runId = randomUUID();
      activeAc = new AbortController();

      try {
        const result = await runOneShotInner(trimmed, config, runId, {
          conversationId,
          externalAc: activeAc,
        });
        printReplResult(result, config.noColor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          activeAc?.signal.aborted ||
          msg.includes("AbortError") ||
          msg.includes("aborted")
        ) {
          // Already printed "(task aborted)" in sigintHandler
        } else {
          process.stderr.write(`error: ${msg}\n\n`);
        }
      } finally {
        activeAc = null;
      }
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    try { rl.close(); } catch { /* already closed */ }
    process.stdout.write("Bye.\n");
  }
}
