import { createHash } from 'node:crypto';

/** Stable content hash used to detect concurrent edits and verify rollbacks. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
