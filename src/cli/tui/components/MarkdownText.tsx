import React from "react";
import { Box, Text } from "ink";
import { role, glyph } from "../theme.js";

/**
 * Tokenize a line for inline **bold**, `code`, and [text](url) markers.
 * Returns an array of <Text> elements.
 */
function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, `code`, and [text](url) in one pass
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = baseKey;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={key++}>{text.slice(lastIndex, match.index)}</Text>);
    }
    const m = match[0];
    if (m.startsWith("**")) {
      parts.push(<Text key={key++} bold>{m.slice(2, -2)}</Text>);
    } else if (m.startsWith("`")) {
      parts.push(<Text key={key++} color={role.accent}>{m.slice(1, -1)}</Text>);
    } else if (m.startsWith("[")) {
      // [text](url) → text + muted url
      const linkMatch = m.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(<Text key={key++}>{linkMatch[1]}</Text>);
        parts.push(<Text key={key++}> </Text>);
        parts.push(<Text key={key++} color={role.muted}>{linkMatch[2]}</Text>);
      }
    }
    lastIndex = match.index + m.length;
  }
  if (lastIndex < text.length) {
    parts.push(<Text key={key++}>{text.slice(lastIndex)}</Text>);
  }
  return parts;
}

interface MarkdownTextProps {
  text: string;
}

/**
 * Mini markdown-to-Ink renderer for the FINAL SUMMARY format.
 * Supported syntax:
 *   ## / ### headings  → bold text (no leading #)
 *   - / * bullets      → bullet-glyph prefix
 *   1. numbered lists  → numbered prefix with continuation indent
 *   ``` fenced code    → dim left bar, indented content
 *   **bold**           → bold inline
 *   `code`             → accent inline
 *   [text](url)        → text + muted url
 *   blank lines        → spacer row
 *   prose              → plain text with inline parsing
 */
export function MarkdownText({ text }: MarkdownTextProps): React.ReactElement {
  const lines = text.split("\n");
  let inlineKeyBase = 0;
  let inFence = false;

  const rendered: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code block open/close
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue; // Don't render the fence line itself
    }

    // Inside a fence: render with dim left bar and indent
    if (inFence) {
      rendered.push(
        <Box key={`fence-${i}`}>
          <Text color={role.muted}>{glyph.separator}</Text>
          <Text>{"  "}</Text>
          <Text>{line}</Text>
        </Box>
      );
      continue;
    }

    // ## / ### heading
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      rendered.push(
        <Box key={i} marginTop={i > 0 ? 1 : 0}>
          <Text bold>{headingMatch[1]}</Text>
        </Box>
      );
      continue;
    }

    // - / * bullet item
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      const nodes = renderInline(bulletMatch[1], inlineKeyBase);
      inlineKeyBase += 20;
      rendered.push(
        <Box key={i}>
          <Text color={role.accent}>{glyph.bullet}</Text>
          <Text>{nodes}</Text>
        </Box>
      );
      continue;
    }

    // 1. numbered list item
    const numberedMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (numberedMatch) {
      const num = numberedMatch[1]!;
      const content = numberedMatch[2]!;
      const nodes = renderInline(content, inlineKeyBase);
      inlineKeyBase += 20;
      const prefix = `${num}.`;
      // Indent continuation to align under text column (prefix width + 1 space)
      const indentWidth = prefix.length + 1;
      rendered.push(
        <Box key={i}>
          <Text>{prefix} </Text>
          <Box flexGrow={1}>
            <Text>{nodes}</Text>
          </Box>
        </Box>
      );
      void indentWidth; // reserved for continuation line alignment (future)
      continue;
    }

    // blank line → spacer
    if (line.trim() === "") {
      rendered.push(<Box key={i} />);
      continue;
    }

    // prose — apply inline parsing
    const nodes = renderInline(line, inlineKeyBase);
    inlineKeyBase += 20;
    rendered.push(
      <Box key={i}>
        <Text>{nodes}</Text>
      </Box>
    );
  }

  // Implicit fence close at EOF (unclosed fence)
  // No extra rendering needed — the fence state just ends.

  return (
    <Box flexDirection="column">
      {rendered}
    </Box>
  );
}
