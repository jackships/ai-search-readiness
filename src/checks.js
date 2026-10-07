// Turns already-fetched material into pass/warn/fail checks. Pure (no network), so it is
// easy to test and to reuse with your own fetcher.
import { parseRobots, isAllowed } from './robots.js';
import { extractPageInfo, robotsDirectives } from './html.js';
import { parseLlmsTxt } from './llms.js';
import { parseSitemap } from './sitemap.js';
import { AI_CRAWLERS, isVisibilityCrawler } from './crawlers.js';
import { scoreChecks } from './score.js';

/**
 * @typedef {'pass' | 'warn' | 'fail' | 'info'} Status
 * @typedef {{ id: string, label: string, status: Status, weight: number, detail: string, fix: string | null }} Check
 * @typedef {import('./fetch.js').FetchResult} FetchResult
 */

// Checks whose failure makes the page invisible to AI search no matter what else is right.
const CRITICAL = new Set(['http-status', 'indexable', 'ai-search-crawlers']);

const check = (id, label, weight, status, detail, fix = null) => ({
  id,
  label,
  status,
  weight,
  critical: CRITICAL.has(id),
  detail,
  fix: status === 'pass' || status === 'info' ? null : fix,
});

/**
 * @param {{ url: string, home: FetchResult, robots: FetchResult | null, llms: FetchResult | null,
 *           sitemap: { url: string, source: 'robots.txt' | 'default', result: FetchResult } | null }} input
 */
