import type { AgentAdapter } from './adapter.js';
import type { Inventory, InventoryAgent, InstalledCapability } from './types.js';

/**
 * Build the unified cross-agent inventory by asking every adapter to detect
 * itself and (if present) read its installed capabilities. A failing adapter
 * degrades to a note instead of breaking the whole snapshot.
 */
export async function buildInventory(adapters: AgentAdapter[]): Promise<Inventory> {
  // adapters are independent — read them in PARALLEL, and isolate detect()
  // failures too (a throwing detect used to abort the whole snapshot)
  const per = await Promise.all(
    adapters.map(async (adapter) => {
      let detected: InventoryAgent;
      try {
        const result = await adapter.detect();
        detected = { ...result, inventoryStatus: result.present ? 'ok' : 'not-present' };
      } catch (err) {
        return {
          detected: {
            id: adapter.id,
            displayName: adapter.displayName,
            present: false,
            configPaths: [],
            note: `detect error: ${err instanceof Error ? err.message : String(err)}`,
            inventoryStatus: 'detect-failed',
          } satisfies InventoryAgent,
          items: [] as InstalledCapability[],
        };
      }
      if (!detected.present) return { detected, items: [] as InstalledCapability[] };
      try {
        return { detected, items: await adapter.readInventory() };
      } catch (err) {
        detected.note = `read error: ${err instanceof Error ? err.message : String(err)}`;
        detected.inventoryStatus = 'read-failed';
        return { detected, items: [] as InstalledCapability[] };
      }
    }),
  );
  return { agents: per.map((p) => p.detected), items: per.flatMap((p) => p.items) };
}
