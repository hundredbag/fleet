import type { AgentAdapter } from './adapter.js';

/**
 * "Bring your own agent": load third-party AgentAdapters listed in config
 * (`adapterModules`) without forking. Each module is dynamically imported; its
 * default export must be an AgentAdapter, or a (possibly async) factory that
 * returns one. Loading is best-effort — a bad module is skipped with a warning,
 * never crashes fleet. Note: a plugin runs IN-PROCESS (arbitrary code from the
 * user's own config), same trust level as anything else the user installs.
 */
type Importer = (spec: string) => Promise<unknown>;

function isAdapter(x: unknown): x is AgentAdapter {
  const a = x as Partial<AgentAdapter> | null;
  return (
    !!a && typeof a.id === 'string' && typeof a.detect === 'function' && typeof a.readInventory === 'function'
  );
}

async function resolveAdapter(mod: unknown): Promise<AgentAdapter | null> {
  const candidate = (mod as { default?: unknown })?.default ?? mod;
  if (isAdapter(candidate)) return candidate;
  if (typeof candidate === 'function') {
    const inst = await (candidate as () => unknown)();
    if (isAdapter(inst)) return inst;
  }
  return null;
}

export async function loadPluginAdapters(
  modules: string[],
  importer: Importer = (s) => import(s),
): Promise<AgentAdapter[]> {
  if (!modules.length) return [];
  const out: AgentAdapter[] = [];
  for (const spec of modules) {
    try {
      const adapter = await resolveAdapter(await importer(spec));
      if (adapter) out.push(adapter);
      else process.stderr.write(`fleet: plugin '${spec}' does not export an AgentAdapter; skipping\n`);
    } catch (e) {
      process.stderr.write(
        `fleet: failed to load plugin '${spec}': ${e instanceof Error ? e.message : String(e)}; skipping\n`,
      );
    }
  }
  return out;
}
