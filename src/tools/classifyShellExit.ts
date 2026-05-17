export type ShellExitClassification = 'success' | 'likely_no_matches' | 'failure';

export interface ClassifyShellExitResult {
  classification: ShellExitClassification;
  hint: string | null;
}

export function classifyShellExit(exitCode: number, stdout: string, cmd: string): ClassifyShellExitResult {
  if (exitCode === 0) return { classification: 'success', hint: null };

  const hasGrepPipe = /\|\s*(grep|wc\s+-l)\b/.test(cmd);
  const trimmedStdout = stdout.trim();
  const isZeroCount = /^0\s*$/.test(trimmedStdout);

  if (hasGrepPipe && isZeroCount) {
    return {
      classification: 'likely_no_matches',
      hint: 'Pipeline returned exitCode=1 with zero-count output. This is likely a grep no-match scenario, NOT a real failure. Verify the target operation directly (e.g., re-run the test file by path) before concluding failure.',
    };
  }

  return { classification: 'failure', hint: null };
}
