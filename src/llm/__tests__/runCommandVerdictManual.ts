/**
 * Regression test for the run_command verdict heuristic removal.
 *
 * Before fix: a passing Next.js build whose stderr contained tokens like
 * "_global-error" or "FAIL" was misclassified as failed by the regex
 * heuristic, sending the agent loop into a coaching retry on a build that
 * actually exited 0.
 *
 * After fix: toolFailed = !result.success — exit code is the source of
 * truth for run_command; success bool for everything else.
 *
 * Run with:
 *   npx tsx src/llm/__tests__/runCommandVerdictManual.ts
 */

type ToolResult = { success: boolean; output: string };

// Replicates the post-fix logic from agentLoop.ts (around line 1517).
function toolFailed(name: string, result: ToolResult): boolean {
  void name;
  return !result.success;
}

type Case = {
  label: string;
  tool: string;
  result: ToolResult;
  expected: boolean;
};

const cases: Case[] = [
  {
    label: "A: run_command exit 0 with '_global-error' and 'FAIL' tokens in stderr",
    tool: "run_command",
    result: {
      success: true,
      output:
        "▲ Next.js 16.2.2\nGenerating static pages (12/12)\n" +
        "Route: /_global-error 425 B\n" +
        " ✓ Compiled successfully\n" +
        "warn: 1 FAIL ignored (deprecation)\n",
    },
    expected: false,
  },
  {
    label: "B: run_command exit 0, clean Next.js build summary",
    tool: "run_command",
    result: {
      success: true,
      output:
        "▲ Next.js 16.2.2\n✓ Compiled successfully in 3.6s\n" +
        "Route (app)\n├ ○ /\n├ ƒ /api/healthz\nƒ Proxy (Middleware)\n",
    },
    expected: false,
  },
  {
    label: "C: run_command exit 1 with stack trace",
    tool: "run_command",
    result: {
      success: false,
      output:
        "Error: Cannot find module '@/components/AppProviders'\n" +
        "    at Module._resolveFilename (node:internal/modules/cjs/loader.js:902:15)\n" +
        "    at app/layout.tsx:1\n" +
        "exit code: 1",
    },
    expected: true,
  },
  {
    label: "D: apply_patch failure (success: false)",
    tool: "apply_patch",
    result: {
      success: false,
      output:
        "Patch applied but broke file syntax (line 12, col 5): unexpected token. " +
        "The file has been reverted.",
    },
    expected: true,
  },
  {
    label: "E: apply_patch success (success: true)",
    tool: "apply_patch",
    result: {
      success: true,
      output: "Patch applied: 1 block(s) in app/layout.tsx",
    },
    expected: false,
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const got = toolFailed(c.tool, c.result);
  const ok = got === c.expected;
  if (ok) {
    console.log(`[PASS] ${c.label}`);
    passed++;
  } else {
    console.log(
      `[FAIL] ${c.label} :: expected toolFailed=${c.expected}, got ${got}`
    );
    failed++;
  }
}

console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
