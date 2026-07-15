import type { DetectedAgent, Inventory, InstalledCapability, PermissionCapability } from '../core/types.js';

const SCOPE_TAG: Record<string, string> = { user: 'U', project: 'P', local: 'L' };

/** Render the unified inventory as human-friendly capability × agent matrices. */
export function renderInventory(inv: Inventory): string {
  const out: string[] = [];
  out.push('fleet — unified agent capability inventory');
  out.push('');

  out.push('Detected agents:');
  for (const a of inv.agents) {
    const dot = a.present ? '●' : '○';
    const note = a.note ? `  — ${a.note}` : '';
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
  out.push('  legend: ✓ installed · ✗ disabled (U=user P=project L=local) · – not installed');
  return out.join('\n');
}

function renderSection(
  label: string,
  items: InstalledCapability[],
  present: DetectedAgent[],
  markOf?: (found: InstalledCapability[]) => string,
): string {
  if (items.length === 0) {
    return `${label}: none on any detected agent yet.`;
  }
  const names = [...new Set(items.map((m) => m.name))].sort();
  const cols = present.map((a) => a.id);
  const header = [`capability (${label})`, ...present.map((a) => a.displayName)];

  const cell = (name: string, agentId: string): string => {
    const found = items.filter((m) => m.name === name && m.agent === agentId);
    if (found.length === 0) return '–';
    if (markOf) return markOf(found);
    const scopes = [...new Set(found.map((f) => SCOPE_TAG[f.scope] ?? '?'))].join('');
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
