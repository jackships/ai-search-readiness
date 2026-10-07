import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLd, extractPageInfo, robotsDirectives } from '../src/html.js';
import { parseLlmsTxt } from '../src/llms.js';
import { parseSitemap } from '../src/sitemap.js';
import { scoreChecks, grade } from '../src/score.js';
import { AI_CRAWLERS } from '../src/crawlers.js';

test('JSON-LD: arrays, @graph, nested objects, schema.org prefixes, invalid blocks', () => {
  const page = `
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"A","logo":{"@type":"ImageObject"}},{"@type":["WebSite","Thing"]}]}</script>
<script type='application/ld+json'>[{"@type":"https://schema.org/FAQPage","mainEntity":[{"@type":"Question"}]}]</script>
<script TYPE="application/ld+json">{ broken json </script>
<script type="text/javascript">var x = {"@type":"NotJsonLd"}</script>`;
  const ld = extractJsonLd(page);
  assert.equal(ld.blocks, 3);
  assert.equal(ld.invalid, 1);
  assert.deepEqual(ld.types.sort(), ['FAQPage', 'ImageObject', 'Organization', 'Question', 'Thing', 'WebSite']);
});

test('page info: title, description, canonical, robots meta, ignores comments', () => {
  const info = extractPageInfo(
    `<html lang="en"><head>
<title> Acme &amp; Co \n — widgets </title>
<!-- <meta name="robots" content="noindex"> -->
<meta content="Widgets for teams." name=description>
<meta name="GPTBot" content="noindex">
<link rel="alternate canonical" href="/home">
</head><body><p>Hello world</p><script>ignored words here</script></body></html>`,
    'https://acme.test/',
  );
  assert.equal(info.title, 'Acme & Co — widgets');
  assert.equal(info.description, 'Widgets for teams.');
  assert.equal(info.canonical, 'https://acme.test/home');
  assert.equal(info.lang, 'en');
  assert.deepEqual(info.robotsMeta, [{ name: 'gptbot', content: 'noindex' }]);
  assert.equal(info.textWords, 2);
});

test('robots directives from meta and X-Robots-Tag, with scopes', () => {
  const d = robotsDirectives([{ name: 'robots', content: 'max-snippet:0, follow' }], 'googlebot: noindex, nofollow');
  assert.deepEqual(d.noindex.map((x) => [x.scope, x.source]), [['googlebot', 'X-Robots-Tag']]);
  assert.equal(d.nosnippet.length, 1);
  assert.equal(robotsDirectives([], 'none').noindex.length, 1);
  assert.equal(robotsDirectives([], 'max-snippet:0').nosnippet[0].scope, '*');
});

test('llms.txt: valid file', () => {
  const l = parseLlmsTxt(`# Acme

> Acme makes widgets for small teams.

## Docs
- [Quick start](https://acme.test/docs/start): set up in 5 minutes
- [API](https://acme.test/docs/api.md)
`);
  assert.equal(l.title, 'Acme');
  assert.equal(l.h1First, true);
  assert.equal(l.summary, 'Acme makes widgets for small teams.');
  assert.deepEqual(l.sections, ['Docs']);
  assert.equal(l.links.length, 2);
  assert.equal(l.looksLikeHtml, false);
});

test('llms.txt: detects HTML fallback and missing H1', () => {
  assert.equal(parseLlmsTxt('<!DOCTYPE html><html><body>app</body></html>').looksLikeHtml, true);
  const noH1 = parseLlmsTxt('Some text\n## Links\n- [a](https://a.test)');
  assert.equal(noH1.title, null);
  assert.equal(noH1.h1First, false);
  assert.equal(parseLlmsTxt('intro\n# Late title').h1First, false);
});

test('sitemap: urlset, sitemapindex, namespaced and CDATA locs, garbage', () => {
  assert.deepEqual(parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.test/?a=1&amp;b=2</loc></url></urlset>'), {
    kind: 'urlset',
    locs: ['https://a.test/?a=1&b=2'],
  });
  const idx = parseSitemap('<sm:sitemapindex><sm:sitemap><sm:loc><![CDATA[https://a.test/s1.xml]]></sm:loc></sm:sitemap></sm:sitemapindex>');
  assert.equal(idx.kind, 'sitemapindex');
  assert.deepEqual(idx.locs, ['https://a.test/s1.xml']);
  assert.equal(parseSitemap('<html>nope</html>').kind, null);
});

test('scoring: weighted, info ignored, grades', () => {
  const { score } = scoreChecks([
    { status: 'pass', weight: 3 },
    { status: 'warn', weight: 1 },
    { status: 'fail', weight: 1 },
    { status: 'info', weight: 5 },
  ]);
  assert.equal(score, 70); // (3 + 0.5 + 0) / 5
  assert.equal(scoreChecks([]).score, 0);
  const capped = scoreChecks([
    { status: 'pass', weight: 10 },
    { status: 'fail', weight: 1, critical: true },
  ]);
  assert.equal(capped.score, 39); // would be 91 without the blocker cap
  assert.equal(capped.blockers, 1);
  assert.deepEqual([95, 80, 60, 45, 10].map(grade), ['A', 'B', 'C', 'D', 'F']);
});

test('crawler data file is well-formed', () => {
  const required = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'Meta-ExternalAgent'];
  const tokens = AI_CRAWLERS.map((c) => c.token);
  for (const t of required) assert.ok(tokens.includes(t), t);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const c of AI_CRAWLERS) {
    assert.ok(['search', 'user', 'training', 'search-engine'].includes(c.purpose), c.token);
    assert.ok(c.description && c.operator, c.token);
  }
});
