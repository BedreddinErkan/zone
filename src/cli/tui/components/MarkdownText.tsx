import React from "react";
import { Box, Text } from "ink";
import { role, glyph } from "../theme.js";

/**
 * Tokenize a line for inline **bold** and `code` markers.
 * Returns an array of <Text> elements (plain, bold, or colored).
 */
function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
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
    } else {
      // backtick code — accent to distinguish from prose
      parts.push(<Text key={key++} color={role.accent}>{m.slice(1, -1)}</Text>);
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
 *   **bold**           → bold inline
 *   `code`             → cyan inline
 *   blank lines        → spacer row
 *   prose              → plain text with inline parsing
 */
export function MarkdownText({ text }: MarkdownTextProps): React.ReactElement {
  const lines = text.split("\n");
  let inlineKeyBase = 0;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // ## / ### heading
        const headingMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headingMatch) {
          return (
            <Box key={i} marginTop={i > 0 ? 1 : 0}>
              <Text bold>{headingMatch[1]}</Text>
            </Box>
          );
        }

        // - / * bullet item
        const bulletMatch = line.match(/^[-*]\s+(.+)/);
        if (bulletMatch) {
          const nodes = renderInline(bulletMatch[1], inlineKeyBase);
          inlineKeyBase += 20;
          return (
            <Box key={i}>
              <Text color={role.accent}>{glyph.bullet}</Text>
              <Text>{nodes}</Text>
            </Box>
          );
        }

        // blank line → spacer
        if (line.trim() === "") {
          return <Box key={i} />;
        }

        // prose — apply inline parsing
        const nodes = renderInline(line, inlineKeyBase);
        inlineKeyBase += 20;
        return (
          <Box key={i}>
            <Text>{nodes}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
