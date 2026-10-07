# ai-search-readiness

A zero-dependency Node.js CLI (and library) that checks whether AI search engines such as ChatGPT search, Perplexity, Claude and Google's AI features can technically reach, read and index your site. It gives each check pass, warn or fail with a one-line fix, then a 0-100 score.

```bash
npx ai-search-readiness example.com
```

## Why

AI answer engines can only cite pages their crawlers are allowed to fetch and able to read. The usual problems are dull and easy to miss:

- a robots.txt template that blocks `PerplexityBot` or `OAI-SearchBot` when you only meant to block training bots like `GPTBot`;
- a leftover `noindex` or `X-Robots-Tag` from staging;
- an SPA that sends crawlers an empty `<div id="root">`;
- `/llms.txt` or `/robots.txt` quietly returning your app's HTML shell;
- no sitemap, or a `Sitemap:` line pointing to a 404.

This tool checks all of these in a couple of seconds. You can run it locally or in CI.

## Usage

Requires Node.js 18 or newer. There is nothing to install beyond the package itself.

```bash
npx ai-search-readiness https://example.com            # human-readable report
npx ai-search-readiness example.com --json > out.json  # full machine-readable report
npx ai-search-readiness https://staging.example.com --fail-under 80   # exit 1 below 80 (CI)
```

| Option | Default | Meaning |
|---|---|---|
| `--json` | off | Print the full report as JSON |
| `--timeout <ms>` | `10000` | Per-request timeout |
| `--user-agent <ua>` | `ai-search-readiness/0.1 (+https://github.com/jackships/ai-search-readiness)` | User-Agent header sent with every request |
| `--fail-under <n>` | none | Exit with code `1` if the score is below `n` |
| `--no-color` | colour on a TTY | Disable ANSI colours (`NO_COLOR` is honoured too) |

Exit codes: `0` ok, `1` score below `--fail-under`, `2` bad arguments or invalid URL.

### As a library

```js
import { audit, formatText, isAllowed } from 'ai-search-readiness';

const report = await audit('https://example.com', { timeoutMs: 8000 });
console.log(report.score, report.grade);
console.log(formatText(report));

// The parsers are exported too:
isAllowed('User-agent: *\nDisallow: /\nAllow: /$', 'OAI-SearchBot', '/'); // { allowed: true, ... }
```

Also exported: `evaluate` (scores already-fetched material, so you can use your own fetcher), `parseRobots`, `extractPageInfo`, `extractJsonLd`, `parseLlmsTxt`, `parseSitemap`, `scoreChecks` and `AI_CRAWLERS`.

## Example output

Here is the report for a hypothetical site that blocks PerplexityBot and GPTBot and has a thin homepage:

