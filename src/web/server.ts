import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentAdapter } from '../core/adapter.js';
import type { FeedSource } from '../feed/source.js';
import { makeToken, tokenMatches, checkHost, checkOrigin, tokenFromReq, tokenFromHeader } from './security.js';
import { apiInventory, apiFeed, apiConflicts } from './api.js';
import { ActionService } from './actions.js';
import { renderPage } from './ui.js';

/**
 * The local web dashboard daemon — a thin, co-equal face over core. GET is
 * read-only; POST (mutations) is preview→confirm and CSRF-hardened (header-only
 * token, Origin required + matched, application/json only). Loopback-bound.
 */
export interface ServeOpts {
  port?: number;
  host?: string;
  token?: string;
  /** injectable feed sources (tests); defaults to the live sources */
  sources?: FeedSource[];
  /** fleet state dir (backups/audit); defaults to ~/.fleet */
  fleetHome?: string;
  /** extra Host/Origin values to accept (e.g. a Tailscale MagicDNS name). Exact match. */
  allowHosts?: string[];
}

interface HttpError extends Error {
  statusCode?: number;
}
function httpError(message: string, statusCode: number): HttpError {
  const e: HttpError = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/** Read a JSON request body with a hard size cap. Rejects with a statusCode so
 * the caller can answer (413/400) — does NOT destroy the socket. */
function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const fail = (msg: string, code: number) => {
      if (done) return;
      done = true;
      reject(httpError(msg, code));
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail('request body too large', 413);
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const s = Buffer.concat(chunks).toString('utf8').trim();
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(httpError('invalid JSON body', 400));
      }
    });
    req.on('error', (e) => fail(e.message, 400));
  });
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
  const actions = new ActionService(adapters, opts.fleetHome);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Use the actual bound port for checks so ephemeral (:0) test binds work too.
    const port = req.socket.localPort ?? 0;
    const allow = opts.allowHosts ?? [];
    if (!checkHost(req.headers.host, port, allow)) return sendJson(res, 403, { error: 'bad host' });

    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;

    if (req.method === 'GET') {
      if (!checkOrigin(req.headers.origin, port, allow)) return sendJson(res, 403, { error: 'bad origin' });
      if (!tokenMatches(tokenFromReq(req, port), token)) return sendJson(res, 401, { error: 'unauthorized' });
      return handleGet(res, path);
    }

    if (req.method === 'POST') {
      // Stricter CSRF gate for state-changing requests:
      // Origin MUST be present and match; token MUST be in the header (not URL);
      // body MUST be application/json (browsers can't send that cross-site without a preflight).
      if (!req.headers.origin || !checkOrigin(req.headers.origin, port, allow)) {
        return sendJson(res, 403, { error: 'bad origin' });
      }
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { error: 'content-type must be application/json' });
      }
      if (!tokenMatches(tokenFromHeader(req), token)) return sendJson(res, 401, { error: 'unauthorized' });
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const code = (e as HttpError)?.statusCode ?? 400;
        return sendJson(res, code, { error: e instanceof Error ? e.message : 'bad body' });
      }
      return handlePost(res, path, body);
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  }

  function handleGet(res: ServerResponse, path: string): Promise<void> | void {
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
        return apiInventory(adapters).then((r) => sendJson(res, 200, r));
      case '/api/feed':
        return apiFeed(adapters, opts.sources).then((r) => sendJson(res, 200, r));
      case '/api/conflicts':
        return apiConflicts(adapters).then((r) => sendJson(res, 200, r));
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  }

  async function handlePost(res: ServerResponse, path: string, body: unknown): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    try {
      switch (path) {
        case '/api/plan':
          return sendJson(res, 200, await actions.plan(b));
        case '/api/apply':
          return sendJson(res, 200, await actions.apply(b));
        case '/api/rollback':
          return sendJson(res, 200, await actions.rollback());
        default:
          return sendJson(res, 404, { error: 'not found' });
      }
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { server, token };
}

/** Start the dashboard and print the tokenized URL. Returns the http server. */
export function startFleetServer(adapters: AgentAdapter[], opts: ServeOpts = {}) {
  const port = opts.port ?? 7777;
  const host = opts.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost';
  // A direct non-loopback bind must accept its own host:port, or every request 403s.
  const allowHosts = [...(opts.allowHosts ?? [])];
  if (!loopback) allowHosts.push(`${host}:${port}`);
  const { server, token } = createFleetServer(adapters, { ...opts, allowHosts });
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
    if (!loopback) {
      process.stderr.write(
        `⚠ binding to ${host} — reachable beyond this machine. The session token (in the URL) is the ONLY gate:\n` +
          `  keep it private, keep this tailnet-only, and NEVER expose it via 'tailscale funnel'.\n`,
      );
    }
    const base = loopback ? `http://127.0.0.1:${shown}` : `http://${host}:${shown}`;
    process.stdout.write(`fleet dashboard → ${base}/?token=${token}\n`);
    for (const h of opts.allowHosts ?? []) {
      const scheme = /\.ts\.net$/i.test(h) ? 'https' : 'http'; // MagicDNS names answer on HTTPS via 'tailscale serve'
      process.stdout.write(`  also: ${scheme}://${h}/?token=${token}\n`);
    }
    process.stdout.write('(token-gated; the URL is a secret — use only on a single-user tailnet; Ctrl-C to stop)\n');
  });
  return server;
}
