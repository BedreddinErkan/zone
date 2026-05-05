/**
 * Manual test for hard-blocking apply_patch after file escalation.
 *
 * Run after building dist, or point module env vars at a compiled copy:
 *   node --experimental-strip-types src/llm/__tests__/runEscalatedGateManual.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentLoopModulePath =
  process.env.ZONE_AGENT_LOOP_MODULE || "../../../dist/llm/agentLoop.js";
const toolExecutorModulePath =
  process.env.ZONE_TOOL_EXECUTOR_MODULE || "../../../dist/tools/toolExecutor.js";

const { buildCoachingPrompt } = await import(agentLoopModulePath);
const { executeTool } = await import(toolExecutorModulePath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

function patch(find, replace) {
  return `--- FIND ---\n${find}\n--- REPLACE ---\n${replace}`;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-escalated-gate-test-"));
const checks = [];

try {
  fs.writeFileSync(path.join(tempDir, "foo.ts"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "bar.ts"), "export const value = 1;\n", "utf8");

  {
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "foo.ts",
        patch: patch("export const value = 1;", "export const value = 2;"),
        intent: "modify",
        scope: null,
      },
      tempDir,
      undefined,
      { escalatedFiles: new Set(["foo.ts"]) }
    );
    checks.push(check(
      "gate blocks apply_patch for escalated file",
      result.success === false &&
        result.output.includes("BLOCKED") &&
        result.error === "apply_patch_blocked_escalated" &&
        result.rejectionReason === "blocked_escalated_file",
      { result }
    ));
  }

  {
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "bar.ts",
        patch: patch("export const value = 1;", "export const value = 2;"),
        intent: "modify",
        scope: null,
      },
      tempDir,
      undefined,
      { escalatedFiles: new Set(["foo.ts"]) }
    );
    checks.push(check(
      "gate does not block apply_patch for non-escalated file",
      result.error !== "apply_patch_blocked_escalated" &&
        result.rejectionReason !== "blocked_escalated_file",
      { result }
    ));
  }

  {
    const result = await executeTool(
      "write_file",
      { filePath: "foo.ts", content: "export const written = true;\n" },
      tempDir,
      undefined,
      {
        escalatedFiles: new Set(["foo.ts"]),
        allowWriteFileOverwritePaths: new Set(["foo.ts"]),
      }
    );
    checks.push(check(
      "gate does not block write_file for escalated file",
      result.error !== "apply_patch_blocked_escalated" &&
        result.rejectionReason !== "blocked_escalated_file",
      { result }
    ));
  }

  {
    const text = buildCoachingPrompt(
      "apply_patch_repeated_failure_same_file",
      "",
      [],
      { filePath: "foo.ts", attemptCount: 2 }
    );
    checks.push(check(
      "coaching prompt mentions BLOCKED write_file and file path",
      text.includes("BLOCKED") && text.includes("write_file") && text.includes("foo.ts"),
      { preview: text.slice(0, 260) }
    ));
  }

  {
    const text = buildCoachingPrompt(
      "apply_patch_repeated_failure_same_file",
      "",
      [],
      { filePath: "bar/baz.tsx", attemptCount: 3 }
    );
    checks.push(check(
      "coaching prompt uses provided filePath",
      text.includes("bar/baz.tsx") && !text.includes("\"this file\""),
      { preview: text.slice(0, 260) }
    ));
  }

  {
    const progressEvents = [];
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "foo.ts",
        patch: patch("export const written = true;", "export const written = false;"),
        intent: "modify",
        scope: null,
      },
      tempDir,
      (msg) => progressEvents.push(msg),
      { escalatedFiles: new Set(["foo.ts"]) }
    );
    checks.push(check(
      "telemetry log fires on block",
      result.error === "apply_patch_blocked_escalated" &&
        progressEvents.some((msg) => {
          try {
            return JSON.parse(msg).event === "zone-tool-apply-patch-blocked-escalated";
          } catch {
            return false;
          }
        }),
      { progressEvents }
    ));
  }
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `[escalated-gate-test] PASSED ${checks.length - failed.length}/${checks.length} assertions`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
