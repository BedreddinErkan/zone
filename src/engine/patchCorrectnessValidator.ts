export type PatchCorrectnessIssue = {
  layer: 0 | 1 | 2 | 3 | 4;
  code: string;
  severity: "block" | "warn";
  message: string;
  locationHint?: { line: number; snippet: string };
};

export type PatchCorrectnessReport = {
  ok: boolean;
  blocking: PatchCorrectnessIssue[];
  warnings: PatchCorrectnessIssue[];
  forceBlocked: boolean;
  forcePreviewOnly: boolean;
  layersRun: number;
  shortCircuitedAt: number | null;
};

export type PatchCorrectnessInput = {
  filePath: string;
  originalContent: string;
  updatedContent: string;
  task: string;
  isConstrained: boolean;
  taskConstraints: {
    requiresExistingForm: boolean;
    requiresExistingSubmitFlow: boolean;
    requiresExistingState: boolean;
    avoidsNewForm: boolean;
    avoidsNewApiCall: boolean;
  };
  strictMode: boolean;
};

type IssueFactoryInput = {
  layer: 0 | 1 | 2 | 3 | 4;
  code: string;
  severity: "block" | "warn";
  message: string;
  locationHint?: { line: number; snippet: string };
};

function issue(input: IssueFactoryInput): PatchCorrectnessIssue {
  return {
    layer: input.layer,
    code: input.code,
    severity: input.severity,
    message: input.message,
    locationHint: input.locationHint,
  };
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function stripCommentsForComparison(input: string): string {
  // Best-effort comment stripping for normalization. This intentionally does NOT
  // attempt to parse every edge case; it only needs to be stable/deterministic.
  const s = input.replace(/\r\n/g, "\n");
  let out = "";
  let mode: "code" | "single" | "double" | "template" | "line" | "block" =
    "code";
  let escaped = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] ?? "";
    const next = s[i + 1] ?? "";

    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += "\n";
      }
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i += 1;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (mode === "single" && ch === "'") mode = "code";
      if (mode === "double" && ch === '"') mode = "code";
      if (mode === "template" && ch === "`") mode = "code";
      continue;
    }

    // mode === "code"
    if (ch === "/" && next === "/") {
      mode = "line";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      mode = "block";
      i += 1;
      continue;
    }
    out += ch;
    if (ch === "'") mode = "single";
    if (ch === '"') mode = "double";
    if (ch === "`") mode = "template";
  }

  return out;
}

function normalizeForSanityCompare(input: string): string {
  return normalizeWhitespace(stripCommentsForComparison(input));
}

function fastDiffCounts(before: string, after: string): {
  addedLines: number;
  removedLines: number;
  totalChangedLines: number;
} {
  const beforeLines = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const removedLines = Math.max(0, endBefore - start + 1);
  const addedLines = Math.max(0, endAfter - start + 1);
  return { addedLines, removedLines, totalChangedLines: addedLines + removedLines };
}

function estimateChangedLineRange(before: string, after: string): {
  startLine: number;
  endLineBefore: number;
  endLineAfter: number;
} {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  const minLen = Math.min(beforeLines.length, afterLines.length);
  let start = 0;
  while (start < minLen && beforeLines[start] === afterLines[start]) start += 1;
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return {
    startLine: start + 1,
    endLineBefore: Math.max(start + 1, endBefore + 1),
    endLineAfter: Math.max(start + 1, endAfter + 1),
  };
}

function getImportRegionEndLine(original: string): number {
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  let started = false;
  let endLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const t = raw.trim();
    if (!t) {
      if (!started) continue;
      // allow blank lines inside import block
      endLine = i + 1;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) {
      if (!started) continue;
      endLine = i + 1;
      continue;
    }
    if (t === "\"use strict\";" || t === "'use strict';") {
      if (!started) continue;
      endLine = i + 1;
      continue;
    }
    if (t.startsWith("import ")) {
      started = true;
      endLine = i + 1;
      continue;
    }
    // First real non-import statement after imports -> stop.
    if (started) break;
    // If imports never started, keep scanning.
  }
  return endLine;
}

function touchesImportRegion(input: {
  originalContent: string;
  updatedContent: string;
}): boolean {
  const range = estimateChangedLineRange(input.originalContent, input.updatedContent);
  const importEnd = getImportRegionEndLine(input.originalContent);
  if (importEnd <= 0) return false;
  return range.startLine <= importEnd;
}

function isJsLike(filePath: string): boolean {
  const p = filePath.toLowerCase();
  return p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".ts") || p.endsWith(".tsx");
}

function isSkippedLayer1File(filePath: string): boolean {
  const p = filePath.toLowerCase();
  return (
    p.endsWith(".css") ||
    p.endsWith(".html") ||
    p.endsWith(".json") ||
    p.endsWith(".md") ||
    p.endsWith(".txt")
  );
}

function minimalBraceBracketBalance(
  layer: 1,
  content: string
): PatchCorrectnessIssue[] {
  let braces = 0;
  let brackets = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] ?? "";
    if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    if (braces < 0 || brackets < 0) {
      return [
        issue({
          layer,
          code: "unbalanced_delimiters",
          severity: "block",
          message: "Unbalanced delimiters detected.",
        }),
      ];
    }
  }
  if (braces !== 0 || brackets !== 0) {
    return [
      issue({
        layer,
        code: "unbalanced_delimiters",
        severity: "block",
        message: "Unbalanced delimiters detected.",
      }),
    ];
  }
  return [];
}

