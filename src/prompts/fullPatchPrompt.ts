interface FullPatchPromptInput {
  task: string;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
}

export function buildFullPatchPrompt(input: FullPatchPromptInput): string {
  const { task, filePath, fileContent, repoSummary, relatedContext } = input;

  return `
You are a senior software engineer applying a precise code change to an existing file.

TASK
${task}

TARGET FILE
${filePath}

REPO SUMMARY
${repoSummary}

RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

INSTRUCTIONS
- Apply the task to the file above
- Return the COMPLETE updated file content
- Preserve all existing code that is unrelated to the task
- Keep existing imports, exports, formatting, and naming conventions
- Do not add markdown fences or explanations
- If the file does not need changes, return it unchanged
- If RELATED CONTEXT contains existing Java page object files, import and use them — never create a new WebDriver instance directly
- Use the exact method signatures found in the page object files in RELATED CONTEXT
- For Java step definitions, always inject page objects via constructor or instance variables, not by instantiating WebDriver directly
- For JavaScript/TypeScript files: ALWAYS use "export default ClassName" (the class itself), NEVER "export default new ClassName()" (an instance)
- For JavaScript/TypeScript page objects: the caller will instantiate with "new ClassName()" — never pre-instantiate
- For Cypress tests: use cy.visit("/") not cy.visit("https://...") when baseUrl is configured
- For Cypress page objects: never hardcode the full URL in visit() — use relative paths
- For Cypress tests: ensure all method names in spec files EXACTLY match the method names defined in page object files — never invent method names
- If you see existing page object files in RELATED CONTEXT, list their exact method names and use ONLY those names in the spec file
OUTPUT FORMAT
Return JSON only:
{
  "filePath": "string",
  "fullContent": "string",
  "summary": "string",
  "warnings": ["string"]
}
`.trim();
}