```text
AI search readiness: https://example.com/
Score 39/100 (F)  7 pass, 6 warn, 1 fail (1 blocker: score capped at 39)

[PASS] Homepage loads: HTTP 200 at https://example.com/.
[PASS] Redirects: No redirects.
[PASS] Response time: 240 ms to first byte (262 ms total incl. redirects and body).
[PASS] robots.txt: Found: 2 group(s), 0 Sitemap line(s).
[FAIL] AI search & user crawlers allowed: Blocked for /: PerplexityBot (Disallow: /).
       fix: Allow these user agents in robots.txt if you want to appear in their answers (training bots can stay blocked).
[INFO] AI training crawlers (your choice): Allowed: ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent. Blocked: GPTBot. Blocking these does not remove you from AI search answers.
[WARN] /llms.txt: No /llms.txt (HTTP 404).
       fix: Optional but cheap: publish /llms.txt with an H1 site name, a one-line > summary and links to your key pages (see llmstxt.org).
[WARN] XML sitemap: urlset with 1 <loc> entry at https://example.com/sitemap.xml, found at the default path (add a Sitemap: line to robots.txt too).
       fix: Add "Sitemap: https://example.com/sitemap.xml" to robots.txt so every crawler can discover it.
[PASS] Indexable (no noindex): No noindex in meta tags or X-Robots-Tag.
[PASS] Snippets allowed: No nosnippet or max-snippet:0.
[WARN] Title tag: "Example — the friendly project tracker for small product teams and agencies" (75 chars).
       fix: Shorten the title to about 60 characters.
[WARN] Meta description: 15 chars: "Track projects.".
       fix: Expand the description to 120-160 characters.
[WARN] Canonical URL: No <link rel="canonical">.
       fix: Add <link rel="canonical" href="https://example.com/">.
[PASS] Structured data (JSON-LD): Types: Organization.
[WARN] Text in server HTML: 90 words readable without running JavaScript.
       fix: Server-render (SSR/SSG) the main copy; many AI crawlers do not execute JavaScript.

AI crawlers vs. robots.txt (homepage)
  Googlebot           search-engine  allowed Allow: / [group: *]
  Bingbot             search-engine  allowed Allow: / [group: *]
  OAI-SearchBot       search         allowed Allow: / [group: *]
  ChatGPT-User        user           allowed Allow: / [group: *]
  GPTBot              training       blocked Disallow: / [group: GPTBot]
  Claude-SearchBot    search         allowed Allow: / [group: *]
  Claude-User         user           allowed Allow: / [group: *]
  ClaudeBot           training       allowed Allow: / [group: *]
  PerplexityBot       search         blocked Disallow: / [group: PerplexityBot]
  Perplexity-User     user           allowed Allow: / [group: *]
  Google-Extended     training       allowed Allow: / [group: *]
  Applebot-Extended   training       allowed Allow: / [group: *]
  CCBot               training       allowed Allow: / [group: *]
  Bytespider          training       allowed Allow: / [group: *]
  Meta-ExternalAgent  training       allowed Allow: / [group: *]

Technical readiness only: this does not measure whether AI engines actually cite you.
```

## Checks

