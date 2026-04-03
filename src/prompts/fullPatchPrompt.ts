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
* Apply the task to the file above
* Return the COMPLETE updated file content
* Preserve all existing code that is unrelated to the task
* Keep existing imports, exports, formatting, and naming conventions
* Do not add markdown fences or explanations
* If the file does not need changes, return it unchanged

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
