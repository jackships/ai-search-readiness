import { gunzipSync } from 'node:zlib';

export const DEFAULT_USER_AGENT = 'ai-search-readiness/0.1 (+https://github.com/jackships/ai-search-readiness)';

/**
 * @typedef {object} FetchResult
 * @property {string} url          requested URL
 * @property {string} finalUrl     URL after redirects
 * @property {number} status       final HTTP status (0 on network error)
 * @property {Record<string,string>} headers  final response headers (lower-case names)
 * @property {{url: string, status: number}[]} redirects  each hop that redirected
 * @property {number} timeMs       time to response headers of the final hop
 * @property {number} totalMs      total time including redirects and body
 * @property {string} body         decoded text body (truncated at maxBytes)
 * @property {boolean} truncated
 * @property {string | null} error network/timeout error message
 */

/**
 * GET a URL following redirects manually so every hop is recorded.
 * Never throws: failures are returned in `error`.
 * @param {string} url
 * @param {{ timeoutMs?: number, userAgent?: string, maxRedirects?: number, maxBytes?: number, accept?: string }} [opts]
 * @returns {Promise<FetchResult>}
 */
export async function fetchUrl(url, opts = {}) {
  const { timeoutMs = 10000, userAgent = DEFAULT_USER_AGENT, maxRedirects = 10, maxBytes = 5 * 1024 * 1024, accept = '*/*' } = opts;
  const started = performance.now();
  /** @type {FetchResult} */
  const result = { url, finalUrl: url, status: 0, headers: {}, redirects: [], timeMs: 0, totalMs: 0, body: '', truncated: false, error: null };
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const t0 = performance.now();
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        result.redirects.push({ url: current, status: res.status });
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
        current = new URL(location, current).href;
        continue;
      }
      result.timeMs = Math.round(performance.now() - t0);
      result.finalUrl = current;
      result.status = res.status;
      result.headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
      const { bytes, truncated } = await readLimited(res, maxBytes);
      result.truncated = truncated;
      result.body = decode(bytes, result.headers['content-type']);
      break;
    }
  } catch (err) {
    result.error = describeError(err, timeoutMs);
    result.finalUrl = current;
  }
  result.totalMs = Math.round(performance.now() - started);
  return result;
}

async function readLimited(res, maxBytes) {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return { bytes: out, truncated };
}

function decode(bytes, contentType = '') {
  let buf = bytes;
  // A ".xml.gz" sitemap is served as raw gzip bytes (no Content-Encoding), so unzip it here.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf);
    } catch {
      /* keep raw bytes */
    }
  }
  const charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function describeError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? err);
}
