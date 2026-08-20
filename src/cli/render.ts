import type { DetectedAgent, Inventory, InstalledCapability, PermissionCapability } from '../core/types.js';
import { MARKETPLACE_RE } from '../core/plugin-coordinate.js';

const SCOPE_TAG: Record<string, string> = { user: 'U', project: 'P', local: 'L' };

/** Fixed public warning for a vendor mutation whose fleet.lock fold failed.
 * The raw filesystem error stays out of the normal CLI result. */
export function renderProvenanceWarning(hasWarning: boolean): string {
  return hasWarning
    ? '  ⚠ PROVENANCE_WARNING: plugin state changed, but fleet.lock was not updated; inspect fleet doctor and lock state.\n'
    : '';
}

/** Render the unified inventory as human-friendly capability × agent matrices. */
export function renderInventory(inv: Inventory): string {
  const out: string[] = [];
  out.push('fleet — unified agent capability inventory');
  out.push('');

  out.push('Detected agents:');
  for (const a of inv.agents) {
    const dot = a.present ? '●' : '○';
    const setupNote: Record<string, string> = {
      ready: 'ready',
      'installed-unconfigured': 'runtime installed; configuration not initialized',
      'configured-runtime-missing': 'configuration found; runtime executable missing',
      'configured-runtime-unverifiable': 'configuration found; runtime could not be verified',
      'not-detected': 'not detected',
      'detection-unavailable': 'detection unavailable',
      'configuration-unavailable': 'configuration unavailable',
      'inventory-unavailable': 'inventory unavailable',
    };
    const diagnostic = a.note ?? (a.setupStatus ? setupNote[a.setupStatus] : undefined);
    const note = diagnostic ? `  — ${diagnostic}` : '';
    out.push(`  ${dot} ${a.displayName} [${a.id}]${note}`);
  }
  out.push('');

  const present = inv.agents.filter((a) => a.present);
  if (present.length === 0) {
    out.push('No managed agents detected on this machine.');
    return out.join('\n');
  }

  out.push(
    renderSection(
      'MCP servers',
      inv.items.filter((i) => i.kind === 'mcp-server'),
      present,
    ),
  );
  out.push('');
  out.push(
    renderSection(
      'Skills',
      inv.items.filter((i) => i.kind === 'skill'),
      present,
    ),
  );
  out.push('');
  out.push(
    renderSection(
      'Rules',
      inv.items.filter((i) => i.kind === 'rule'),
      present,
    ),
  );
  out.push('');
  out.push(
    renderSection(
      'Plugins (read-only)',
      inv.items.filter((i) => i.kind === 'plugin'),
      present,
      undefined,
      (item) =>
        'marketplace' in item && typeof item.marketplace === 'string' && MARKETPLACE_RE.test(item.marketplace)
          ? `${item.name}@${item.marketplace}`
          : item.name,
    ),
  );
  out.push('');
  out.push(
    renderSection(
      'Subagents (read-only)',
      inv.items.filter((i) => i.kind === 'subagent'),
      present,
    ),
  );
  out.push('');
  out.push(
    renderSection(
      'Permissions (read-only)',
      inv.items.filter((i) => i.kind === 'permission'),
      present,
      // show the effect (allow/deny/ask/policy), not a presence tick — a deny
      // must not look like an allow.
      (found) => [...new Set(found.map((f) => (f as PermissionCapability).effect))].join(','),
    ),
  );
  out.push('');
  out.push('  legend: ✓ detected · ✗ disabled (U=user P=project L=local) · – not detected');
  return out.join('\n');
}

function renderSection(
  label: string,
  items: InstalledCapability[],
  present: DetectedAgent[],
  markOf?: (found: InstalledCapability[]) => string,
  identityOf: (item: InstalledCapability) => string = (item) => item.name,
): string {
  if (items.length === 0) {
    return `${label}: none on any detected agent yet.`;
  }
  const names = [...new Set(items.map(identityOf))].sort();
  const cols = present.map((a) => a.id);
  const header = [`capability (${label})`, ...present.map((a) => a.displayName)];

  const cell = (name: string, agentId: string): string => {
    const found = items.filter((m) => identityOf(m) === name && m.agent === agentId);
    if (found.length === 0) return '–';
    if (markOf) return markOf(found);
    const scopeCounts = new Map<string, number>();
    for (const item of found) {
      const tag = SCOPE_TAG[item.scope] ?? '?';
      scopeCounts.set(tag, (scopeCounts.get(tag) ?? 0) + 1);
    }
    const scopes = [...scopeCounts].map(([tag, count]) => `${tag}${count > 1 ? `×${count}` : ''}`).join('');
    const mark = found.every((f) => !f.enabled) ? '✗' : '✓';
    return `${mark}${scopes}`;
  };

  const rows = names.map((n) => [n, ...cols.map((c) => cell(n, c))]);
  return renderTable(header, rows);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  const sep = '  ' + widths.map((w) => '─'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}
