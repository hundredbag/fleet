import type { Inventory } from '../core/types.js';

const SCOPE_TAG: Record<string, string> = { user: 'U', project: 'P', local: 'L' };

/** Render the unified inventory as a human-friendly capability × agent matrix. */
export function renderInventory(inv: Inventory): string {
  const out: string[] = [];
  out.push('fleet — unified agent capability inventory (v0 · MCP servers)');
  out.push('');

  out.push('Detected agents:');
  for (const a of inv.agents) {
    const dot = a.present ? '●' : '○';
    const note = a.note ? `  — ${a.note}` : '';
    out.push(`  ${dot} ${a.displayName} [${a.id}]${note}`);
  }
  out.push('');

  const mcp = inv.items.filter((i) => i.kind === 'mcp-server');
  const present = inv.agents.filter((a) => a.present);

  if (present.length === 0) {
    out.push('No managed agents detected on this machine.');
    return out.join('\n');
  }

  if (mcp.length === 0) {
    out.push('MCP servers: none configured on any detected agent yet.');
    out.push('');
    out.push('  The read path works — this empty state is exactly where');
    out.push('  one-click install / cross-agent sync will add value.');
    return out.join('\n');
  }

  const names = [...new Set(mcp.map((m) => m.name))].sort();
  const cols = present.map((a) => a.id);
  const header = ['capability (MCP)', ...present.map((a) => a.displayName)];

  const cell = (name: string, agentId: string): string => {
    const found = mcp.filter((m) => m.name === name && m.agent === agentId);
    if (found.length === 0) return '–';
    const scopes = [...new Set(found.map((f) => SCOPE_TAG[f.scope] ?? '?'))].join('');
    const mark = found.every((f) => !f.enabled) ? '✗' : '✓';
    return `${mark}${scopes}`;
  };

  const rows = names.map((n) => [n, ...cols.map((c) => cell(n, c))]);
  out.push(renderTable(header, rows));
  out.push('');
  out.push(
    '  legend: ✓ installed · ✗ disabled (U=user P=project L=local) · – not installed',
  );
  return out.join('\n');
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]) =>
    '  ' + cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  const sep = '  ' + widths.map((w) => '─'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}
