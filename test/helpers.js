import { createServer } from 'node:http';

/**
 * Start a local HTTP server from a route table: { '/path': { status, headers, body, delayMs } | (req) => route }.
 * Unknown paths return 404. Returns { url, close }.
 */
export async function startServer(routes) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let route = routes[path];
    if (typeof route === 'function') route = route(req);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    res.writeHead(route.status ?? 200, route.headers ?? { 'content-type': 'text/plain; charset=utf-8' });
    res.end(route.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const html = (body) => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body });

export const WORDS = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
