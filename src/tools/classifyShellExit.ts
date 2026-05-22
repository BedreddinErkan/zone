export type ShellExitClassification = 'success' | 'likely_no_matches' | 'failure';

export interface ClassifyShellExitResult {
  classification: ShellExitClassification;
  hint: string | null;
}

export function classifyShellExit(exitCode: number, stdout: string, cmd: string): ClassifyShellExitResult {
  if (exitCode === 0) return { classification: 'success', hint: null };

  // Piped grep/wc-l: exits with last stage's code (usually 0), but grep stage exits 1 on no-match.
  const isGrepPipe = /\|\s*(grep|wc\s+-l)\b/.test(cmd);
  // Direct grep -c / -ic / -ci etc.: exits 1 on zero matches, stdout is "0".
  const isGrepCount = /\bgrep\b[^|]*\s-[a-zA-Z]*c[a-zA-Z]*(?:\s|$)/.test(cmd);
  const trimmedStdout = stdout.trim();
  const isZeroCount = /^0\s*$/.test(trimmedStdout);

  if ((isGrepPipe || isGrepCount) && isZeroCount) {
    return {
      classification: 'likely_no_matches',
      hint: 'Pipeline returned exitCode=1 with zero-count output. This is likely a grep no-match scenario, NOT a real failure. Verify the target operation directly (e.g., re-run the test file by path) before concluding failure.',
    };
  }

  return { classification: 'failure', hint: null };
}
