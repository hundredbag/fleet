import { FleetOperationError } from './errors.js';
import type { InstalledCapability, PrimitiveKind, Scope } from './types.js';

export const SUPPORTED_SCOPES: readonly Scope[] = ['user', 'project', 'local'];

export function parseScope(value: unknown, label = 'scope'): Scope | undefined {
  if (value === undefined) return undefined;
  if (value === 'user' || value === 'project' || value === 'local') return value;
  throw new FleetOperationError('INVALID_ARGUMENT', `${label} is invalid`);
}

/** Current built-in writers own only user-level destinations. Refuse before
 * rendering so audit/lock scope can never disagree with the file actually
 * changed by an adapter. */
export function assertWritableScope(scope: Scope): void {
  if (scope !== 'user') {
    throw new FleetOperationError(
      'UNSUPPORTED_OPERATION',
      `scope '${scope}' is read-only; only user scope is writable`,
    );
  }
}

/** Select one exact scoped capability. Fleet has no active project context and
 * therefore never invents vendor precedence between user/project/local rows.
 * A caller must name the scope whenever more than one candidate exists. */
export function selectScopedCapability(
  items: InstalledCapability[],
  selector: { agent: string; kind: PrimitiveKind; name: string; scope?: Scope },
): InstalledCapability | undefined {
  const matches = items.filter(
    (item) =>
      item.agent === selector.agent &&
      item.kind === selector.kind &&
      item.name === selector.name &&
      (selector.scope === undefined || item.scope === selector.scope),
  );
  if (matches.length > 1) {
    throw new FleetOperationError(
      'INVALID_ARGUMENT',
      selector.scope === undefined
        ? `capability exists in multiple scopes; specify scope`
        : `capability scope identifies multiple configuration contexts`,
    );
  }
  return matches[0];
}
