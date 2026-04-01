export interface CodeBlock {
  filePath: string;
  label: string;
  content: string;
  score: number;
}

interface SelectBlocksInput {
  filePath: string;
  content: string;
  keywords: string[];
  maxBlocks?: number;
}

function scoreText(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((sum, keyword) => {
    if (!keyword) return sum;
    return sum + (lower.includes(keyword.toLowerCase()) ? 1 : 0);
  }, 0);
}

function splitByFunctions(content: string): string[] {
  return content
    .split(/\n(?=(export\s+async\s+function|export\s+function|async\s+function|function\s+|const\s+\w+\s*=\s*async))/g)
    .filter(Boolean);
}

function extractRouteBlocks(content: string): string[] {
  const lines = content.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/router\.(get|post|put|patch|delete)\(/.test(lines[i])) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 6);
      result.push(lines.slice(start, end).join("\n"));
    }
  }

  return result;
}

export function selectRelevantBlocks(input: SelectBlocksInput): CodeBlock[] {
  const { filePath, content, keywords, maxBlocks = 4 } = input;

  const blocks: CodeBlock[] = [];

  const functionBlocks = splitByFunctions(content);
  for (const block of functionBlocks) {
    const score = scoreText(block, keywords);
    if (score > 0) {
      blocks.push({
        filePath,
        label: "function",
        content: block.trim(),
        score
      });
    }
  }

  const routeBlocks = extractRouteBlocks(content);
  for (const block of routeBlocks) {
    const score = scoreText(block, keywords) + 1;
    if (score > 0) {
      blocks.push({
        filePath,
        label: "route",
        content: block.trim(),
        score
      });
    }
  }

  return blocks.sort((a, b) => b.score - a.score).slice(0, maxBlocks);
}