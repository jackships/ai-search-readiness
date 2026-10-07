import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, patternMatches } from '../src/robots.js';

test('groups: consecutive User-agent lines share one group; Sitemap lines are collected', () => {
  const p = parseRobots(`# comment
User-agent: GPTBot
User-agent: CCBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
User-agent: *
Allow: /
`);
  assert.equal(p.groups.length, 2);
  assert.deepEqual(p.groups[0].agents, ['gptbot', 'ccbot']);
  assert.deepEqual(p.sitemaps, ['https://example.com/sitemap.xml']);
});

test('a specific group overrides "*" entirely (rules are not inherited)', () => {
  const txt = `User-agent: *
Disallow: /

User-agent: OAI-SearchBot
Disallow: /private
`;
  assert.equal(isAllowed(txt, 'OAI-SearchBot', '/').allowed, true);
  assert.equal(isAllowed(txt, 'OAI-SearchBot', '/private/x').allowed, false);
  assert.equal(isAllowed(txt, 'ClaudeBot', '/').allowed, false);
  assert.equal(isAllowed(txt, 'ClaudeBot', '/').group, '*');
});

test('user-agent matching is case-insensitive and ignores version suffixes', () => {
  const txt = `User-agent: gptbot/1.1\nDisallow: /\n`;
  assert.equal(isAllowed(txt, 'GPTBot', '/').allowed, false);
  // ChatGPT-User must not be caught by a "ChatGPT" prefix-like group of another token
  assert.equal(isAllowed('User-agent: ChatGPT\nDisallow: /\n', 'ChatGPT-User', '/').allowed, true);
});

test('groups naming the same agent are merged', () => {
  const txt = `User-agent: PerplexityBot
Disallow: /a

User-agent: PerplexityBot
Disallow: /b
`;
  assert.equal(isAllowed(txt, 'PerplexityBot', '/a').allowed, false);
  assert.equal(isAllowed(txt, 'PerplexityBot', '/b').allowed, false);
  assert.equal(isAllowed(txt, 'PerplexityBot', '/c').allowed, true);
});

test('longest matching rule wins regardless of order', () => {
  const txt = `User-agent: *
Allow: /docs/public
Disallow: /docs
`;
  assert.equal(isAllowed(txt, 'X', '/docs/public/page').allowed, true);
  assert.equal(isAllowed(txt, 'X', '/docs/secret').allowed, false);
  const reversed = `User-agent: *\nDisallow: /\nAllow: /$\n`;
  assert.equal(isAllowed(reversed, 'X', '/').allowed, true, '"/$" is longer than "/" so Allow wins');
  assert.equal(isAllowed(reversed, 'X', '/pricing').allowed, false);
});

test('Allow wins a tie of equal length', () => {
  const txt = `User-agent: *\nDisallow: /page\nAllow: /page\n`;
  const r = isAllowed(txt, 'X', '/page');
  assert.equal(r.allowed, true);
  assert.equal(r.rule, 'Allow: /page');
});

test('empty Disallow allows everything; no matching group allows everything', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow:\n', 'X', '/').allowed, true);
  assert.equal(isAllowed('User-agent: Foo\nDisallow: /\n', 'Bar', '/').allowed, true);
  assert.equal(isAllowed('', 'Bar', '/').allowed, true);
});

test('wildcards and end anchors', () => {
  assert.equal(patternMatches('/*.pdf$', '/files/a.pdf'), true);
  assert.equal(patternMatches('/*.pdf$', '/files/a.pdf?x=1'), false);
  assert.equal(patternMatches('/*?', '/search?q=1'), true);
  assert.equal(patternMatches('/fish', '/fish.html'), true);
  assert.equal(patternMatches('/fish/', '/fish'), false);
  assert.equal(isAllowed('User-agent: *\nDisallow: /*?\n', 'X', '/?ref=hn').allowed, false);
});

test('Crawl-delay between User-agent lines ends the agent run', () => {
  const p = parseRobots('User-agent: a\nCrawl-delay: 5\nUser-agent: b\nDisallow: /\n');
  assert.equal(p.groups.length, 2);
  assert.equal(isAllowed(p, 'a', '/').allowed, true);
  assert.equal(isAllowed(p, 'b', '/').allowed, false);
});

test('BOM, CRLF and inline comments are handled', () => {
  const txt = '﻿User-agent: ClaudeBot # training\r\nDisallow: / # everything\r\n';
  assert.equal(isAllowed(txt, 'ClaudeBot', '/').allowed, false);
});

test('percent-encoding is normalised before matching', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow: /café\n', 'X', '/caf%C3%A9').allowed, false);
});
