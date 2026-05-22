export type FormatId = 'brief' | 'detailed' | 'pr' | 'slack' | 'prompt';

export interface StructuredSummary {
  what: string;
  why: string;
  tests: string;
  notes: string;
  isStructured: boolean;
  raw: string;
}

export interface RunSummaryContext {
  terminationReason: string;
  category: 'success' | 'warning' | 'error' | 'neutral';
  filesChanged: { path: string; added: number; removed: number }[];
  costUsd: number | null;
  cacheHitPct: number | null;
  userFacingMessage: string;
}

const SECTION_NAMES = ['what changed', 'why', 'tests', 'notes'] as const;

export function parseAgentSummary(rawDetail: string): StructuredSummary {
  const raw = String(rawDetail || '');
  const cleaned = raw.replace(/\[ZONE_VERIFICATION:[^\]]*\]/g, '').trim();

  const sectionContent: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const line of cleaned.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/i);
    if (m) {
      const name = m[1].toLowerCase().trim();
      if ((SECTION_NAMES as readonly string[]).includes(name)) {
        currentKey = name;
        sectionContent[currentKey] = [];
        continue;
      }
    }
    if (currentKey !== null) {
      sectionContent[currentKey].push(line);
    }
  }

  const isStructured = Object.keys(sectionContent).length >= 2;

  if (!isStructured) {
    return { what: cleaned, why: '', tests: '', notes: '', isStructured: false, raw };
  }

  return {
    what: (sectionContent['what changed'] ?? []).join('\n').trim(),
    why: (sectionContent['why'] ?? []).join('\n').trim(),
    tests: (sectionContent['tests'] ?? []).join('\n').trim(),
    notes: (sectionContent['notes'] ?? []).join('\n').trim(),
    isStructured: true,
    raw,
  };
}

function categoryEmoji(category: string): string {
  if (category === 'success') return '✅';
  if (category === 'warning') return '⚠️';
  if (category === 'error') return '🔴';
  return 'ℹ️';
}

function metricsFooter(ctx: RunSummaryContext): string {
  const n = ctx.filesChanged.length;
  const parts: string[] = [n === 1 ? '1 file' : `${n} files`];
  if (ctx.costUsd != null) parts.push(`$${ctx.costUsd.toFixed(2)}`);
  if (ctx.cacheHitPct != null) parts.push(`${Math.round(ctx.cacheHitPct)}% cached`);
  return parts.join(' · ');
}

export function formatBrief(s: StructuredSummary, ctx: RunSummaryContext): string {
  const emoji = categoryEmoji(ctx.category);
  const metrics = metricsFooter(ctx);

  if (!s.isStructured) {
    const plain = s.raw.replace(/```[\s\S]*?```/g, '').replace(/\n+/g, ' ').trim();
    const snippet = plain.length > 220 ? plain.slice(0, 217) + '…' : plain;
    return `${emoji} ${snippet} · ${metrics}`;
  }

  const firstLine = s.what.split('\n')[0].replace(/^-\s+/, '').trim();
  const truncated = firstLine.length > 100 ? firstLine.slice(0, 97) + '…' : firstLine;
  return `${emoji} ${truncated} · ${metrics}`;
}

export function formatDetailed(s: StructuredSummary, ctx: RunSummaryContext): string {
  const footer = `*${metricsFooter(ctx)} · ${ctx.category}*`;

  if (!s.isStructured) {
    return `${s.raw}\n\n---\n${footer}`;
  }

  const lines: string[] = [
    '## What changed',
    s.what || '(none)',
    '',
    '## Why',
    s.why || '(not specified)',
    '',
    '## Tests',
    s.tests || 'not_run',
  ];

  if (s.notes) {
    lines.push('', '## Notes', s.notes);
  }

  lines.push('', '---', footer);
  return lines.join('\n');
}