export function evaluate(input) {
  const { home } = input;
  /** @type {Check[]} */
  const checks = [];
  const homeOk = !home.error && home.status >= 200 && home.status < 300;
  const finalUrl = home.finalUrl || input.url;
  const origin = safeOrigin(finalUrl);
  const path = (() => {
    try {
      const u = new URL(finalUrl);
      return u.pathname + u.search;
    } catch {
      return '/';
    }
  })();

  // ---- HTTP -------------------------------------------------------------
  if (home.error) checks.push(check('http-status', 'Homepage loads', 3, 'fail', `Request failed: ${home.error}.`, 'Make sure the site is up and reachable without login, geo-blocking or bot challenges.'));
  else if (homeOk) checks.push(check('http-status', 'Homepage loads', 3, 'pass', `HTTP ${home.status} at ${finalUrl}.`));
  else checks.push(check('http-status', 'Homepage loads', 3, 'fail', `HTTP ${home.status} at ${finalUrl}.`, 'Return HTTP 200 to anonymous requests; crawlers will not index error pages.'));

  const hops = home.redirects.length;
  const hopList = home.redirects.map((r) => `${r.status} ${r.url}`).join(' -> ');
  if (hops === 0) checks.push(check('redirects', 'Redirects', 0.5, 'pass', 'No redirects.'));
  else if (hops === 1) checks.push(check('redirects', 'Redirects', 0.5, 'pass', `1 redirect: ${hopList} -> ${finalUrl}.`));
  else checks.push(check('redirects', 'Redirects', 0.5, 'warn', `${hops} redirects: ${hopList} -> ${finalUrl}.`, 'Redirect straight to the final URL in one hop and link to it directly.'));

  if (home.error) checks.push(check('response-time', 'Response time', 1, 'fail', 'No response.', 'Fix availability first.'));
  else {
    const t = home.timeMs;
    const status = t <= 1500 ? 'pass' : t <= 4000 ? 'warn' : 'fail';
    checks.push(check('response-time', 'Response time', 1, status, `${t} ms to first byte (${home.totalMs} ms total incl. redirects and body).`, 'Cache or statically render the homepage; slow pages get fetched less and can time out for on-demand AI fetchers.'));
  }

  // ---- robots.txt and AI crawlers ---------------------------------------
  const robots = input.robots;
  let parsed = { groups: [], sitemaps: [], invalidLines: 0 };
  let robotsMode = 'parsed'; // 'parsed' | 'allow-all' | 'disallow-all'
  if (!robots || robots.error) {
    robotsMode = 'disallow-all';
    checks.push(check('robots-txt', 'robots.txt', 1, 'fail', `robots.txt could not be fetched (${robots?.error ?? 'not requested'}).`, 'Serve /robots.txt reliably; under RFC 9309 an unreachable robots.txt means crawlers must assume everything is disallowed.'));
  } else if (robots.status >= 500) {
    robotsMode = 'disallow-all';
    checks.push(check('robots-txt', 'robots.txt', 1, 'fail', `robots.txt returned HTTP ${robots.status}. Crawlers treat a server error as "disallow everything".`, 'Make /robots.txt return 200 (or 404 if you have no rules).'));
  } else if (robots.status >= 400) {
    robotsMode = 'allow-all';
    checks.push(check('robots-txt', 'robots.txt', 1, 'warn', `No robots.txt (HTTP ${robots.status}); every crawler is allowed by default.`, 'Add a robots.txt with your AI crawler policy and a Sitemap: line.'));
  } else if (/^\s*<(!doctype|html)/i.test(robots.body)) {
    robotsMode = 'allow-all';
    checks.push(check('robots-txt', 'robots.txt', 1, 'warn', 'robots.txt returns an HTML page (probably an SPA fallback), so it contains no rules.', 'Serve a plain-text robots.txt at /robots.txt.'));
  } else {
    parsed = parseRobots(robots.body);
    const notes = [`${parsed.groups.length} group(s)`, `${parsed.sitemaps.length} Sitemap line(s)`];
    if (parsed.invalidLines) notes.push(`${parsed.invalidLines} unrecognised line(s)`);
    checks.push(
      parsed.invalidLines
        ? check('robots-txt', 'robots.txt', 1, 'warn', `Found: ${notes.join(', ')}.`, 'Fix or remove lines that are not "Field: value" records; parsers ignore them.')
        : check('robots-txt', 'robots.txt', 1, 'pass', `Found: ${notes.join(', ')}.`),
    );
  }

  const crawlers = AI_CRAWLERS.map((c) => {
    if (robotsMode === 'allow-all') return { ...c, allowed: true, group: null, rule: null };
    if (robotsMode === 'disallow-all') return { ...c, allowed: false, group: null, rule: 'robots.txt unavailable' };
    return { ...c, ...isAllowed(parsed, c.token, path) };
  });

  const visBlocked = crawlers.filter((c) => isVisibilityCrawler(c) && !c.allowed);
  const visTotal = crawlers.filter(isVisibilityCrawler).length;
  if (!visBlocked.length) checks.push(check('ai-search-crawlers', 'AI search & user crawlers allowed', 3, 'pass', `All ${visTotal} search/answer crawlers may fetch ${path}.`));
  else
    checks.push(
      check(
        'ai-search-crawlers',
        'AI search & user crawlers allowed',
        3,
        visBlocked.some((c) => c.purpose === 'search-engine' || c.purpose === 'search') ? 'fail' : 'warn',
        `Blocked for ${path}: ${visBlocked.map((c) => `${c.token}${c.rule ? ` (${c.rule})` : ''}`).join(', ')}.`,
        'Allow these user agents in robots.txt if you want to appear in their answers (training bots can stay blocked).',
      ),
    );

  const trainBlocked = crawlers.filter((c) => c.purpose === 'training' && !c.allowed).map((c) => c.token);
  const trainAllowed = crawlers.filter((c) => c.purpose === 'training' && c.allowed).map((c) => c.token);
  checks.push(
    check(
      'ai-training-crawlers',
      'AI training crawlers (your choice)',
      0,
      'info',
      `Allowed: ${trainAllowed.join(', ') || 'none'}. Blocked: ${trainBlocked.join(', ') || 'none'}. Blocking these does not remove you from AI search answers.`,
    ),
  );

  // ---- llms.txt ------------------------------------------------------------
  const llms = input.llms;
  if (!llms || llms.error || llms.status !== 200) {
    checks.push(check('llms-txt', '/llms.txt', 1, 'warn', llms?.error ? `Could not fetch /llms.txt (${llms.error}).` : `No /llms.txt (HTTP ${llms?.status ?? 'n/a'}).`, 'Optional but cheap: publish /llms.txt with an H1 site name, a one-line > summary and links to your key pages (see llmstxt.org).'));
  } else {
    const l = parseLlmsTxt(llms.body);
    if (l.looksLikeHtml || /text\/html/i.test(llms.headers['content-type'] ?? '')) {
      checks.push(check('llms-txt', '/llms.txt', 1, 'warn', '/llms.txt returns an HTML page (probably an SPA fallback), not Markdown.', 'Serve a plain-text Markdown file at /llms.txt.'));
    } else if (!l.title || !l.h1First) {
      checks.push(check('llms-txt', '/llms.txt', 1, 'warn', `/llms.txt found but ${l.title ? 'the H1 is not the first line' : 'has no "# Title" H1'}; ${l.links.length} link(s).`, 'Start the file with "# Your site name" as the first line.'));
    } else if (!l.links.length) {
      checks.push(check('llms-txt', '/llms.txt', 1, 'warn', `/llms.txt found ("${l.title}") but contains no Markdown links.`, 'Add "## Section" lists of "- [Page](https://...): what it covers" links to your key pages.'));
    } else {
      checks.push(check('llms-txt', '/llms.txt', 1, 'pass', `"${l.title}", ${l.sections.length} section(s), ${l.links.length} link(s)${l.summary ? ', has summary' : ''}.`));
    }
  }

  // ---- sitemap -------------------------------------------------------------
  const sm = input.sitemap;
  if (!sm) checks.push(check('sitemap', 'XML sitemap', 1.5, 'warn', 'No sitemap was found.', 'Publish /sitemap.xml and add a "Sitemap: https://.../sitemap.xml" line to robots.txt.'));
  else if (sm.result.error || sm.result.status !== 200) {
    const why = sm.result.error ?? `HTTP ${sm.result.status}`;
    checks.push(
      check('sitemap', 'XML sitemap', 1.5, sm.source === 'robots.txt' ? 'fail' : 'warn', `${sm.source === 'robots.txt' ? 'Sitemap listed in robots.txt' : 'No Sitemap: line in robots.txt, and /sitemap.xml'} failed: ${sm.url} (${why}).`, sm.source === 'robots.txt' ? 'Fix the Sitemap: URL in robots.txt so it returns 200 XML.' : 'Publish /sitemap.xml and reference it from robots.txt with a Sitemap: line.'),
    );
  } else {
    const s = parseSitemap(sm.result.body);
    if (!s.kind) checks.push(check('sitemap', 'XML sitemap', 1.5, 'fail', `${sm.url} is not a <urlset> or <sitemapindex> document.`, 'Serve a valid XML sitemap (sitemaps.org protocol).'));
    else if (!s.locs.length) checks.push(check('sitemap', 'XML sitemap', 1.5, 'warn', `${sm.url} is a ${s.kind} with no <loc> entries.`, 'List your canonical URLs in the sitemap.'));
    else {
      const via = sm.source === 'robots.txt' ? 'via robots.txt' : 'at the default path (add a Sitemap: line to robots.txt too)';
      checks.push(check('sitemap', 'XML sitemap', 1.5, sm.source === 'robots.txt' ? 'pass' : 'warn', `${s.kind} with ${s.locs.length} <loc> entr${s.locs.length === 1 ? 'y' : 'ies'} at ${sm.url}, found ${via}.`, 'Add "Sitemap: ' + sm.url + '" to robots.txt so every crawler can discover it.'));
    }
  }

  // ---- homepage HTML -------------------------------------------------------
  const page = homeOk ? extractPageInfo(home.body, finalUrl) : null;
  const skipped = (id, label, weight) => checks.push(check(id, label, weight, 'fail', 'Not checked: the homepage did not load.', 'Fix the homepage response first.'));

  if (!page) {
    skipped('indexable', 'Indexable (no noindex)', 3);
    skipped('snippets', 'Snippets allowed', 1);
  } else {
    const d = robotsDirectives(page.robotsMeta, home.headers['x-robots-tag'] ?? null);
    const tracked = new Set(['*', 'robots', ...AI_CRAWLERS.map((c) => c.token.toLowerCase())]);
    const relevant = (list) => list.filter((x) => tracked.has(x.scope));
    const describe = (list) => list.map((x) => `${x.source}${x.scope !== '*' && !x.source.includes(x.scope) ? ` (${x.scope})` : ''}: ${x.directive}`).join('; ');
    const noindex = relevant(d.noindex);
    checks.push(
      noindex.length
        ? check('indexable', 'Indexable (no noindex)', 3, 'fail', `noindex found: ${describe(noindex)}.`, 'Remove noindex from the meta robots tag / X-Robots-Tag header, then request re-indexing.')
        : check('indexable', 'Indexable (no noindex)', 3, 'pass', d.all.length ? `Robots directives: ${describe(d.all)}.` : 'No noindex in meta tags or X-Robots-Tag.'),
    );
    const nosnip = relevant(d.nosnippet);
    checks.push(
      nosnip.length
        ? check('snippets', 'Snippets allowed', 1, 'warn', `Snippet restriction: ${describe(nosnip)}. Google documents nosnippet as also keeping content out of AI Overviews.`, 'Remove nosnippet / max-snippet:0 unless you deliberately want no text excerpts shown.')
        : check('snippets', 'Snippets allowed', 1, 'pass', 'No nosnippet or max-snippet:0.'),
    );
  }

  if (!page) skipped('title', 'Title tag', 1);
  else if (!page.title) checks.push(check('title', 'Title tag', 1, 'fail', 'No <title>.', 'Add a <title> that names the brand and what it does, ideally under 60 characters.'));
  else {
    const n = [...page.title].length;
    checks.push(
      n < 10 || n > 70
        ? check('title', 'Title tag', 1, 'warn', `"${page.title}" (${n} chars).`, n < 10 ? 'Use a descriptive title: brand + what it does.' : 'Shorten the title to about 60 characters.')
        : check('title', 'Title tag', 1, 'pass', `"${page.title}" (${n} chars).`),
    );
  }

  if (!page) skipped('meta-description', 'Meta description', 1);
  else if (!page.description) checks.push(check('meta-description', 'Meta description', 1, 'warn', 'No meta description.', 'Add a 120-160 character description that says plainly who the product is for and what it does.'));
  else {
    const n = [...page.description].length;
    checks.push(
      n < 50 || n > 160
        ? check('meta-description', 'Meta description', 1, 'warn', `${n} chars: "${truncate(page.description, 90)}".`, n < 50 ? 'Expand the description to 120-160 characters.' : 'Trim the description to 160 characters or fewer.')
        : check('meta-description', 'Meta description', 1, 'pass', `${n} chars: "${truncate(page.description, 90)}".`),
    );
  }

  if (!page) skipped('canonical', 'Canonical URL', 1);
  else if (!page.canonical) checks.push(check('canonical', 'Canonical URL', 1, 'warn', 'No <link rel="canonical">.', `Add <link rel="canonical" href="${finalUrl}">.`));
  else if (sameUrl(page.canonical, finalUrl)) checks.push(check('canonical', 'Canonical URL', 1, 'pass', `Self-referencing: ${page.canonical}.`));
  else checks.push(check('canonical', 'Canonical URL', 1, 'warn', `Canonical points elsewhere: ${page.canonical} (page is ${finalUrl}).`, 'Point the homepage canonical at its own final URL.'));

  if (!page) skipped('structured-data', 'Structured data (JSON-LD)', 1);
  else {
    const ld = page.jsonLd;
    if (ld.invalid) checks.push(check('structured-data', 'Structured data (JSON-LD)', 1, 'warn', `${ld.invalid} of ${ld.blocks} JSON-LD block(s) do not parse${ld.types.length ? `; valid types: ${ld.types.join(', ')}` : ''}.`, 'Fix the JSON syntax in your application/ld+json blocks.'));
    else if (!ld.types.length) checks.push(check('structured-data', 'Structured data (JSON-LD)', 1, 'warn', 'No JSON-LD found.', 'Add Organization and WebSite JSON-LD (name, url, logo, sameAs) so engines can resolve your brand as an entity.'));
    else checks.push(check('structured-data', 'Structured data (JSON-LD)', 1, 'pass', `Types: ${ld.types.join(', ')}.`));
  }

  if (!page) skipped('server-text', 'Text in server HTML', 2);
  else {
    const w = page.textWords;
    const status = w >= 150 ? 'pass' : w >= 40 ? 'warn' : 'fail';
    checks.push(check('server-text', 'Text in server HTML', 2, status, `${w} words readable without running JavaScript.`, 'Server-render (SSR/SSG) the main copy; many AI crawlers do not execute JavaScript.'));
  }

  const { score, grade, blockers } = scoreChecks(checks);
  return {
    url: input.url,
    finalUrl,
    origin,
    checkedAt: new Date().toISOString(),
    score,
    grade,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      blockers,
    },
    checks,
    crawlers: crawlers.map(({ token, operator, purpose, allowed, group, rule }) => ({ token, operator, purpose, allowed, group, rule })),
    page: page ? { title: page.title, description: page.description, canonical: page.canonical, lang: page.lang, jsonLdTypes: page.jsonLd.types, textWords: page.textWords } : null,
  };
}

function safeOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Same page, ignoring a trailing slash, default ports, host case and fragment. */
export function sameUrl(a, b) {
  const norm = (x) => {
    try {
      const u = new URL(x);
      u.hash = '';
      const p = u.pathname.replace(/\/+$/, '') || '/';
      return `${u.protocol}//${u.host.toLowerCase()}${p}${u.search}`;
    } catch {
      return x;
    }
  };
  return norm(a) === norm(b);
}
