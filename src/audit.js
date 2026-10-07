import { fetchUrl, DEFAULT_USER_AGENT } from './fetch.js';
import { parseRobots } from './robots.js';
import { evaluate } from './checks.js';

/**
 * Normalise user input like "example.com" to "https://example.com/".
 * @param {string} input
 */
export function normalizeTarget(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('No URL given.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported protocol: ${u.protocol}`);
  return u.href;
}

/**
 * Run every check against a site and return the scored report.
 * @param {string} target URL or bare domain
 * @param {{ timeoutMs?: number, userAgent?: string }} [opts]
 */
export async function audit(target, opts = {}) {
  const url = normalizeTarget(target);
  const fetchOpts = { timeoutMs: opts.timeoutMs ?? 10000, userAgent: opts.userAgent ?? DEFAULT_USER_AGENT };

  const home = await fetchUrl(url, { ...fetchOpts, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' });
  // robots.txt, llms.txt and the sitemap live on the origin the homepage ends up on.
  const origin = new URL(home.error ? url : home.finalUrl).origin;

  const [robots, llms] = await Promise.all([
    fetchUrl(`${origin}/robots.txt`, { ...fetchOpts, accept: 'text/plain,*/*;q=0.5', maxBytes: 512 * 1024 }),
    fetchUrl(`${origin}/llms.txt`, { ...fetchOpts, accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.5', maxBytes: 1024 * 1024 }),
  ]);

  let sitemap = null;
  const robotsOk = !robots.error && robots.status === 200 && !/^\s*<(!doctype|html)/i.test(robots.body);
  const declared = robotsOk ? parseRobots(robots.body).sitemaps : [];
  if (declared.length) {
    let sitemapUrl;
    try {
      sitemapUrl = new URL(declared[0], origin).href;
    } catch {
      sitemapUrl = declared[0];
    }
    sitemap = { url: sitemapUrl, source: 'robots.txt', result: await fetchUrl(sitemapUrl, { ...fetchOpts, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' }) };
  } else {
    const sitemapUrl = `${origin}/sitemap.xml`;
    const result = await fetchUrl(sitemapUrl, { ...fetchOpts, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' });
    if (!result.error && result.status !== 404 && result.status !== 410) sitemap = { url: sitemapUrl, source: 'default', result };
  }

  return evaluate({ url, home, robots, llms, sitemap });
}
