import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSemanticSmells,
  validateSyntax,
} from "../astSyntaxValidator.ts";
import { executeTool } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

function setupTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-smell-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

function runSmellCase({ label, filePath, content, expectedReason, shouldDetect }) {
  const syntax = validateSyntax(content, filePath);
  const smell = checkSemanticSmells(content, filePath, syntax.ast);
  return { label, syntax, smell, expectedReason, shouldDetect };
}

(async function main() {
  const checks = [];

  console.log("\n=== Direct semantic smell checks ===");

  const smellCases = [
    runSmellCase({
      label: "broken_template_expression positive",
      filePath: "TemplatePositive.jsx",
      content: "export const x = `hi $ {name}`;\n",
      expectedReason: "broken_template_expression",
      shouldDetect: true,
    }),
    runSmellCase({
      label: "broken_template_expression negative",
      filePath: "TemplateNegative.jsx",
      content: "export const x = `hi ${name}`;\n",
      expectedReason: undefined,
      shouldDetect: false,
    }),
    runSmellCase({
      label: "duplicate_jsx_attribute positive",
      filePath: "DupAttrPositive.jsx",
      content: "export function App() { return <div className=\"a\" className=\"b\" />; }\n",
      expectedReason: "duplicate_jsx_attribute",
      shouldDetect: true,
    }),
    runSmellCase({
      label: "duplicate_jsx_attribute negative",
      filePath: "DupAttrNegative.jsx",
      content: "export function App() { return <div className=\"a\" id=\"b\" />; }\n",
      expectedReason: undefined,
      shouldDetect: false,
    }),
    runSmellCase({
      label: "duplicate_import_statement positive",
      filePath: "DupImportPositive.ts",
      content: "import { a } from \"x\";\nimport { b } from \"x\";\nexport const c = a + b;\n",
      expectedReason: "duplicate_import_statement",
      shouldDetect: true,
    }),
    runSmellCase({
      label: "duplicate_import_statement negative",
      filePath: "DupImportNegative.ts",
      content: "import { a, b } from \"x\";\nexport const c = a + b;\n",
      expectedReason: undefined,
      shouldDetect: false,
    }),
    runSmellCase({
      label: "inline_style_pseudo_class positive",
      filePath: "InlinePseudoPositive.jsx",
      content: "export function App() { return <div style={{\":hover\": { color: \"red\" }}} />; }\n",
      expectedReason: "inline_style_pseudo_class",
      shouldDetect: true,
    }),
    runSmellCase({
      label: "inline_style_pseudo_class negative",
      filePath: "InlinePseudoNegative.jsx",
      content: "export function App() { return <div style={{ color: \"red\" }} />; }\n",
      expectedReason: undefined,
      shouldDetect: false,
    }),
  ];

  for (const testCase of smellCases) {
    checks.push(check(
      `${testCase.label} parses successfully`,
      testCase.syntax.ok === true,
      { syntax: testCase.syntax }
    ));
    checks.push(check(
      `${testCase.label} smell result`,
      testCase.shouldDetect
        ? testCase.smell.ok === false && testCase.smell.reason === testCase.expectedReason
        : testCase.smell.ok === true,
      { smell: testCase.smell }
    ));
  }

  console.log("\n=== Real-world regression sample ===");

  const realWorldBrokenContent =
    "export function AppointmentsPage({ appointment, selectedAppointment, draggingId }) {\n" +
    "  return (\n" +
    "    <div\n" +
    "      className={`smile-appointment-canvas-card status-${getStatusClass(appointment.status)} $ {selectedAppointment?.id === appointment.id ? \"active\" : \"\"} ${draggingId === appointment.id ? \"dragging\" : \"\"}`}\n" +
    "      className=\"legacy-card\"\n" +
    "      style={{ borderRadius: \"12px\", transition: \"transform 0.2s\", \":hover\": { transform: \"translateY(-2px)\" } }}\n" +
    "    >\n" +
    "      Appointment\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n";
  const realWorldSyntax = validateSyntax(realWorldBrokenContent, "AppointmentsPage.jsx");
  const realWorldSmell = checkSemanticSmells(
    realWorldBrokenContent,
    "AppointmentsPage.jsx",
    realWorldSyntax.ast
  );

  checks.push(check(
    "real-world sample parses successfully",
    realWorldSyntax.ok === true,
    { syntax: realWorldSyntax }
  ));
  checks.push(check(
    "real-world sample detects a smell",
    realWorldSmell.ok === false,
    { smell: realWorldSmell }
  ));
  checks.push(check(
    "real-world sample reports broken_template_expression first",
    realWorldSmell.reason === "broken_template_expression",
    { smell: realWorldSmell }
  ));

  console.log("\n=== apply_patch integration regression ===");

  {
    const { tempDir, cleanup } = setupTempDir();
    const relPath = "AppointmentsPage.jsx";
    const originalContent =
      "export function AppointmentsPage({ appointment, selectedAppointment }) {\n" +
      "  return (\n" +
      "    <div className={`smile-appointment-canvas-card status-${getStatusClass(appointment.status)} ${selectedAppointment?.id === appointment.id ? \"active\" : \"\"}`}>\n" +
      "      Appointment\n" +
      "    </div>\n" +
      "  );\n" +
      "}\n";
    fs.writeFileSync(path.join(tempDir, relPath), originalContent, "utf8");

    const patch =
      "--- FIND ---\n" +
      "    <div className={`smile-appointment-canvas-card status-${getStatusClass(appointment.status)} ${selectedAppointment?.id === appointment.id ? \"active\" : \"\"}`}>\n" +
      "--- REPLACE ---\n" +
      "    <div className={`smile-appointment-canvas-card status-${getStatusClass(appointment.status)} $ {selectedAppointment?.id === appointment.id ? \"active\" : \"\"}`}>";

    const result = await executeTool(
      "apply_patch",
      { filePath: relPath, patch, intent: "modify", scope: null },
      tempDir
    );
    const after = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    checks.push(check(
      "apply_patch integration returns failure",
      result.success === false,
      { result }
    ));
    checks.push(check(
      "apply_patch integration reports semantic_smell_post_write",
      result.rejectionReason === "semantic_smell_post_write",
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "apply_patch integration mentions broken_template_expression",
      result.output.includes("broken_template_expression"),
      { output: result.output }
    ));
    checks.push(check(
      "apply_patch integration reverts the file",
      after === originalContent,
      { reverted: after === originalContent }
    ));

    cleanup();
  }

  const failed = checks.filter((item) => !item.pass);
  console.log("\n=== assert summary ===");
  console.log(JSON.stringify(
    { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    null,
    2
  ));

  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const failedCheck of failed) {
      console.log(
        "  FAIL:",
        failedCheck.label,
        failedCheck.details !== undefined ? JSON.stringify(failedCheck.details) : ""
      );
    }
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("Unexpected error in test runner:", error);
  process.exitCode = 1;
});
