// Basic structural check for /llms.txt as proposed at https://llmstxt.org:
// an H1 with the site/project name, an optional "> summary" blockquote, and
// H2 sections containing Markdown link lists such as "- [Docs](https://...): notes".

/**
 * @param {string} text
 * @returns {{ looksLikeHtml: boolean, title: string | null, h1First: boolean, summary: string | null,
 *             sections: string[], links: { text: string, url: string }[] }}
 */
export function parseLlmsTxt(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const looksLikeHtml = /^\s*<(!doctype|html|head|body)\b/i.test(src);
  const lines = src.split(/\r\n|\r|\n/);
  const firstContent = lines.find((l) => l.trim() !== '');
  const h1Line = lines.find((l) => /^#\s+\S/.test(l));
  const title = h1Line ? h1Line.replace(/^#\s+/, '').trim() : null;
  const h1First = !!firstContent && /^#\s+\S/.test(firstContent);
  const quote = lines.find((l) => /^>\s*\S/.test(l));
  const summary = quote ? quote.replace(/^>\s*/, '').trim() : null;
  const sections = lines.filter((l) => /^##\s+\S/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
  const links = [...src.matchAll(/\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)].map((m) => ({ text: m[1], url: m[2] }));
  return { looksLikeHtml, title, h1First, summary, sections, links };
}
