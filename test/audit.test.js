import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { audit, normalizeTarget, fetchUrl, formatText } from '../src/index.js';
import { startServer, html, WORDS } from './helpers.js';

const byId = (report, id) => report.checks.find((c) => c.id === id);
const crawler = (report, token) => report.crawlers.find((c) => c.token === token);

function goodSite(base) {
  return {
    '/': html(`<!doctype html><html lang="en"><head>
<title>Acme — widgets for small teams</title>
<meta name="description" content="Acme makes simple, affordable widgets for small teams that need to ship faster without hiring a platform engineer.">
<link rel="canonical" href="${base}/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"${base}/"}</script>
</head><body><main><h1>Acme</h1><p>${WORDS}</p></main></body></html>`),
    '/robots.txt': { body: `User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nSitemap: ${base}/sitemap-index.xml\n` },
    '/sitemap-index.xml': { headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${base}/sitemap-1.xml</loc></sitemap></sitemapindex>` },
    '/llms.txt': { body: '# Acme\n\n> Widgets for small teams.\n\n## Product\n- [Pricing](https://acme.test/pricing): plans\n' },
  };
}

test('well-configured site scores high; training bots blocked is informational only', async (t) => {
  const routes = {};
  const srv = await startServer(routes);
  t.after(srv.close);
  Object.assign(routes, goodSite(srv.url));

  const r = await audit(srv.url);
  const failing = r.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  assert.deepEqual(failing, [], JSON.stringify(failing, null, 2));
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(crawler(r, 'GPTBot').allowed, false);
  assert.equal(crawler(r, 'CCBot').allowed, false);
  assert.equal(crawler(r, 'OAI-SearchBot').allowed, true);
  assert.equal(crawler(r, 'OAI-SearchBot').group, '*');
  assert.equal(byId(r, 'ai-training-crawlers').status, 'info');
  assert.match(byId(r, 'ai-training-crawlers').detail, /Blocked: GPTBot, CCBot/);
  assert.deepEqual(r.page.jsonLdTypes, ['Organization']);
  // every non-pass check carries a fix line
  for (const c of r.checks) if (c.status === 'pass') assert.equal(c.fix, null);
  assert.match(formatText(r), /Score 100\/100 \(A\)/);
});

test('blocked search crawlers, noindex, missing files and JS-only shell are flagged', async (t) => {
  const srv = await startServer({
    '/': {
      headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
      body: '<html><head><meta name="robots" content="nosnippet"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    },
    '/robots.txt': { body: 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n' },
    // SPA fallback: /llms.txt returns the app shell with 200
    '/llms.txt': html('<!DOCTYPE html><html><body><div id="root"></div></body></html>'),
  });
  t.after(srv.close);

  const r = await audit(srv.url);
  assert.equal(byId(r, 'ai-search-crawlers').status, 'fail');
  assert.match(byId(r, 'ai-search-crawlers').detail, /OAI-SearchBot \(Disallow: \/\)/);
  assert.equal(crawler(r, 'Googlebot').allowed, true);
  assert.equal(byId(r, 'indexable').status, 'fail');
  assert.match(byId(r, 'indexable').detail, /X-Robots-Tag: noindex/);
  assert.equal(byId(r, 'snippets').status, 'warn');
  assert.equal(byId(r, 'llms-txt').status, 'warn');
  assert.match(byId(r, 'llms-txt').detail, /HTML page/);
  assert.equal(byId(r, 'sitemap').status, 'warn');
  assert.equal(byId(r, 'title').status, 'fail');
  assert.equal(byId(r, 'meta-description').status, 'warn');
  assert.equal(byId(r, 'canonical').status, 'warn');
  assert.equal(byId(r, 'structured-data').status, 'warn');
  assert.equal(byId(r, 'server-text').status, 'fail');
  for (const c of r.checks.filter((x) => x.status === 'warn' || x.status === 'fail')) assert.ok(c.fix, `${c.id} needs a fix line`);
  assert.ok(r.score < 40, `score ${r.score}`);
});

test('redirect chain is recorded; robots/llms/sitemap are read from the final origin', async (t) => {
  const routes = {};
  const srv = await startServer(routes);
  t.after(srv.close);
  Object.assign(routes, goodSite(srv.url), {
    '/start': { status: 301, headers: { location: '/step2' } },
    '/step2': { status: 302, headers: { location: `${srv.url}/` } },
  });
  const r = await audit(`${srv.url}/start`);
  assert.equal(r.finalUrl, `${srv.url}/`);
  assert.equal(byId(r, 'redirects').status, 'warn');
  assert.match(byId(r, 'redirects').detail, /2 redirects: 301 .*\/start -> 302 .*\/step2/);
  assert.equal(byId(r, 'llms-txt').status, 'pass');
});

test('robots.txt 5xx means disallow-all; 404 means allow-all', async (t) => {
  const srv = await startServer({ '/': html(`<title>Server error site</title><p>${WORDS}</p>`), '/robots.txt': { status: 503, body: 'down' } });
  t.after(srv.close);
  const r = await audit(srv.url);
  assert.equal(byId(r, 'robots-txt').status, 'fail');
  assert.ok(r.crawlers.every((c) => !c.allowed));

  const srv2 = await startServer({ '/': html('<title>No robots here</title>') });
  t.after(srv2.close);
  const r2 = await audit(srv2.url);
  assert.equal(byId(r2, 'robots-txt').status, 'warn');
  assert.ok(r2.crawlers.every((c) => c.allowed));
});

test('falls back to /sitemap.xml (gzip ok) and warns that robots.txt does not declare it', async (t) => {
  const srv = await startServer({
    '/': html('<title>Fallback sitemap site</title>'),
    '/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
    '/sitemap.xml': { headers: { 'content-type': 'application/gzip' }, body: gzipSync('<urlset><url><loc>https://a.test/</loc></url><url><loc>https://a.test/b</loc></url></urlset>') },
  });
  t.after(srv.close);
  const r = await audit(srv.url);
  const s = byId(r, 'sitemap');
  assert.equal(s.status, 'warn');
  assert.match(s.detail, /urlset with 2 <loc> entries/);
  assert.match(s.fix, /Sitemap: /);
});

test('broken sitemap declared in robots.txt fails', async (t) => {
  const srv = await startServer({ '/': html('<title>Broken sitemap site</title>'), '/robots.txt': { body: 'Sitemap: /missing.xml\n' } });
  t.after(srv.close);
  const r = await audit(srv.url);
  assert.equal(byId(r, 'sitemap').status, 'fail');
});

test('homepage errors and timeouts are reported, not thrown', async (t) => {
  const srv = await startServer({ '/': { status: 500, body: 'boom' }, '/slow': { delayMs: 500, body: 'late' } });
  t.after(srv.close);
  const r = await audit(srv.url);
  assert.equal(byId(r, 'http-status').status, 'fail');
  assert.equal(byId(r, 'title').status, 'fail');
  assert.match(byId(r, 'title').detail, /did not load/);

  const slow = await fetchUrl(`${srv.url}/slow`, { timeoutMs: 100 });
  assert.equal(slow.status, 0);
  assert.match(slow.error, /timed out/);
});

test('sends the ai-search-readiness User-Agent', async (t) => {
  let ua = null;
  const srv = await startServer({
    '/': (req) => {
      ua = req.headers['user-agent'];
      return html('<title>UA test</title>');
    },
  });
  t.after(srv.close);
  await fetchUrl(srv.url + '/');
  assert.equal(ua, 'ai-search-readiness/0.1 (+https://github.com/jackships/ai-search-readiness)');
});

test('normalizeTarget adds https:// and rejects other protocols', () => {
  assert.equal(normalizeTarget('example.com'), 'https://example.com/');
  assert.equal(normalizeTarget('http://example.com/a'), 'http://example.com/a');
  assert.throws(() => normalizeTarget('ftp://example.com'), /Unsupported/);
  assert.throws(() => normalizeTarget(''), /No URL/);
});

test('CLI: --json output and --fail-under exit code', async (t) => {
  const routes = {};
  const srv = await startServer(routes);
  t.after(srv.close);
  Object.assign(routes, { '/': html('<title>CLI test page</title>') });
  const run = promisify(execFile);
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;

  const { stdout } = await run(process.execPath, [cli, srv.url, '--json']);
  const report = JSON.parse(stdout);
  assert.equal(typeof report.score, 'number');
  assert.ok(Array.isArray(report.checks) && Array.isArray(report.crawlers));

  await assert.rejects(run(process.execPath, [cli, srv.url, '--fail-under', '101']), (err) => err.code === 1);
  await assert.rejects(run(process.execPath, [cli]), (err) => err.code === 2);
});
