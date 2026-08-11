interface ShellAssets {
  css: string;
  client: string;
}

const NAV_ITEMS = [
  ['overview', 'Overview', 'nav.overview'],
  ['inventory', 'Inventory', 'nav.inventory'],
  ['discover', 'Discover', 'nav.discover'],
  ['drift', 'Drift', 'nav.drift'],
  ['activity', 'Activity', 'nav.activity'],
] as const;

function renderNav(): string {
  return NAV_ITEMS.map(
    ([view, label, key]) =>
      `<a class="nav-link" href="#${view}" data-nav-view="${view}"><span aria-hidden="true" class="nav-mark"></span><span data-i18n="${key}">${label}</span></a>`,
  ).join('\n');
}

export function renderShell({ css, client }: ShellAssets): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Fleet</title>
<style>${css}</style>
<script>${client}</script>
</head>
<body>
<div class="app-shell">
  <aside class="rail" aria-label="Fleet navigation" data-i18n-aria="a11y.navigation">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z" stroke-width="1.6"/>
        <circle cx="12" cy="12" r="2.6"/>
      </svg>
      <div><strong>Fleet</strong><span data-i18n="brand.control">Capability control</span></div>
    </div>
    <div class="safety-state"><span class="status-dot good" aria-hidden="true"></span><span><strong data-i18n="safety.active">Safety active</strong><small data-i18n="safety.preview">Preview before apply</small></span></div>
    <nav class="view-nav" aria-label="Fleet views" data-i18n-aria="a11y.views">