export function formatPR(s: StructuredSummary, ctx: RunSummaryContext): string {
  const MAX_INLINE = 3;
  const { filesChanged } = ctx;
  const fileLines = filesChanged.map(f => `- \`${f.path}\` (+${f.added}/-${f.removed})`);

  let changesBlock: string;
  if (fileLines.length === 0) {
    changesBlock = '_None._';
  } else if (fileLines.length <= MAX_INLINE) {
    changesBlock = fileLines.join('\n');
  } else {
    const head = fileLines.slice(0, MAX_INLINE).join('\n');
    const rest = fileLines.slice(MAX_INLINE).join('\n');
    changesBlock = `${head}\n<details><summary>${fileLines.length - MAX_INLINE} more files</summary>\n\n${rest}\n</details>`;
  }

  const summary = s.isStructured ? (s.why || s.what) : s.raw;
  const tests = s.isStructured ? s.tests : '';
  const notes = s.isStructured ? s.notes : '';

  const testPassed = /tests_passed|passed/i.test(tests);
  const testCheckbox = tests
    ? `- [${testPassed ? 'x' : ' '}] ${tests}`
    : '- [ ] Run tests and verify';

  const statusPrefix = ctx.category === 'success' ? '✅' : ctx.category === 'warning' ? '⚠' : '✗';

  const lines: string[] = [
    '## Summary',
    '',
    summary,
    '',
    '## Changes',
    '',
    changesBlock,
    '',
    '## Test plan',
    '',
    testCheckbox,
  ];

  if (notes) {
    lines.push('', '## Notes', '', notes);
  }

  lines.push('', `${statusPrefix} ${ctx.userFacingMessage}`);
  return lines.join('\n');
}

export function formatSlack(s: StructuredSummary, ctx: RunSummaryContext): string {
  const emoji = categoryEmoji(ctx.category);
  const metrics = metricsFooter(ctx);
  const header = `${emoji} *${ctx.userFacingMessage}* — ${metrics}`;

  if (!s.isStructured) {
    const plain = s.raw
      .replace(/^#{1,3}\s+(.+)$/gm, '*$1*')
      .replace(/```[\s\S]*?```/g, '`<code block>`');
    return `${header}\n\n${plain.trim()}`;
  }

  const lines: string[] = [header, ''];

  const bullets = s.what
    .split('\n')
    .map(l => l.replace(/^-\s+/, '').trim())
    .filter(Boolean)
    .map(l => `• ${l}`);

  if (bullets.length > 0) {
    lines.push(...bullets, '');
  }

  if (s.tests) {
    lines.push(`*Tests:* ${s.tests}`);
  }

  if (s.notes) {
    lines.push('', `_Note: ${s.notes}_`);
  }

  return lines.join('\n');
}

export function formatPrompt(s: StructuredSummary, ctx: RunSummaryContext): string {
  if (ctx.category === 'error' && ctx.filesChanged.length === 0) {
    const lines: string[] = [
      'A run was halted before any code change.',
      '',
      `**Status:** ${ctx.userFacingMessage}`,
    ];
    if (s.isStructured && s.notes) lines.push('', `**Notes:** ${s.notes}`);
    lines.push('', '## What I need from you', '[INSERT FOLLOWUP TASK HERE]');
    return lines.join('\n');
  }

  const lines: string[] = [
    `I just ran a coding agent and it ended with status: **${ctx.category}** (${ctx.terminationReason}).`,
    '',
    '## What was done',
    s.isStructured ? s.what : s.raw,
    '',
  ];

  if (s.isStructured && s.why) {
    lines.push('## Why', s.why, '');
  }

  if (ctx.filesChanged.length > 0) {
    lines.push('## Files changed');
    for (const f of ctx.filesChanged) {
      lines.push(`- \`${f.path}\` (+${f.added}/-${f.removed})`);
    }
    lines.push('');
  }

  lines.push('## Tests', s.isStructured ? (s.tests || 'not_run') : 'not_run', '');

  const notes = s.isStructured ? s.notes : '';
  lines.push('## Notes / Open items', notes || '(none)', '');

  if (ctx.category === 'warning' || ctx.category === 'error') {
    lines.push('> Do not re-do the work above. Start from the current repo state.', '');
  }

  lines.push('## What I need from you', '[INSERT FOLLOWUP TASK HERE]');
  return lines.join('\n');
}

export function defaultFormatFor(
  category: RunSummaryContext['category'],
  terminationReason: string,
): FormatId {
  switch (terminationReason) {
    case 'natural_completion': return 'detailed';
    case 'max_iterations':
    case 'token_budget_exceeded':
    case 'compaction_exhausted': return 'prompt';
    case 'APPLY_ROLLED_BACK': return 'detailed';
    case 'upstream_unavailable':
    case 'loop_detected':
    case 'daily_usd_cap_exceeded':
    case 'revision_approval_timeout':
    case 'revision_rejected': return 'brief';
    default: return category === 'success' ? 'detailed' : 'brief';
  }
}
