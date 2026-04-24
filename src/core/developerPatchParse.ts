export interface ParsedDeveloperPatch {
  filePath: string;
  edits: Array<{ find: string; replace: string }>;
  createContent?: string;
  noChangeNeeded?: boolean;
}

export function stripPatchTextFences(rawPatchText: string): string {
  let t = rawPatchText.trim();
  t = t.replace(/^```(?:json|text|txt|patch|diff)?\s*\n?/i, "");
  t = t.replace(/\n?```\s*$/i, "");
  return t.trim();
}

export function parseFindReplacePatch(rawPatchText: string): {
  find: string;
  replace: string;
} | null {
  const match = rawPatchText.match(
    /--- FIND ---\s*\n([\s\S]*?)\n--- REPLACE ---\s*\n([\s\S]*)$/i
  );
  if (!match) {
    return null;
  }

  return {
    find: match[1],
    replace: match[2],
  };
}

export function parseDeveloperPatchText(
  rawPatchText: string
): ParsedDeveloperPatch | null {
  const normalizedPatchText = stripPatchTextFences(rawPatchText);
  if (normalizedPatchText === "NO_CHANGE_NEEDED") {
    return {
      filePath: "",
      edits: [],
      noChangeNeeded: true,
    };
  }
  if (normalizedPatchText === "NO_VALID_PATCH") {
    return null;
  }

  const barePatch = parseFindReplacePatch(normalizedPatchText);
  if (barePatch) {
    return {
      filePath: "",
      edits: [barePatch],
    };
  }

  const fileLineMatch = normalizedPatchText.match(
    /^---\s*FILE:\s*([^\n\r]+)\s*\r?\n([\s\S]*)$/im
  );
  const fileLegacyMatch = normalizedPatchText.match(
    /^---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*)$/im
  );
  const match = fileLineMatch ?? fileLegacyMatch;
  if (!match) {
    return null;
  }

  let body = match[2].trim();
  body = body.replace(/^```diff\s*\n/i, "").replace(/\n```\s*$/i, "").trim();

  const filePath = match[1].trim();
  const bareInBody = parseFindReplacePatch(body);
  if (bareInBody) {
    return {
      filePath,
      edits: [bareInBody],
    };
  }

  const createMatch = body.match(/^CREATE:\s*\n?([\s\S]*)$/i);
  if (createMatch) {
    return {
      filePath,
      edits: [],
      createContent: createMatch[1],
    };
  }

  const edits: Array<{ find: string; replace: string }> = [];
  const editRegex =
    /FIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nFIND:\s*\n|$)/gi;
  let editMatch: RegExpExecArray | null = null;

  while ((editMatch = editRegex.exec(body)) !== null) {
    edits.push({
      find: editMatch[1],
      replace: editMatch[2],
    });
  }

  return edits.length > 0 ? { filePath, edits } : null;
}
