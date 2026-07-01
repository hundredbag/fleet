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

/** Host header must be loopback on the port we're actually listening on (anti DNS-rebinding). */
export function checkHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** If an Origin is present (cross-site fetch), it must be our own loopback origin. */
export function checkOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // top-level GET navigations send no Origin
  try {
    const u = new URL(origin);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(port);
  } catch {
    return false;
  }
}

/** Token from Authorization: Bearer, else the ?token= query param (initial page load). */
export function tokenFromReq(req: IncomingMessage, port: number): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  try {
    return new URL(req.url ?? '/', `http://127.0.0.1:${port}`).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
