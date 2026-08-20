import { latestDelegatedRollbackBoundary, readDelegatedLedger } from './delegate.js';
import { latestRollbackCandidate, type AuditReadResult, type RollbackGuardRefusal } from './writer.js';

/**
 * Cross-ledger guard for implicit rollback. Call this only through
 * writer.rollback({ implicitGuard }), which evaluates it while the shared
 * mutation lock is held. Keeping the reads and the eventual filesystem undo
 * in one critical section closes the delegated-action TOCTOU window.
 */
export async function assessImplicitRollback(
  audit: AuditReadResult,
  fleetHome?: string,
): Promise<RollbackGuardRefusal | undefined> {
  const ledger = await readDelegatedLedger(fleetHome);
  if (ledger.status === 'malformed' || ledger.status === 'unavailable') {
    return {
      reasonCode: 'DELEGATED_HISTORY_UNVERIFIABLE',
      recoveryClass: 'vendor-state-inspection',
    };
  }
  if (ledger.records.some((record) => record.pending)) {
    return {
      reasonCode: 'DELEGATED_OUTCOME_PENDING',
      recoveryClass: 'vendor-state-inspection',
    };
  }

  const delegated = latestDelegatedRollbackBoundary(ledger.records);
  const delegatedTs = delegated ? Date.parse(delegated.time) : Number.NaN;
  const newestEligibleCoreTs = latestRollbackCandidate(audit.records)?.ts ?? Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(delegatedTs) || delegatedTs < newestEligibleCoreTs) return undefined;

  if (delegated?.exitCode === 0 && delegated.effect === 'changed') {
    return {
      reasonCode: 'LATEST_CHANGE_DELEGATED',
      suggestedTool: delegated.op === 'install' ? 'plugin_remove' : 'plugin_install',
    };
  }
  return {
    reasonCode: 'LATEST_CHANGE_DELEGATED',
    recoveryClass: 'vendor-state-inspection',
  };
}
