function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyLinks(text: string): string {
  return text.replace(
    /(https?:\/\/[^\s<]+)/gi,
    (url) =>
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        url
      )}</a>`
  );
}

function renderInlineMarkdown(text: string): string {
  const codeTokens: string[] = [];
  let next = String(text || "").replace(/`([^`]+)`/g, (_match, code) => {
    const token = `__ZONE_INLINE_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
    return token;
  });

  next = escapeHtml(next);
  next = applyLinks(next);
  next = next.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  next = next.replace(/\*(.+?)\*/g, "<em>$1</em>");

  for (let i = 0; i < codeTokens.length; i += 1) {
    next = next.replace(`__ZONE_INLINE_CODE_${i}__`, codeTokens[i]);
  }

  return next;
}

function extractCodeBlocks(text: string): {
  text: string;
  codeBlocks: Array<{ lang: string; code: string }>;
} {
  const codeBlocks: Array<{ lang: string; code: string }> = [];
  const next = String(text || "").replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({
        lang: String(lang || "").trim(),
        code: String(code || ""),
      });
      return `\u0000CODEBLOCK${idx}\u0000`;
    }
  );

  return { text: next, codeBlocks };
}

function restoreCodeBlocks(text: string, codeBlocks: Array<{ lang: string; code: string }>): string {
  return String(text || "").replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_match, idxText) => {
    const idx = Number.parseInt(idxText, 10);
    const block = codeBlocks[idx];
    if (!block) return "";
    const langAttr = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : "";
    const classAttr = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
    return `<pre class="chat-codeblock"${langAttr}><code${classAttr}>${escapeHtml(
      block.code
    )}</code></pre>`;
  });
}

function stripTrailingVerificationTag(text: string): string {
  return String(text || "").replace(/\s*\[ZONE_VERIFICATION:\s*[a-z_]+\]\s*$/i, "").trim();
}

export function renderChatMarkdownToHtml(markdown: string, isFinal = true): string {
  const normalized = stripTrailingVerificationTag(String(markdown || "").replace(/\r\n/g, "\n")).trim();
  if (!normalized) {
    return '<div class="md"><p></p></div>';
  }

  // Detect unclosed trailing code fence (odd number of ``` tokens).
  let mainText = normalized;
  let trailingCodeHtml = "";
  const fenceParts = normalized.split("```");
  if (fenceParts.length % 2 === 0) {
    const lastFenceIdx = normalized.lastIndexOf("```");
    mainText = normalized.slice(0, lastFenceIdx).trim();
    const tailRaw = normalized.slice(lastFenceIdx);
    const fenceBodyMatch = tailRaw.match(/^```(\w+)?\n?([\s\S]*)$/);
    const tailLang = fenceBodyMatch ? String(fenceBodyMatch[1] || "").trim() : "";
    const tailCode = fenceBodyMatch
      ? String(fenceBodyMatch[2] || "")
      : tailRaw.replace(/^```\w*\n?/, "");
    const dataLang = tailLang ? ` data-lang="${escapeHtml(tailLang)}"` : "";
    const codeClass = tailLang ? ` class="language-${escapeHtml(tailLang)}"` : "";
    if (!isFinal) {
      trailingCodeHtml = `<pre class="chat-codeblock streaming"${dataLang}><code${codeClass}>${escapeHtml(tailCode)}<span class="streaming-cursor">&#x25AE;</span></code></pre>`;
    } else {
      trailingCodeHtml = `<pre class="chat-codeblock"${dataLang}><code${codeClass}>${escapeHtml(tailCode)}</code></pre>`;
    }
  }

  const extracted = extractCodeBlocks(mainText);
  const lines = extracted.text.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = String(lines[i] || "");
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
      blocks.push(line.trim());
      i += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(String(lines[i] || ""))) {
        items.push(
          `<li>${renderInlineMarkdown(
            String(lines[i] || "").replace(/^\s*-\s+/, "")
          )}</li>`
        );
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*#{1,6}\s+/.test(line)) {
      blocks.push(
        `<h3>${renderInlineMarkdown(String(line).replace(/^\s*#{1,6}\s+/, ""))}</h3>`
      );
      i += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const current = String(lines[i] || "");
      if (
        !current.trim() ||
        /^\u0000CODEBLOCK\d+\u0000$/.test(current.trim()) ||
        /^\s*-\s+/.test(current) ||
        /^\s*#{1,6}\s+/.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      i += 1;
    }

    blocks.push(
      `<p>${paragraphLines.map((part) => renderInlineMarkdown(part)).join("<br>")}</p>`
    );
  }

  return `<div class="md">${restoreCodeBlocks(blocks.join(""), extracted.codeBlocks)}${trailingCodeHtml}</div>`;
}