${renderNav()}
    </nav>
  </aside>

  <div class="workspace">
    <header class="topbar">
      <div class="view-heading"><span class="eyebrow" data-i18n="brand.console">Fleet console</span><strong id="current-view-title">Overview</strong></div>
      <label class="search-field" for="global-search">
        <span class="visually-hidden" data-i18n="search.fleet">Search Fleet</span>
        <span aria-hidden="true">⌕</span>
        <input id="global-search" type="search" placeholder="Search Fleet" data-i18n-placeholder="search.fleet" autocomplete="off" aria-describedby="search-note">
      </label>
      <span id="search-note" class="visually-hidden" data-i18n="search.note">Search Inventory or Discover locally by the public metadata shown in each view.</span>
      <div class="top-actions">
        <label class="language-control"><span class="visually-hidden" data-i18n="language.label">Language</span><select id="language" aria-label="Language" data-i18n-aria="language.label"><option value="en">English</option><option value="ko">한국어</option></select></label>
        <button id="theme" type="button" aria-label="Switch to light theme">Light theme</button>
        <button id="rollback" type="button" data-i18n="nav.activity">Activity</button>
        <button id="refresh" class="primary" type="button" data-i18n="action.refresh">Refresh</button>
      </div>
    </header>

    <main id="app-main" tabindex="-1">
      <section class="view" data-view="overview" aria-labelledby="view-overview-heading">
        <div class="view-intro"><div><span class="eyebrow" data-i18n="overview.eyebrow">Current state</span><h1 id="view-overview-heading" tabindex="-1" data-i18n="nav.overview">Overview</h1></div><p data-i18n="overview.intro">Operational entry point for your connected agent fleet.</p></div>
        <div class="summary-grid" aria-label="Fleet summary" data-i18n-aria="overview.summary">
          <article class="metric"><span data-i18n="metric.agents">Detected / present agents</span><strong id="metric-agents">—</strong></article>
          <article class="metric"><span data-i18n="metric.instances">Capability instances</span><strong id="metric-instances">—</strong></article>
          <article class="metric"><span data-i18n="metric.keys">Unique capability keys</span><strong id="metric-keys">—</strong></article>
          <article class="metric"><span data-i18n="metric.updates">Updates</span><strong id="metric-updates">—</strong></article>
          <article class="metric"><span data-i18n="metric.drift">Drift findings</span><strong id="metric-drift">—</strong></article>
        </div>
        <div class="overview-layout">
          <article class="card fleet-map-card">
            <div class="card-heading"><div><span class="eyebrow" data-i18n="map.eyebrow">Server-reported state</span><h2 data-i18n="map.title">Capability fleet map</h2></div>
              <div class="kind-filters" role="group" aria-label="Filter capabilities by kind" data-i18n-aria="map.filter">
                <button type="button" data-kind-filter="all" aria-pressed="true" data-i18n="filter.all">All</button>
                <button type="button" data-kind-filter="mcp-server" aria-pressed="false">MCP</button>
                <button type="button" data-kind-filter="skill" aria-pressed="false" data-i18n="kind.skills">Skills</button>
                <button type="button" data-kind-filter="rule" aria-pressed="false" data-i18n="kind.rules">Rules</button>
                <button type="button" data-kind-filter="plugin" aria-pressed="false" data-i18n="kind.plugins">Plugins</button>
                <button type="button" data-kind-filter="read-only" aria-pressed="false" data-i18n="management.read-only">Read-only</button>
              </div>
            </div>
            <div class="overflow-region" tabindex="0" role="region" aria-label="Capability fleet map table" data-i18n-aria="map.table"><div id="capability-map" class="placeholder" data-i18n="loading.map">Loading capability map…</div></div>
            <div class="state-legend" aria-label="Fleet map legend" data-i18n-aria="map.legend">
              <span data-i18n="state.installed">Installed</span><span data-i18n="state.missing">Missing</span><span data-i18n="state.disabled">Disabled</span><span data-i18n="state.unavailable">Unavailable</span><span data-i18n="state.unsupported">Unsupported</span><span data-i18n="state.unverifiable">Unverifiable</span>
              <span data-coverage-label="all-present" data-i18n="coverage.all-present">All present</span><span data-i18n="coverage.gap">Gap</span><span data-i18n="coverage.agent-only">Agent only</span>
            </div>
          </article>
          <aside class="card attention-card"><span class="eyebrow" data-i18n="attention.eyebrow">Updates and signals</span><h2 data-i18n="attention.title">Needs attention</h2><div id="attention" class="placeholder" data-i18n="loading.attention">Loading attention items…</div></aside>
        </div>
      </section>

      <section class="view" data-view="inventory" aria-labelledby="view-inventory-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow" data-i18n="inventory.eyebrow">Connected capabilities</span><h1 id="view-inventory-heading" tabindex="-1" data-i18n="nav.inventory">Inventory</h1></div><p data-i18n="inventory.intro">Inspect capabilities reported by each present agent.</p></div>
        <article class="card"><h2 data-i18n="inventory.title">Capability inventory</h2><div class="overflow-region" tabindex="0" role="region" aria-label="Capability inventory table" data-i18n-aria="inventory.table"><div id="inventory" class="placeholder" data-i18n="loading.inventory">Loading capability inventory…</div></div></article>
      </section>

      <section class="view" data-view="discover" aria-labelledby="view-discover-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow" data-i18n="discover.eyebrow">Registry sources</span><h1 id="view-discover-heading" tabindex="-1" data-i18n="nav.discover">Discover</h1></div><p data-i18n="discover.intro">Review available capabilities before choosing an action.</p></div>
        <div class="placeholder-grid"><article class="card"><h2 data-i18n="kind.mcpServers">MCP servers</h2><div id="recommended" class="placeholder" data-i18n="loading.discovery">Discovery results will appear here.</div></article><article class="card"><h2 data-i18n="discover.skillsPlugins">Skills and plugins</h2><div id="recskills" class="placeholder" data-i18n="loading.registry">Registry results will appear here.</div><div id="recplugins"></div></article></div>
      </section>

      <section class="view" data-view="drift" aria-labelledby="view-drift-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow" data-i18n="drift.eyebrow">Configuration signals</span><h1 id="view-drift-heading" tabindex="-1" data-i18n="nav.drift">Drift</h1></div><p data-i18n="drift.intro">Review differences and conflicts before making changes.</p></div>
        <article class="card"><h2 data-i18n="drift.title">Detected drift</h2><div id="conflicts" class="placeholder" data-i18n="loading.drift">Drift findings will appear here.</div></article>
      </section>

      <section class="view" data-view="activity" aria-labelledby="view-activity-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow" data-i18n="activity.eyebrow">Audit trail</span><h1 id="view-activity-heading" tabindex="-1" data-i18n="nav.activity">Activity</h1></div><p data-i18n="activity.intro">Review Fleet operations and their outcomes.</p></div>
        <article class="card"><h2 data-i18n="activity.title">Recent activity</h2><div class="placeholder" data-i18n="loading.activity">Activity records will appear here.</div></article>
      </section>
    </main>
  </div>
</div>

<div id="overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>
  <div id="preview" class="dialog-panel">
    <h2 id="dialog-title" data-i18n="dialog.confirmAction">Confirm action</h2>
    <div id="dialog-content"></div>
    <div class="dialog-actions"><button id="dialog-cancel" type="button" data-i18n="action.cancel">Cancel</button><button id="dialog-confirm" class="primary" type="button" data-i18n="action.confirm">Confirm</button></div>
  </div>
</div>
<div id="err" class="live-region" role="status" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;
}