| ID | Check | Pass | Warn | Fail | Weight |
|---|---|---|---|---|---|
| `http-status` | Homepage loads | 2xx after redirects | | Non-2xx, network error, timeout | 3 (blocker) |
| `redirects` | Redirect chain | 0-1 hops | 2+ hops | | 0.5 |
| `response-time` | Time to first byte, final hop | ≤ 1.5 s | ≤ 4 s | > 4 s or no response | 1 |
| `robots-txt` | `/robots.txt` | 200 plain text, parses cleanly | 404 (all allowed), HTML fallback, unrecognised lines | 5xx or unreachable (treated as disallow-all, per RFC 9309) | 1 |
| `ai-search-crawlers` | Search, answer and user-fetch crawlers may fetch the homepage | All allowed | Only user-fetch agents blocked | A search crawler is blocked | 3 (blocker) |
| `ai-training-crawlers` | Training crawlers allowed or blocked | Info only: this is your choice and does not affect AI search answers | | | 0 |
| `llms-txt` | `/llms.txt` ([llmstxt.org](https://llmstxt.org)) | First line is an H1 and the file has Markdown links | Missing, HTML fallback, no H1, or no links | | 1 |
| `sitemap` | Sitemap from the `Sitemap:` line in robots.txt, else `/sitemap.xml` | Declared in robots.txt and a valid `urlset`/`sitemapindex` with `<loc>` entries | Found only at `/sitemap.xml`, empty, or none found | Declared sitemap is broken or not a sitemap | 1.5 |
| `indexable` | `noindex` / `none` in `<meta name="robots">`, crawler-specific meta tags, or `X-Robots-Tag` | None | | Present | 3 (blocker) |
| `snippets` | `nosnippet` / `max-snippet:0` | None | Present | | 1 |
| `title` | `<title>` | 10-70 chars | Too short or too long | Missing | 1 |
| `meta-description` | `<meta name="description">` | 50-160 chars | Missing, too short or too long | | 1 |
| `canonical` | `<link rel="canonical">` | Points to the page itself | Missing or points elsewhere | | 1 |
| `structured-data` | JSON-LD `@type`s, including `@graph` and nested types | At least one valid block | None, or a block fails to parse | | 1 |
| `server-text` | Words in the server HTML, with scripts and styles stripped | ≥ 150 | 40-149 | < 40 (likely a client-rendered shell) | 2 |

**Scoring.** Each check counts as pass = 1, warn = 0.5 or fail = 0, multiplied by its weight, and the total is scaled to 0-100. Info checks don't count. If any blocker fails, the score is capped at 39 (grade F), because nothing else matters when crawlers can't load or index the page. Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F below that.

**robots.txt evaluation** follows RFC 9309 and Google's documented behaviour. Groups that name a crawler's product token (case-insensitive) apply to it, and several such groups are merged. A crawler named in no group falls back to `*`. The longest matching path wins, and `Allow` wins a tie. `*` and `$` wildcards work. The check is run against the homepage URL after redirects.

## AI crawlers checked

The list lives in [`data/ai-crawlers.json`](data/ai-crawlers.json), with a link to each operator's documentation.

| Token | Operator | Type | What it is |
|---|---|---|---|
| `Googlebot` | Google | search engine | Google Search crawler. AI Overviews and AI Mode use pages from the Search index. |
| `Bingbot` | Microsoft | search engine | Bing crawler. Copilot answers are grounded in the Bing index. |
| `OAI-SearchBot` | OpenAI | search | Surfaces and links sites in ChatGPT search. Not used for training. |
| `ChatGPT-User` | OpenAI | user fetch | Fetches a page when a ChatGPT user or GPT action asks for it. |
| `GPTBot` | OpenAI | training | Collects content that may be used to train OpenAI models. |
| `Claude-SearchBot` | Anthropic | search | Improves search result quality in Claude. |
| `Claude-User` | Anthropic | user fetch | Fetches a page when a Claude user asks. |
| `ClaudeBot` | Anthropic | training | Collects content that may be used to train Anthropic models. |
| `PerplexityBot` | Perplexity | search | Indexes pages to surface and link in Perplexity answers. |
| `Perplexity-User` | Perplexity | user fetch | Fetches a page in response to a user's question. Perplexity says it generally ignores robots.txt. |
| `Google-Extended` | Google | training | robots.txt control token for Gemini model use. Does not affect Google Search. |
| `Applebot-Extended` | Apple | training | robots.txt control token that opts content out of Apple's generative-model training. |
| `CCBot` | Common Crawl | training | Builds the Common Crawl archive, which is widely used as AI training data. |
| `Bytespider` | ByteDance | training | ByteDance crawler, widely reported to collect LLM training data. |
| `Meta-ExternalAgent` | Meta | training | Crawls for uses such as training Meta's AI models. |

"Training" bots are reported for information only. Blocking them is a legitimate choice and does not take you out of AI search answers. If you notice a stale fact, please open an issue or PR against the data file.

## Limitations

- **This checks technical readiness only. It does not measure whether AI engines actually cite you.** A perfect score means crawlers can reach and read the homepage. It says nothing about whether answers mention your brand.
- Only the homepage (after redirects) is checked. It does not crawl the whole site.
- robots.txt rules are a request, not enforcement. Some user-initiated fetchers say they don't always follow them. The tool reports what your rules say, not what any crawler actually does.
- WAF and CDN bot rules (for example Cloudflare's AI-bot blocking) can block crawlers that robots.txt allows. This tool sends its own User-Agent, so it can't see rules that target a specific bot.
- HTML is read with lightweight regex parsing, and JavaScript is not executed. That matches what most AI crawlers see, but it isn't a full browser render.
- The thresholds (title length, word count, response time) are pragmatic heuristics, not published limits from any engine.

To see whether ChatGPT and Perplexity actually cite your brand, try Citelane (https://citelane.app).

## Development

```bash
node --test        # runs the whole suite against a local HTTP fixture server, no network needed
node bin/cli.js https://example.com
```

## License

MIT © 2026 Jack Ships
