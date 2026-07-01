import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Local-web security: the dashboard binds to loopback and is guarded by a
 * per-run session token + Host/Origin checks. This blocks the real threats for
 * a write-capable local daemon — a drive-by web page fetching localhost, and
 * DNS-rebinding (attacker domain resolving to 127.0.0.1). Read-only in Part 2,
 * but locked down now so Part 3's writes inherit it.
 */

export function makeToken(): string {
  return randomBytes(24).toString('hex');
}

/** Constant-time token compare. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Host header must be loopback on the port we're actually listening on, OR an
 * explicitly-allowed host (e.g. a Tailscale MagicDNS name / 100.x IP). Exact
 * match only — this is the anti-DNS-rebinding pin, so no wildcards.
 */
/** Normalize a host for comparison: lowercase + strip a single trailing dot. */
function norm(h: string): string {
  return h.toLowerCase().replace(/\.$/, '');
}
function inAllow(host: string, allowHosts: string[]): boolean {
  const h = norm(host);
  return allowHosts.some((a) => norm(a) === h);
}

export function checkHost(host: string | undefined, port: number, allowHosts: string[] = []): boolean {
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  return !!host && inAllow(host, allowHosts);
}

/** If an Origin is present (cross-site fetch), it must be our loopback origin or an allowed host. */
export function checkOrigin(origin: string | undefined, port: number, allowHosts: string[] = []): boolean {
  if (!origin) return true; // top-level GET navigations send no Origin
  try {
    const u = new URL(origin);
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(port)) return true;
    return inAllow(u.host, allowHosts);
  } catch {
    return false;
  }
}

/** Token from the Authorization: Bearer header ONLY (required for mutations). */
export function tokenFromHeader(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/** Token from Authorization: Bearer, else the ?token= query param (GET / initial page load). */
export function tokenFromReq(req: IncomingMessage, port: number): string | undefined {
  const h = tokenFromHeader(req);
  if (h) return h;
  try {
    return new URL(req.url ?? '/', `http://127.0.0.1:${port}`).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
