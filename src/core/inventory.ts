import type { AgentAdapter } from './adapter.js';
import type { Inventory, DetectedAgent, InstalledCapability } from './types.js';

/**
 * Build the unified cross-agent inventory by asking every adapter to detect
 * itself and (if present) read its installed capabilities. A failing adapter
 * degrades to a note instead of breaking the whole snapshot.
 */
export async function buildInventory(
  adapters: AgentAdapter[],
): Promise<Inventory> {
  const agents: DetectedAgent[] = [];
  const items: InstalledCapability[] = [];

  for (const adapter of adapters) {
    const detected = await adapter.detect();
    if (detected.present) {
      try {
        items.push(...(await adapter.readInventory()));
      } catch (err) {
        detected.note = `read error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    agents.push(detected);
  }

  return { agents, items };
}
