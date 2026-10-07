/**
 * Recognise an XML sitemap or sitemap index and list its <loc> entries.
 * @param {string} xml
 * @returns {{ kind: 'urlset' | 'sitemapindex' | null, locs: string[] }}
 */
export function parseSitemap(xml) {
  const src = String(xml ?? '');
  let kind = null;
  if (/<(?:[\w-]+:)?urlset\b/i.test(src)) kind = 'urlset';
  else if (/<(?:[\w-]+:)?sitemapindex\b/i.test(src)) kind = 'sitemapindex';
  const locs = [...src.matchAll(/<(?:[\w-]+:)?loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/(?:[\w-]+:)?loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  );
  return { kind, locs };
}
