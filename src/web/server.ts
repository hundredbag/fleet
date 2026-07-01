import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentAdapter } from '../core/adapter.js';
import type { FeedSource } from '../feed/source.js';
import { makeToken, tokenMatches, checkHost, checkOrigin, tokenFromReq } from './security.js';
import { apiInventory, apiFeed, apiConflicts } from './api.js';
import { renderPage } from './ui.js';

/**
 * The local web dashboard daemon — a thin, co-equal face over core. Read-only
 * (Part 2); loopback-bound and token-gated so Part 3's writes inherit the guard.
 */
export interface ServeOpts {
  port?: number;
  host?: string;
  token?: string;
  /** injectable feed sources (tests); defaults to the live sources */
  sources?: FeedSource[];
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return; // never double-send
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function createFleetServer(adapters: AgentAdapter[], opts: ServeOpts = {}) {
  const token = opts.token ?? makeToken();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Use the actual bound port for checks so ephemeral (:0) test binds work too.
    const port = req.socket.localPort ?? 0;
    if (!checkHost(req.headers.host, port)) return sendJson(res, 403, { error: 'bad host' });
    if (!checkOrigin(req.headers.origin, port)) return sendJson(res, 403, { error: 'bad origin' });
    if (!tokenMatches(tokenFromReq(req, port), token)) return sendJson(res, 401, { error: 'unauthorized' });

    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

    switch (path) {
      case '/':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': CSP,
        });
        res.end(renderPage());
        return;
      case '/api/inventory':
        return sendJson(res, 200, await apiInventory(adapters));
      case '/api/feed':
        return sendJson(res, 200, await apiFeed(adapters, opts.sources));
      case '/api/conflicts':
        return sendJson(res, 200, await apiConflicts(adapters));
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  }

  return { server, token };
}

/** Start the dashboard and print the tokenized URL. Returns the http server. */
export function startFleetServer(adapters: AgentAdapter[], opts: ServeOpts = {}) {
  const port = opts.port ?? 7777;
  const host = opts.host ?? '127.0.0.1';
  const { server, token } = createFleetServer(adapters, opts);
  server.on('error', (e: NodeJS.ErrnoException) => {
    process.stderr.write(
      e.code === 'EADDRINUSE'
        ? `fleet serve: port ${port} is already in use (try --port <n>)\n`
        : `fleet serve: ${e.message}\n`,
    );
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const shown = typeof addr === 'object' && addr ? addr.port : port;
    process.stdout.write(`fleet dashboard → http://127.0.0.1:${shown}/?token=${token}\n`);
    process.stdout.write('(read-only; loopback + token-gated; Ctrl-C to stop)\n');
  });
  return server;
}
