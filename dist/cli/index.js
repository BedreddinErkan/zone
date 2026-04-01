#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const commander_1 = require("commander");
const paths_js_1 = require("../utils/paths.js");
const runFeatureAgent_js_1 = require("../core/runFeatureAgent.js");
const logger_js_1 = require("../utils/logger.js");
const program = new commander_1.Command();
program
    .name("smile-agent")
    .description("SmileAI development agent")
    .version("1.0.0");
program
    .command("feature")
    .description("Analyze a feature request against a target project")
    .argument("<task>", "Feature task description")
    .option("-p, --path <path>", "Target project path")
    .action(async (task, options) => {
    try {
        const targetPath = (0, paths_js_1.resolveTargetPath)(options.path);
        (0, logger_js_1.logInfo)(`Target path resolved: ${targetPath}`);
        const result = await (0, runFeatureAgent_js_1.runFeatureAgent)({
            task,
            targetPath
        });
        console.log("\n=== FEATURE ANALYSIS SUMMARY ===");
        console.log(result.summary);
        console.log("\n=== PROJECT NOTES ===");
        for (const note of result.structure.notes) {
            console.log(`- ${note}`);
        }
        console.log("\n=== RELEVANT FILES ===");
        if (result.relevantFiles.length === 0) {
            console.log("No relevant files found.");
        }
        else {
            for (const file of result.relevantFiles) {
                console.log(`- [${file.category}] ${file.path}`);
            }
        }
        console.log("\n=== VALIDATED SUGGESTED FILES ===");
        if (result.validatedSuggestedFiles.length === 0) {
            console.log("- No validated suggested files.");
        }
        else {
            result.validatedSuggestedFiles.forEach((file) => {
                console.log(`- [${file.status}] ${file.originalPath} -> ${file.resolvedPath ?? "NOT FOUND"}`);
                console.log(`  action: ${file.action}`);
                console.log(`  reason: ${file.reason}`);
            });
        }
        if (result.llmPlan) {
            console.log("\n=== IMPLEMENTATION SUMMARY ===");
            console.log(result.llmPlan.implementationSummary);
            console.log("\n=== IMPLEMENTATION STEPS ===");
            if (result.llmPlan.steps.length === 0) {
                console.log("- No steps returned.");
            }
            else {
                result.llmPlan.steps.forEach((step, index) => {
                    console.log(`${index + 1}. ${step}`);
                });
            }
            console.log("\n=== SUGGESTED FILES ===");
            if (result.llmPlan.suggestedFiles.length === 0) {
                console.log("- No suggested files returned.");
            }
            else {
                result.llmPlan.suggestedFiles.forEach((file) => {
                    console.log(`- [${file.action}] ${file.path}`);
                    console.log(`  reason: ${file.reason}`);
                });
            }
            console.log("\n=== RISKS ===");
            if (result.llmPlan.risks.length === 0) {
                console.log("- No risks returned.");
            }
            else {
                result.llmPlan.risks.forEach((risk) => {
                    console.log(`- ${risk}`);
                });
            }
        }
        if (result.patchPlan) {
            console.log("\n=== PATCH PREVIEW SUMMARY ===");
            console.log(result.patchPlan.summary);
            console.log("\n=== PATCH PREVIEW ITEMS ===");
            if (result.patchPlan.patches.length === 0) {
                console.log("- No patch preview items returned.");
            }
            else {
                result.patchPlan.patches.forEach((patch, index) => {
                    console.log(`\n${index + 1}. [${patch.operation}] ${patch.path}`);
                    console.log(`   summary: ${patch.summary}`);
                    console.log(`   target: ${patch.targetHint}`);
                    console.log("   preview:");
                    console.log(patch.contentPreview
                        .split("\n")
                        .map((line) => `     ${line}`)
                        .join("\n"));
                });
            }
            console.log("\n=== PATCH WARNINGS ===");
            if (result.patchPlan.warnings.length === 0) {
                console.log("- No warnings returned.");
            }
            else {
                result.patchPlan.warnings.forEach((warning) => {
                    console.log(`- ${warning}`);
                });
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        (0, logger_js_1.logError)(message);
        process.exit(1);
    }
});
program.parse();
//# sourceMappingURL=index.js.map