#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { audit, formatText, DEFAULT_USER_AGENT } from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `ai-search-readiness ${pkg.version}
Check a site's technical readiness for AI search (ChatGPT, Perplexity, Claude, Gemini...).

Usage
  npx ai-search-readiness <url> [options]

Options
  --json              Print the full report as JSON
  --timeout <ms>      Per-request timeout (default 10000)
  --user-agent <ua>   Override the User-Agent header
  --fail-under <n>    Exit with code 1 if the score is below n (for CI)
  --no-color          Disable ANSI colours
  -h, --help          Show this help
  -v, --version       Show the version

Examples
  npx ai-search-readiness example.com
  npx ai-search-readiness https://example.com --json > report.json
  npx ai-search-readiness https://staging.example.com --fail-under 80
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      'user-agent': { type: 'string' },
      'fail-under': { type: 'string' },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
} catch (err) {
  process.stderr.write(`${err.message}\n\n${HELP}`);
  process.exit(2);
}

const { values, positionals } = args;
if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (positionals.length !== 1) {
  process.stderr.write(HELP);
  process.exit(2);
}

const timeoutMs = values.timeout ? Number(values.timeout) : 10000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write('--timeout must be a positive number of milliseconds\n');
  process.exit(2);
}
const failUnder = values['fail-under'] !== undefined ? Number(values['fail-under']) : null;
if (failUnder !== null && !Number.isFinite(failUnder)) {
  process.stderr.write('--fail-under must be a number\n');
  process.exit(2);
}

try {
  const report = await audit(positionals[0], { timeoutMs, userAgent: values['user-agent'] ?? DEFAULT_USER_AGENT });
  if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    const color = !values['no-color'] && process.stdout.isTTY && !process.env.NO_COLOR;
    process.stdout.write(formatText(report, { color }) + '\n');
  }
  process.exit(failUnder !== null && report.score < failUnder ? 1 : 0);
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(2);
}
