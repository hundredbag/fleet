/**
 * Defensive coercion helpers for parsing untrusted config (JSON/TOML).
 * Config values arrive as `unknown`; these return a typed value only when the
 * shape actually matches, so a malformed field degrades to `undefined` instead
 * of propagating a lying type into specs / `--json` / future write-back.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as string[])
    : undefined;
}

export function asStringRecord(
  v: unknown,
): Record<string, string> | undefined {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.every(([, x]) => typeof x === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}