type DelimiterCounts = {
  braces: { opens: number; closes: number };
  brackets: { opens: number; closes: number };
  parens: { opens: number; closes: number };
};

function analyzeDelimiterCounts(content: string): DelimiterCounts {
  const s = content.replace(/\r\n/g, "\n");
  let bracesOpen = 0;
  let bracesClose = 0;
  let bracketsOpen = 0;
  let bracketsClose = 0;
  let parensOpen = 0;
  let parensClose = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] ?? "";
    if (ch === "{") bracesOpen += 1;
    else if (ch === "}") bracesClose += 1;
    else if (ch === "[") bracketsOpen += 1;
    else if (ch === "]") bracketsClose += 1;
    else if (ch === "(") parensOpen += 1;
    else if (ch === ")") parensClose += 1;
  }
  return {
    braces: { opens: bracesOpen, closes: bracesClose },
    brackets: { opens: bracketsOpen, closes: bracketsClose },
    parens: { opens: parensOpen, closes: parensClose },
  };
}

function computeDelimiterDelta(before: DelimiterCounts, after: DelimiterCounts): DelimiterCounts {
  return {
    braces: {
      opens: after.braces.opens - before.braces.opens,
      closes: after.braces.closes - before.braces.closes,
    },
    brackets: {
      opens: after.brackets.opens - before.brackets.opens,
      closes: after.brackets.closes - before.brackets.closes,
    },
    parens: {
      opens: after.parens.opens - before.parens.opens,
      closes: after.parens.closes - before.parens.closes,
    },
  };
}

function delimiterWorsened(before: DelimiterCounts, after: DelimiterCounts): boolean {
  const worsenedKind = (b: { opens: number; closes: number }, a: { opens: number; closes: number }) =>
    a.opens > b.opens || a.closes < b.closes;
  return (
    worsenedKind(before.braces, after.braces) ||
    worsenedKind(before.brackets, after.brackets) ||
    worsenedKind(before.parens, after.parens)
  );
}

function delimiterUnchangedOrImproved(before: DelimiterCounts, after: DelimiterCounts): boolean {
  const okKind = (b: { opens: number; closes: number }, a: { opens: number; closes: number }) =>
    (a.opens === b.opens && a.closes === b.closes) || (a.opens <= b.opens && a.closes >= b.closes);
  return (
    okKind(before.braces, after.braces) &&
    okKind(before.brackets, after.brackets) &&
    okKind(before.parens, after.parens)
  );
}

type LexMode =
  | "code"
  | "single"
  | "double"
  | "template"
  | "template_expr"
  | "line_comment"
  | "block_comment"
  | "regex"
  | "jsx";

type LexicalResult = {
  issues: PatchCorrectnessIssue[];
  strippedForJsx: string;
};

type DelimiterScanResult =
  | { ok: true; strippedForJsx: string; lexicalScanIncomplete: boolean }
  | {
      ok: false;
      code: "unbalanced_delimiters";
      subtype:
        | "stack_not_empty"
        | "unexpected_closing_delimiter"
        | "unterminated_single_quote"
        | "unterminated_double_quote"
        | "unterminated_template"
        | "unterminated_block_comment";
      message: string;
      index: number;
      line: number;
      column: number;
      char?: string;
      expected?: string;
      actual?: string;
      stackTop?: string;
      snippet: string;
      strippedForJsx: string;
      lexicalScanIncomplete: boolean;
      events: Array<{
        index: number;
        line: number;
        column: number;
        char: string;
        action: "push" | "match" | "mode_enter" | "mode_exit" | "skip";
        mode: LexMode;
        stack: string[];
      }>;
    };

function getLineColumn(src: string, index: number): { line: number; column: number } {
  const i = Math.max(0, Math.min(index, src.length));
  const prefix = src.slice(0, i);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return { line, column };
}

function snippetAround(src: string, index: number, radius = 40): string {
  const i = Math.max(0, Math.min(index, src.length));
  const start = Math.max(0, i - radius);
  const end = Math.min(src.length, i + radius);
  return src.slice(start, end).replace(/\n/g, "\\n");
}

function formatDelimiterDiagnostic(input: {
  subtype:
    | "stack_not_empty"
    | "unexpected_closing_delimiter"
    | "unterminated_single_quote"
    | "unterminated_double_quote"
    | "unterminated_template"
    | "unterminated_block_comment";
  line: number;
  column: number;
  index: number;
  char?: string;
  expected?: string;
  actual?: string;
  stackTop?: string;
  snippet: string;
}): string {
  const parts: string[] = [];
  parts.push(
    `Unbalanced delimiters detected: ${input.subtype} at line ${input.line}, column ${input.column} (index ${input.index}).`
  );
  if (input.expected || input.actual) {
    parts.push(`Expected ${input.expected ?? "?"}, got ${input.actual ?? "?"}.`);
  }
  if (input.char) parts.push(`Char: ${JSON.stringify(input.char)}.`);
  if (input.stackTop) parts.push(`Stack top: ${JSON.stringify(input.stackTop)}.`);
  parts.push(`Snippet: ${input.snippet}`);
  return parts.join(" ");
}

