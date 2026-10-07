// Small, regex-based HTML helpers. They only need to read the <head> metadata and
// JSON-LD blocks that crawlers read, not to build a DOM.

/** Parse the attributes of a single start tag such as `<meta name="x" content='y'>`. */
export function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const inner = tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?>$/, '');
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    const c = code.toLowerCase();
    if (c.startsWith('#x')) return safeFromCodePoint(parseInt(c.slice(2), 16), all);
    if (c.startsWith('#')) return safeFromCodePoint(parseInt(c.slice(1), 10), all);
    return named[c] ?? all;
  });
}

function safeFromCodePoint(n, fallback) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => parseAttributes(m[0]));
}

/**
 * Extract what the readiness checks need from a page.
 * @param {string} rawHtml
 * @param {string} baseUrl used to resolve the canonical href
 */
export function extractPageInfo(rawHtml, baseUrl) {
  const html = stripComments(String(rawHtml ?? ''));
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;

  const metas = tags(html, 'meta');
  const descTag = metas.find((a) => (a.name ?? '').toLowerCase() === 'description');
  const description = descTag ? descTag.content.replace(/\s+/g, ' ').trim() : null;

  // robots-style meta tags: name="robots" or a crawler-specific name="googlebot", "gptbot", ...
  const robotsMeta = metas
    .filter((a) => a.name && /^(robots|[a-z-]*bot|google-extended)$/i.test(a.name.trim()))
    .map((a) => ({ name: a.name.trim().toLowerCase(), content: (a.content ?? '').trim() }));

  let canonical = null;
  const canonTag = tags(html, 'link').find((a) => (a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  if (canonTag && canonTag.href) {
    try {
      canonical = new URL(canonTag.href, baseUrl).href;
    } catch {
      canonical = canonTag.href;
    }
  }

  const lang = tags(html, 'html')[0]?.lang ?? null;

  return {
    title,
    description,
    canonical,
    lang,
    robotsMeta,
    jsonLd: extractJsonLd(html),
    textWords: countVisibleWords(html),
  };
}

/**
 * Find JSON-LD blocks and collect every @type, including nested objects and @graph entries.
 * @returns {{ blocks: number, invalid: number, types: string[] }}
 */
export function extractJsonLd(html) {
  const types = new Set();
  let blocks = 0;
  let invalid = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttributes(`<script ${m[1]}>`);
    if ((attrs.type ?? '').trim().toLowerCase() !== 'application/ld+json') continue;
    blocks++;
    let data;
    try {
      data = JSON.parse(m[2].trim().replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    } catch {
      invalid++;
      continue;
    }
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const t = node['@type'];
      if (typeof t === 'string') types.add(stripSchemaPrefix(t));
      else if (Array.isArray(t)) t.filter((x) => typeof x === 'string').forEach((x) => types.add(stripSchemaPrefix(x)));
      for (const [k, v] of Object.entries(node)) if (k !== '@context' && v && typeof v === 'object') walk(v);
    };
    walk(data);
  }
  return { blocks, invalid, types: [...types] };
}

function stripSchemaPrefix(t) {
  return t.replace(/^(https?:\/\/)?schema\.org\//i, '').replace(/^schema:/i, '');
}

/** Words of text present in the server HTML (what a crawler that does not run JavaScript sees). */
export function countVisibleWords(html) {
  const body = (html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Interpret robots directives from meta tags and the X-Robots-Tag header.
 * Only directives that apply to all crawlers, or to a crawler we track, are reported.
 * @param {{name:string, content:string}[]} robotsMeta
 * @param {string | null} xRobotsTag
 */
export function robotsDirectives(robotsMeta, xRobotsTag) {
  /** @type {{source: string, scope: string, directive: string}[]} */
  const found = [];
  for (const { name, content } of robotsMeta) {
    for (const d of content.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)) {
      found.push({ source: `<meta name="${name}">`, scope: name === 'robots' ? '*' : name, directive: d });
    }
  }
  if (xRobotsTag) {
    // Header may be "noindex, nofollow" or "googlebot: noindex" (possibly several, comma-joined).
    let scope = '*';
    for (const part of xRobotsTag.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^([a-z][\w-]*)\s*:\s*(.+)$/i);
      let directive = part.toLowerCase();
      if (m && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(m[1])) {
        scope = m[1].toLowerCase();
        directive = m[2].trim().toLowerCase();
      }
      found.push({ source: 'X-Robots-Tag', scope, directive });
    }
  }
  const has = (pred) => found.filter((f) => pred(f.directive));
  return {
    all: found,
    noindex: has((d) => d === 'noindex' || d === 'none'),
    nosnippet: has((d) => d === 'nosnippet' || d === 'max-snippet:0' || d === 'max-snippet: 0'),
  };
}
