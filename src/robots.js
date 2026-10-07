// robots.txt parsing and matching, following RFC 9309 and Google's documented behaviour:
// - a group is one or more consecutive User-agent lines followed by rules;
// - a crawler obeys only the group(s) naming its product token (case-insensitive),
//   falling back to the "*" group(s); groups naming the same token are merged;
// - among matching rules the longest path pattern wins, and Allow wins a tie;
// - "*" matches any sequence of characters and "$" anchors the end of the URL.

/**
 * @typedef {{ allow: boolean, path: string, line: number }} RobotsRule
 * @typedef {{ agents: string[], rules: RobotsRule[] }} RobotsGroup
 * @typedef {{ groups: RobotsGroup[], sitemaps: string[], invalidLines: number }} ParsedRobots
 */

/** @param {string} text @returns {ParsedRobots} */
export function parseRobots(text) {
  /** @type {RobotsGroup[]} */
  const groups = [];
  const sitemaps = [];
  let invalidLines = 0;
  /** @type {RobotsGroup | null} */
  let current = null;
  let collectingAgents = false;

  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) {
      invalidLines++;
      return;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      return; // non-group record: does not end or start a group
    }
    if (key === 'user-agent' || key === 'useragent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(normalizeAgent(value));
      collectingAgents = true;
      return;
    }
    if (key === 'allow' || key === 'disallow') {
      collectingAgents = false;
      if (!current) return; // rule before any User-agent line is ignored
      if (value === '') return; // "Disallow:" with no path allows everything
      current.rules.push({ allow: key === 'allow', path: value, line: i + 1 });
      return;
    }
    // Other records (Crawl-delay, Host, ...) are ignored but end an agent run.
    collectingAgents = false;
  });

  return { groups, sitemaps, invalidLines };
}

/** "GPTBot/1.1" -> "gptbot"; "*" stays "*". */
function normalizeAgent(value) {
  if (value.trim() === '*') return '*';
  const m = value.match(/^[A-Za-z_-]+/);
  return (m ? m[0] : value).toLowerCase();
}

/**
 * Returns the merged rules that apply to a product token, and which group name matched.
 * @param {ParsedRobots} parsed
 * @param {string} token
 */
export function rulesFor(parsed, token) {
  const t = token.toLowerCase();
  let groups = parsed.groups.filter((g) => g.agents.includes(t));
  let matched = token;
  if (!groups.length) {
    groups = parsed.groups.filter((g) => g.agents.includes('*'));
    matched = groups.length ? '*' : null;
  }
  return { matched, rules: groups.flatMap((g) => g.rules) };
}

/** @param {string} pattern @param {string} path */
export function patternMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path);
}

/**
 * Decide whether `token` may fetch `path` (path + query, starting with "/").
 * @param {ParsedRobots | string} robots parsed robots or raw text
 * @param {string} token
 * @param {string} path
 * @returns {{ allowed: boolean, group: string | null, rule: string | null }}
 */
export function isAllowed(robots, token, path) {
  const parsed = typeof robots === 'string' ? parseRobots(robots) : robots;
  const p = normalizePath(path);
  if (p === '/robots.txt') return { allowed: true, group: null, rule: null };
  const { matched, rules } = rulesFor(parsed, token);
  /** @type {RobotsRule | null} */
  let best = null;
  for (const r of rules) {
    const pattern = normalizePath(r.path);
    if (!patternMatches(pattern, p)) continue;
    if (
      !best ||
      pattern.length > normalizePath(best.path).length ||
      (pattern.length === normalizePath(best.path).length && r.allow && !best.allow)
    ) {
      best = r;
    }
  }
  return {
    allowed: best ? best.allow : true,
    group: matched,
    rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null,
  };
}

// Compare paths in a canonical percent-encoded form so "/caf%C3%A9" and "/café" match.
function normalizePath(path) {
  let p = path || '/';
  if (!p.startsWith('/') && !p.startsWith('*')) p = '/' + p;
  try {
    return encodeURI(decodeURI(p)).replace(/%25(?=[0-9A-F]{2})/gi, '%');
  } catch {
    return p;
  }
}