function scanDelimitersWithDiagnostics(src: string): DelimiterScanResult {
  const s = src.replace(/\r\n/g, "\n");
  const stack: string[] = [];
  const strippedForJsxChars: string[] = [];
  const writeStripped = (c: string) => strippedForJsxChars.push(c);

  function findLastIndex(arr: string[], target: string): number {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (arr[i] === target) return i;
    }
    return -1;
  }

  function isJsxClosingTag(srcText: string, idx: number): boolean {
    if (srcText[idx] !== "/") return false;
    let j = idx - 1;
    while (j >= 0 && /\s/.test(srcText[j] ?? "")) j -= 1;
    if (j < 0 || srcText[j] !== "<") return false;
    const nextChar = srcText[idx + 1] ?? "";
    return /[a-zA-Z]/.test(nextChar);
  }

  function isInsideJsxTag(srcText: string, idx: number): boolean {
    // Simple heuristic: if the nearest angle bracket behind us is "<" (not ">"),
    // we are inside a JSX tag like <Tag ...> or </Tag ...>.
    for (let j = idx; j >= 0; j -= 1) {
      const c = srcText[j] ?? "";
      if (c === ">") return false;
      if (c === "<") return true;
    }
    return false;
  }

  let mode: LexMode = "code";
  let escaped = false;
  const templateExprDepthStack: number[] = [];
  let regexHeuristicFailed = false;
  // When we enter JS code temporarily from JSX (e.g. key={expr}),
  // track nested braces so we can return to JSX after the matching "}".
  let jsxExprDepth = 0;
  let jsxReturnMode: LexMode = "code";
  const events: Array<{
    index: number;
    line: number;
    column: number;
    char: string;
    action: "push" | "match" | "mode_enter" | "mode_exit" | "skip";
    mode: LexMode;
    stack: string[];
  }> = [];

  const pushEvent = (
    index: number,
    char: string,
    action: "push" | "match" | "mode_enter" | "mode_exit" | "skip"
  ) => {
    const { line, column } = getLineColumn(s, index);
    events.push({
      index,
      line,
      column,
      char,
      action,
      mode,
      stack: stack.slice(-12),
    });
    if (events.length > 200) {
      events.splice(0, events.length - 200);
    }
  };

  // Used for conservative regex start detection.
  let lastNonWsChar = "";
  let wordBuf = "";
  let lastWord = "";
  const updateToken = (ch: string) => {
    if (/[A-Za-z0-9_$]/.test(ch)) {
      wordBuf += ch;
      return;
    }
    if (wordBuf) {
      lastWord = wordBuf;
      wordBuf = "";
    }
  };

  const failResult = (input: {
    subtype:
      | "stack_not_empty"
      | "unexpected_closing_delimiter"
      | "unterminated_single_quote"
      | "unterminated_double_quote"
      | "unterminated_template"
      | "unterminated_block_comment";
    message: string;
    index: number;
    char?: string;
    expected?: string;
    actual?: string;
    stackTop?: string;
  }): DelimiterScanResult => {
    const { line, column } = getLineColumn(s, input.index);
    return {
      ok: false,
      code: "unbalanced_delimiters",
      subtype: input.subtype,
      message: input.message,
      index: input.index,
      line,
      column,
      char: input.char,
      expected: input.expected,
      actual: input.actual,
      stackTop: input.stackTop,
      snippet: snippetAround(s, input.index),
      strippedForJsx: strippedForJsxChars.join(""),
      lexicalScanIncomplete: false,
      events: events.slice(-25),
    };
  };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] ?? "";
    const next = s[i + 1] ?? "";

    if (mode === "jsx") {
      // In JSX tag scanning mode, ignore all delimiter tracking and all JS lexical modes.
      // Only recognize:
      // - `{` → enter code temporarily (JSX expression)
      // - `>` → exit JSX tag scanning back to code
      if (ch === "{") {
        // Enter code to parse the expression; return to JSX when the brace closes.
        jsxExprDepth = 1;
        jsxReturnMode = "jsx";
        stack.push("{");
        pushEvent(i, ch, "push");
        writeStripped(ch);
        mode = "code";
        continue;
      }
      if (ch === ">") {
        writeStripped(ch);
        mode = "code";
        continue;
      }
      writeStripped(ch);
      continue;
    }

    if (mode === "line_comment") {
      writeStripped(ch === "\n" ? "\n" : " ");
      if (ch === "\n") mode = "code";
      continue;
    }
    if (mode === "block_comment") {
      writeStripped(" ");
      if (ch === "*" && next === "/") {
        writeStripped(" ");
        mode = "code";
        i += 1;
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      writeStripped(" ");
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (mode === "single" && ch === "'") mode = "code";
      if (mode === "double" && ch === '"') mode = "code";
      continue;
    }

    if (mode === "regex") {
      writeStripped(" ");
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "[") {
        while (i < s.length) {
          const c = s[i] ?? "";
          writeStripped(" ");
          if (c === "\\" && !escaped) {
            escaped = true;
          } else if (escaped) {
            escaped = false;
          } else if (c === "]") {
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch === "/") {
        mode = "code";
        continue;
      }
      continue;
    }

    if (mode === "template") {
      writeStripped(" ");
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`") {
        pushEvent(i, ch, "mode_exit");
        mode = "code";
        continue;
      }
      if (ch === "$" && next === "{") {
        pushEvent(i, "${", "mode_enter");
        mode = "template_expr";
        templateExprDepthStack.push(0);
        writeStripped(" ");
        i += 1;
        continue;
      }
      continue;
    }

    const inTemplateExpr = mode === "template_expr";

    if (escaped) {
      escaped = false;
      writeStripped(" ");
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      writeStripped(" ");
      continue;
    }

    if (mode === "code" && ch === "/" && next === "/" && !isInsideJsxTag(s, i)) {
      mode = "line_comment";
      writeStripped(" ");
      writeStripped(" ");
      i += 1;
      continue;
    }
    if (mode === "code" && ch === "/" && next === "*" && !isInsideJsxTag(s, i)) {
      mode = "block_comment";
      writeStripped(" ");
      writeStripped(" ");
      i += 1;
      continue;
    }

    if (ch === "'") {
      pushEvent(i, ch, "mode_enter");
      mode = "single";
      writeStripped(" ");
      continue;
    }
    if (ch === '"') {
      pushEvent(i, ch, "mode_enter");
      mode = "double";
      writeStripped(" ");
      continue;
    }
    if (ch === "`") {
      pushEvent(i, ch, "mode_enter");
      mode = "template";
      writeStripped(" ");
      continue;
    }

    if (mode === "code" && ch === "<") {
      // Heuristic JSX entry: `<Tag` or `</Tag` in expression position.
      // Avoid common JS operators: `<=`, `<<`, `<1`, `a<b`, etc.
      const looksLikeJsxStart = /[a-zA-Z/]/.test(next);
      const allowedPrev =
        lastWord === "return" ||
        lastNonWsChar === "" ||
        lastNonWsChar === "\n" ||
        lastNonWsChar === "(" ||
        lastNonWsChar === "{" ||
        lastNonWsChar === "[" ||
        lastNonWsChar === "=" ||
        lastNonWsChar === "," ||
        lastNonWsChar === ":" ||
        lastNonWsChar === "?" ||
        // Arrow bodies: `() => <Tag />`
        lastNonWsChar === ">";
      const notOperator = next !== "=" && next !== "<";
      if (looksLikeJsxStart && allowedPrev && notOperator) {
        mode = "jsx";
        writeStripped(ch);
        continue;
      }
    }

    if (ch === "/") {
      // JSX safety rule: inside a JSX tag, "/" must never trigger mode changes.
      if (isInsideJsxTag(s, i)) {
        writeStripped(ch);
        continue;
      }
      // JSX closing tag: </tag> → do not treat "/" as comment/regex.
      if (isJsxClosingTag(s, i)) {
        // Keep scanning in code mode.
        writeStripped(ch);
        continue;
      }

      if (mode !== "code") {
        // Avoid entering regex mode from non-code contexts.
        writeStripped(ch);
        continue;
      }

      updateToken(ch);
      const canStartRegex =
        // Keep comment detection above; regex is best-effort only.
        lastNonWsChar !== "<" &&
        (lastWord === "return" ||
          lastNonWsChar === "=" ||
          lastNonWsChar === "(" ||
          lastNonWsChar === "[" ||
          lastNonWsChar === "{" ||
          lastNonWsChar === "," ||
          lastNonWsChar === ":" ||
          lastNonWsChar === "?" ||
          lastNonWsChar === "\n" ||
          lastNonWsChar === "" ||
          // Arrow bodies: `() => /re/`
          lastNonWsChar === ">");
      if (canStartRegex) {
        pushEvent(i, ch, "mode_enter");
        mode = "regex";
        writeStripped(" ");
        continue;
      }
    }

    if (ch === "(" || ch === "{" || ch === "[") {
      stack.push(ch);
      pushEvent(i, ch, "push");
      writeStripped(ch);
    } else if (ch === ")" || ch === "}" || ch === "]") {
      if (inTemplateExpr && ch === "}") {
        const depth =
          templateExprDepthStack[templateExprDepthStack.length - 1] ?? 0;
        if (depth === 0) {
          templateExprDepthStack.pop();
          mode = "template";
          writeStripped(" ");
          continue;
        }
        templateExprDepthStack[templateExprDepthStack.length - 1] = depth - 1;
      }

      const expectedOpening =
        ch === ")"
          ? "("
          : ch === "}"
            ? "{"
            : ch === "]"
              ? "["
              : "";
      const idx = expectedOpening ? findLastIndex(stack, expectedOpening) : -1;
      if (idx === -1) {
        const stackTop = stack.length > 0 ? stack[stack.length - 1] : undefined;
        const res = failResult({
          subtype: "unexpected_closing_delimiter",
          message: "Unexpected closing delimiter.",
          index: i,
          char: ch,
          expected: expectedOpening || undefined,
          actual: ch,
          stackTop,
        });
        return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
      }
      stack.splice(idx, 1);
      pushEvent(i, ch, "match");
      writeStripped(ch);

      if (jsxExprDepth > 0 && ch === "}") {
        jsxExprDepth -= 1;
        if (jsxExprDepth === 0) {
          mode = jsxReturnMode;
        }
      }
    } else {
      writeStripped(ch);
    }

    if (inTemplateExpr && ch === "{") {
      const depth =
        templateExprDepthStack[templateExprDepthStack.length - 1] ?? 0;
      templateExprDepthStack[templateExprDepthStack.length - 1] = depth + 1;
    }
    if (jsxExprDepth > 0 && ch === "{") {
      jsxExprDepth += 1;
    }

    if (!/\s/.test(ch)) {
      lastNonWsChar = ch;
    }
    updateToken(ch);
  }

  if (mode === "regex") {
    regexHeuristicFailed = true;
  }

  const eofIndex = Math.max(0, s.length - 1);

  if (templateExprDepthStack.length > 0) {
    const res = failResult({
      subtype: "unterminated_template",
      message: "Template literal expression did not close.",
      index: eofIndex,
      stackTop: stack[stack.length - 1],
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }

  if (mode === "single") {
    const res = failResult({
      subtype: "unterminated_single_quote",
      message: "Single-quoted string did not terminate.",
      index: eofIndex,
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }
  if (mode === "double") {
    const res = failResult({
      subtype: "unterminated_double_quote",
      message: "Double-quoted string did not terminate.",
      index: eofIndex,
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }
  if (mode === "template" || mode === "template_expr") {
    const res = failResult({
      subtype: "unterminated_template",
      message: "Template literal did not terminate.",
      index: eofIndex,
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }
  if (mode === "block_comment") {
    const res = failResult({
      subtype: "unterminated_block_comment",
      message: "Block comment did not terminate.",
      index: eofIndex,
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    const res = failResult({
      subtype: "stack_not_empty",
      message: "Delimiter stack is not empty at end of file.",
      index: eofIndex,
      stackTop: open,
    });
    return { ...res, lexicalScanIncomplete: regexHeuristicFailed };
  }

  return {
    ok: true,
    strippedForJsx: strippedForJsxChars.join(""),
    lexicalScanIncomplete: regexHeuristicFailed,
  };
}

function layer0DiffSanity(input: PatchCorrectnessInput): PatchCorrectnessIssue[] {
  const normalizedBefore = normalizeForSanityCompare(input.originalContent);
  const normalizedAfter = normalizeForSanityCompare(input.updatedContent);

  if (normalizedBefore === normalizedAfter) {
    return [
      issue({
        layer: 0,
        code: "no_op_patch",
        severity: "block",
        message: "Patch produces no meaningful change.",
      }),
    ];
  }

  if (
    input.originalContent.trim().length > 0 &&
    input.updatedContent.trim().length === 0
  ) {
    return [
      issue({
        layer: 0,
        code: "file_emptied",
        severity: "block",
        message: "Patch empties a non-empty file.",
      }),
    ];
  }

  if (
    input.isConstrained &&
    input.originalContent.length > 0 &&
    input.updatedContent.length > input.originalContent.length * 3
  ) {
    return [
      issue({
        layer: 0,
        code: "byte_explosion",
        severity: "block",
        message: "Patch tripled file size on a constrained task.",
      }),
    ];
  }

  return [];
}

function layer1LexicalIntegrity(input: PatchCorrectnessInput): LexicalResult {
  if (isSkippedLayer1File(input.filePath)) {
    const p = input.filePath.toLowerCase();
    if (p.endsWith(".css") || p.endsWith(".html") || p.endsWith(".json")) {
      return {
        issues: minimalBraceBracketBalance(1, input.updatedContent),
        strippedForJsx: input.updatedContent,
      };
    }
    return { issues: [], strippedForJsx: input.updatedContent };
  }

  const diffCounts = fastDiffCounts(input.originalContent, input.updatedContent);
  const range = estimateChangedLineRange(input.originalContent, input.updatedContent);
  const beforeCounts = analyzeDelimiterCounts(input.originalContent);
  const afterCounts = analyzeDelimiterCounts(input.updatedContent);
  const deltaCounts = computeDelimiterDelta(beforeCounts, afterCounts);
  const deltaBalanced =
    deltaCounts.braces.opens === deltaCounts.braces.closes &&
    deltaCounts.brackets.opens === deltaCounts.brackets.closes &&
    deltaCounts.parens.opens === deltaCounts.parens.closes;
  const additiveOnly = diffCounts.removedLines === 0;
  const localizedValidationMode =
    diffCounts.totalChangedLines <= 5 && additiveOnly && deltaBalanced;
  if (localizedValidationMode) {
    console.log(
      "[zone-validator-localized-mode]",
      JSON.stringify({ enabled: true, reason: "small_safe_patch" })
    );
  }

  const scanTarget = localizedValidationMode
    ? (() => {
        const lines = input.updatedContent.replace(/\\r\\n/g, "\\n").split("\\n");
        const start = Math.max(1, range.startLine - 5);
        const end = Math.min(lines.length, range.endLineAfter + 5);
        return lines.slice(start - 1, end).join("\\n");
      })()
    : input.updatedContent;

  const scan = scanDelimitersWithDiagnostics(scanTarget);
  if (!scan.ok) {
    const worsened = delimiterWorsened(beforeCounts, afterCounts);
    const unchangedOrImproved = delimiterUnchangedOrImproved(beforeCounts, afterCounts);
    const minimalPatch = diffCounts.totalChangedLines < 5;
    const decision = !worsened && (unchangedOrImproved || minimalPatch) ? "allow" : "block";
    console.log(
      "[zone-validator-delta]",
      JSON.stringify({
        filePath: input.filePath,
        before: beforeCounts,
        after: afterCounts,
        delta: deltaCounts,
        totalChangedLines: diffCounts.totalChangedLines,
        decision,
      })
    );
    if (decision === "allow") {
      // Do not block if the file was already broken and the patch does not worsen delimiter counts.
      return { issues: [], strippedForJsx: scan.strippedForJsx };
    }

    // Localized validation mode: never hard-block on delimiter/template artifacts that
    // are likely outside the changed region. Downgrade to warning instead.
    if (localizedValidationMode) {
      const issues: PatchCorrectnessIssue[] = [
        issue({
          layer: 1,
          code: "unbalanced_delimiters",
          severity: "warn",
          message: `Localized validation mode: delimiter scan failed (${scan.subtype}). This may be unrelated to the small additive edit.`,
          locationHint: { line: scan.line, snippet: scan.snippet },
        }),
      ];
      if (scan.lexicalScanIncomplete) {
        issues.push(
          issue({
            layer: 1,
            code: "lexical_scan_incomplete",
            severity: "warn",
            message:
              "Lexical scan could not confidently parse a regex literal; results may be incomplete.",
          })
        );
      }
      return { issues, strippedForJsx: input.updatedContent };
    }

    console.log(
      "[zone-delimiter-trace]",
      JSON.stringify({ filePath: input.filePath, events: scan.events })
    );
    const last = scan.events[scan.events.length - 1];
    if (last) {
      console.log("[zone-mode-debug]", {
        index: last.index,
        char: last.char,
        mode: last.mode,
        prevMode: scan.events.length >= 2 ? scan.events[scan.events.length - 2]?.mode : undefined,
        stack: last.stack,
      });
    }
    console.log(
      "[zone-delimiter-diagnostic]",
      JSON.stringify({
        filePath: input.filePath,
        subtype: scan.subtype,
        line: scan.line,
        column: scan.column,
        index: scan.index,
        char: scan.char,
        expected: scan.expected,
        actual: scan.actual,
        stackTop: scan.stackTop,
        snippet: scan.snippet,
      })
    );

    const issues: PatchCorrectnessIssue[] = [
      issue({
        layer: 1,
        code: "unbalanced_delimiters",
        severity: "block",
        message: formatDelimiterDiagnostic({
          subtype: scan.subtype,
          line: scan.line,
          column: scan.column,
          index: scan.index,
          char: scan.char,
          expected: scan.expected,
          actual: scan.actual,
          stackTop: scan.stackTop,
          snippet: scan.snippet,
        }),
      }),
    ];
    if (scan.lexicalScanIncomplete) {
      issues.push(
        issue({
          layer: 1,
          code: "lexical_scan_incomplete",
          severity: "warn",
          message:
            "Lexical scan could not confidently parse a regex literal; results may be incomplete.",
        })
      );
    }
    return { issues, strippedForJsx: scan.strippedForJsx };
  }

  const issues: PatchCorrectnessIssue[] = [];
  if (scan.lexicalScanIncomplete) {
    issues.push(
      issue({
        layer: 1,
        code: "lexical_scan_incomplete",
        severity: "warn",
        message:
          "Lexical scan could not confidently parse a regex literal; results may be incomplete.",
      })
    );
  }

  return { issues, strippedForJsx: scan.strippedForJsx };
}

const BROKEN_CALL_AT_EOL =
  /\b([a-zA-Z_$][\w$]*)\s*\(\s*(?:["'`][^"'`\n]*)?$/m;
const INLINE_KEYWORD_IN_CALL =
  /\b(?:[a-z_$][\w$]*)\s*\(\s*["'`][^"'`\n]*["'`]?\s+(if|return|for|while|switch)\b/;
const BROKEN_IMPORT_LINE = /^\s*import\s*\{[^}]*$/m;
const BROKEN_EXPORT_LINE = /^\s*export\s*\{[^}]*$/m;
const UNTERMINATED_JSX_OPEN = /<[A-Z][A-Za-z0-9_]*\b[^>]*\n/;

function layer2LanguageHeuristics(input: PatchCorrectnessInput): PatchCorrectnessIssue[] {
  if (!isJsLike(input.filePath)) return [];

  const issues: PatchCorrectnessIssue[] = [];
  const src = input.updatedContent.replace(/\r\n/g, "\n");

  const inlineKeyword = src.match(INLINE_KEYWORD_IN_CALL);
  if (inlineKeyword) {
    issues.push(
      issue({
        layer: 2,
        code: "inline_keyword_in_call",
        severity: "block",
        message: "Detected an inline keyword inside a function call argument.",
      })
    );
  }

  const brokenCall = src.match(BROKEN_CALL_AT_EOL);
  if (brokenCall) {
    const name = brokenCall[1] ?? "call";
    const reserved = new Set([
      "return",
      "if",
      "for",
      "while",
      "switch",
      "catch",
      "function",
    ]);
    if (reserved.has(name)) {
      // Common multi-line constructs like `return (` are valid and should not be
      // treated as a broken call.
    } else {
    const lineIndex = src.slice(0, brokenCall.index ?? 0).split("\n").length;
    const snippet = src.split("\n")[lineIndex - 1] ?? "";
    issues.push(
      issue({
        layer: 2,
        code:
          name === "setSuccess" || name === "setError" || name === "setFormError"
            ? "broken_setter_call"
            : "broken_call_at_eol",
        severity: "block",
        message: `Call appears truncated at end of line: ${name}(...)`,
        locationHint: { line: lineIndex, snippet: snippet.trim().slice(0, 160) },
      })
    );
    }
  }

  if (BROKEN_IMPORT_LINE.test(src)) {
    issues.push(
      issue({
        layer: 2,
        code: "broken_import_line",
        severity: "block",
        message: "Import line appears to have an unclosed brace.",
      })
    );
  }
  if (BROKEN_EXPORT_LINE.test(src)) {
    issues.push(
      issue({
        layer: 2,
        code: "broken_export_line",
        severity: "block",
        message: "Export line appears to have an unclosed brace.",
      })
    );
  }

  // Dangling arrow at end of line heuristic (warn)
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i]?.trim() ?? "";
    if (!cur) continue;
    if (!cur.endsWith("=>")) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j]?.trim() ?? "") === "") j += 1;
    const next = lines[j]?.trim() ?? "";
    if (next.startsWith("}") || next.includes("=>")) {
      issues.push(
        issue({
          layer: 2,
          code: "dangling_arrow_eol",
          severity: "warn",
          message: "Arrow function appears to be dangling at end of line.",
          locationHint: { line: i + 1, snippet: cur.slice(0, 160) },
        })
      );
      break;
    }
  }

  // Unterminated JSX open tag heuristic (warn)
  if (UNTERMINATED_JSX_OPEN.test(src)) {
    issues.push(
      issue({
        layer: 2,
        code: "unterminated_jsx_open",
        severity: "warn",
        message: "Possible unterminated JSX opening tag.",
      })
    );
  }

  return issues;
}

function jsxTagBalanceWarn(
  stripped: string,
  diffAddedLines: number
): PatchCorrectnessIssue[] {
  if (diffAddedLines <= 0) return [];
  const s = stripped.replace(/\r\n/g, "\n");

  let fragmentsOpen = 0;
  let fragmentsClose = 0;
  let openCount = 0;
  let closeCount = 0;

  // fragments
  for (const _m of s.matchAll(/<>/g)) fragmentsOpen += 1;
  for (const _m of s.matchAll(/<\/>/g)) fragmentsClose += 1;

  // Self closing tags
  const selfClosing = new Set<number>();
  for (const m of s.matchAll(/<([A-Za-z][\w:-]*)\b[^>]*\/>/g)) {
    if (m.index != null) selfClosing.add(m.index);
  }

  for (const m of s.matchAll(/<\/([A-Za-z][\w:-]*)\s*>/g)) {
    closeCount += 1;
  }

  for (const m of s.matchAll(/<([A-Za-z][\w:-]*)\b[^>]*?>/g)) {
    if (m.index != null && selfClosing.has(m.index)) continue;
    // exclude closing tags
    if ((m[0] ?? "").startsWith("</")) continue;
    openCount += 1;
  }

  const imbalance =
    openCount - closeCount + (fragmentsOpen - fragmentsClose);
  if (imbalance !== 0) {
    return [
      issue({
        layer: 2,
        code: "jsx_tag_imbalance",
        severity: "warn",
        message: "JSX tag counts appear imbalanced after changes.",
      }),
    ];
  }
  return [];
}

function collectExportedSymbols(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+default\s+function\s+(\w+)/g))
    names.add(m[1]);
  for (const m of src.matchAll(/export\s+function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+class\s+(\w+)/g)) names.add(m[1]);
  return names;
}

function layer3StructuralPreservation(
  input: PatchCorrectnessInput
): PatchCorrectnessIssue[] {
  const before = collectExportedSymbols(input.originalContent);
  const after = collectExportedSymbols(input.updatedContent);
  const issues: PatchCorrectnessIssue[] = [];

  for (const sym of before) {
    if (after.has(sym)) continue;
    issues.push(
      issue({
        layer: 3,
        code: "dropped_export",
        severity: input.isConstrained ? "block" : "warn",
        message: `Exported symbol removed: ${sym}`,
      })
    );
  }
  return issues;
}

function countMatches(haystack: string, pattern: RegExp): number {
  let count = 0;
  for (const _m of haystack.matchAll(pattern)) count += 1;
  return count;
}

function containsSubmitHandlerSymbol(src: string): boolean {
  return /\b(handleSubmit|onSubmit)\b/.test(src);
}

function layer4TaskScopePreservation(
  input: PatchCorrectnessInput
): PatchCorrectnessIssue[] {
  const t = input.taskConstraints;
  const shouldRun =
    input.isConstrained ||
    t.requiresExistingForm ||
    t.requiresExistingSubmitFlow ||
    t.requiresExistingState ||
    t.avoidsNewForm ||
    t.avoidsNewApiCall;

  if (!shouldRun) return [];

  const issues: PatchCorrectnessIssue[] = [];
  const diffCounts = fastDiffCounts(input.originalContent, input.updatedContent);
  if (diffCounts.totalChangedLines > 20 || diffCounts.removedLines > 5) {
    issues.push(
      issue({
        layer: 4,
        code: "constrained_patch_too_large",
        severity: "block",
        message: "Patch is too large for a constrained minimal task.",
      })
    );
  }

  if (t.requiresExistingSubmitFlow) {
    const beforeHas = containsSubmitHandlerSymbol(input.originalContent);
    const afterHas = containsSubmitHandlerSymbol(input.updatedContent);
    if (beforeHas && !afterHas) {
      issues.push(
        issue({
          layer: 4,
          code: "dropped_submit_handler",
          severity: "block",
          message: "Patch removed the existing submit handler reference.",
        })
      );
    }
  }

  if (t.requiresExistingForm) {
    const beforeHas = input.originalContent.includes("<form");
    const afterHas = input.updatedContent.includes("<form");
    if (beforeHas && !afterHas) {
      issues.push(
        issue({
          layer: 4,
          code: "dropped_form",
          severity: "block",
          message: "Patch removed the existing <form> element.",
        })
      );
    }
  }

  if (t.avoidsNewApiCall) {
    const beforeApi =
      countMatches(input.originalContent, /\bfetch\s*\(/g) +
      countMatches(input.originalContent, /\baxios\./g) +
      countMatches(
        input.originalContent,
        /\bapi\.(get|post|put|patch|delete)\b/g
      );
    const afterApi =
      countMatches(input.updatedContent, /\bfetch\s*\(/g) +
      countMatches(input.updatedContent, /\baxios\./g) +
      countMatches(
        input.updatedContent,
        /\bapi\.(get|post|put|patch|delete)\b/g
      );
    if (beforeApi === 0 && afterApi > 0) {
      issues.push(
        issue({
          layer: 4,
          code: "introduced_forbidden_api_call",
          severity: "block",
          message: "Patch introduced a new API call, which is forbidden by task constraints.",
        })
      );
    }
  }

  return issues;
}

export function validatePatchCorrectness(
  input: PatchCorrectnessInput
): PatchCorrectnessReport {
  const blocking: PatchCorrectnessIssue[] = [];
  const warnings: PatchCorrectnessIssue[] = [];
  let layersRun = 0;
  let shortCircuitedAt: number | null = null;
  let minimalSafeOverrideApplied = false;

  const runLayer = (layer: 0 | 1 | 2 | 3 | 4, fn: () => PatchCorrectnessIssue[]) => {
    if (shortCircuitedAt != null) return;
    layersRun += 1;
    const issues = fn();
    const blocks = issues.filter((i) => i.severity === "block");
    const warns = issues.filter((i) => i.severity === "warn");
    blocking.push(...blocks);
    warnings.push(...warns);
    if (blocks.length > 0) shortCircuitedAt = layer;
  };

  runLayer(0, () => layer0DiffSanity(input));

  let strippedForJsx = input.updatedContent;
  runLayer(1, () => {
    const res = layer1LexicalIntegrity(input);
    strippedForJsx = res.strippedForJsx;
    return res.issues;
  });

  runLayer(2, () => layer2LanguageHeuristics(input));
  // JSX imbalance (warn) is considered part of layer 2.
  if (shortCircuitedAt == null && isJsLike(input.filePath)) {
    const diffCounts = fastDiffCounts(input.originalContent, input.updatedContent);
    // Only run JSX balance when the patch appears to add JSX-ish text.
    const beforeLt = countMatches(input.originalContent, /</g);
    const afterLt = countMatches(input.updatedContent, /</g);
    if (afterLt > beforeLt) {
      const jsxWarns = jsxTagBalanceWarn(strippedForJsx, diffCounts.addedLines);
      warnings.push(...jsxWarns.filter((w) => w.severity === "warn"));
    }
  }

  runLayer(3, () => layer3StructuralPreservation(input));
  runLayer(4, () => layer4TaskScopePreservation(input));

  // ── Minimal safe patch override ─────────────────────────────────────────
  // If a patch is very small and does not worsen delimiter counts, allow it even if
  // heuristics like broken_import_line fire on an already-broken file outside the import region.
  const diffCountsFinal = fastDiffCounts(input.originalContent, input.updatedContent);
  const beforeCountsFinal = analyzeDelimiterCounts(input.originalContent);
  const afterCountsFinal = analyzeDelimiterCounts(input.updatedContent);
  const noDelimiterRegression = !delimiterWorsened(beforeCountsFinal, afterCountsFinal);
  const touchesImport = touchesImportRegion({
    originalContent: input.originalContent,
    updatedContent: input.updatedContent,
  });

  const blockingCodes = blocking.map((b) => b.code);
  const hasBrokenImport = blocking.some((b) => b.code === "broken_import_line");
  if (hasBrokenImport && !touchesImport) {
    const ignored = blocking.filter((b) => b.code === "broken_import_line");
    // Drop broken_import_line if the diff doesn't intersect the import block.
    for (let i = blocking.length - 1; i >= 0; i -= 1) {
      if (blocking[i]?.code === "broken_import_line") blocking.splice(i, 1);
    }
    warnings.push(
      ...ignored.map((i) => ({
        ...i,
        severity: "warn" as const,
        message: i.message + " (ignored: patch did not touch import region)",
      }))
    );
    console.log(
      "[zone-validator-override]",
      JSON.stringify({
        reason: "minimal_safe_patch",
        ignoredBlockingCodes: ["broken_import_line"],
      })
    );
    minimalSafeOverrideApplied = true;
  }

  if (
    input.strictMode &&
    !minimalSafeOverrideApplied &&
    blocking.length === 0 &&
    warnings.length > 0
  ) {
    const promoted = warnings.map((w) => ({ ...w, severity: "block" as const }));
    blocking.push(...promoted);
    warnings.length = 0;
    if (shortCircuitedAt == null) {
      shortCircuitedAt = 4;
    }
  }

  const forceBlocked = blocking.length > 0;
  const forcePreviewOnly = !forceBlocked && warnings.length > 0;

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    forceBlocked,
    forcePreviewOnly,
    layersRun,
    shortCircuitedAt,
  };
}

