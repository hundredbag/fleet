interface ShellAssets {
  css: string;
  client: string;
}

const NAV_ITEMS = [
  ['overview', 'Overview'],
  ['inventory', 'Inventory'],
  ['discover', 'Discover'],
  ['drift', 'Drift'],
  ['activity', 'Activity'],
] as const;

function renderNav(): string {
  return NAV_ITEMS.map(
    ([view, label]) =>
      `<a class="nav-link" href="#${view}" data-nav-view="${view}"><span aria-hidden="true" class="nav-mark"></span><span>${label}</span></a>`,
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
  <aside class="rail" aria-label="Fleet navigation">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z" stroke-width="1.6"/>
        <circle cx="12" cy="12" r="2.6"/>
      </svg>
      <div><strong>Fleet</strong><span>Capability control</span></div>
    </div>
    <div class="safety-state"><span class="status-dot good" aria-hidden="true"></span><span><strong>Safety active</strong><small>Preview before apply</small></span></div>
    <nav class="view-nav" aria-label="Fleet views">
${renderNav()}
    </nav>
  </aside>

  <div class="workspace">
    <header class="topbar">
      <div class="view-heading"><span class="eyebrow">Fleet console</span><strong id="current-view-title">Overview</strong></div>
      <label class="search-field" for="global-search">
        <span class="visually-hidden">Search Fleet</span>
        <span aria-hidden="true">⌕</span>
        <input id="global-search" type="search" placeholder="Search Fleet" autocomplete="off" aria-describedby="search-note">
      </label>
      <span id="search-note" class="visually-hidden">Search filtering is not available yet.</span>
      <div class="top-actions">
        <label class="language-control"><span class="visually-hidden">Language</span><select id="language" aria-label="Language" disabled><option>English</option></select></label>
        <button id="theme" type="button" aria-label="Switch to light theme">Light theme</button>
        <button id="rollback" type="button">Rollback</button>
        <button id="refresh" class="primary" type="button">Refresh</button>
      </div>
    </header>

    <main id="app-main" tabindex="-1">
      <section class="view" data-view="overview" aria-labelledby="view-overview-heading">
        <div class="view-intro"><div><span class="eyebrow">Current state</span><h1 id="view-overview-heading" tabindex="-1">Overview</h1></div><p>Operational entry point for your connected agent fleet.</p></div>
        <div class="placeholder-grid">
          <article class="card"><h2>Fleet status</h2><p>Refresh to verify access to Fleet data sources.</p></article>
          <article class="card"><h2>Updates</h2><div id="updates" class="placeholder">Update details will appear in this view.</div></article>
        </div>
      </section>

      <section class="view" data-view="inventory" aria-labelledby="view-inventory-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow">Connected capabilities</span><h1 id="view-inventory-heading" tabindex="-1">Inventory</h1></div><p>Inspect capabilities reported by each present agent.</p></div>
        <article class="card"><h2>Capability inventory</h2><div class="overflow-region" tabindex="0" role="region" aria-label="Capability inventory table"><div id="inventory" class="placeholder">Inventory data is ready for the capability map.</div></div></article>
      </section>

      <section class="view" data-view="discover" aria-labelledby="view-discover-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow">Registry sources</span><h1 id="view-discover-heading" tabindex="-1">Discover</h1></div><p>Review available capabilities before choosing an action.</p></div>
        <div class="placeholder-grid"><article class="card"><h2>MCP servers</h2><div id="recommended" class="placeholder">Discovery results will appear here.</div></article><article class="card"><h2>Skills and plugins</h2><div id="recskills" class="placeholder">Registry results will appear here.</div><div id="recplugins"></div></article></div>
      </section>

      <section class="view" data-view="drift" aria-labelledby="view-drift-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow">Configuration signals</span><h1 id="view-drift-heading" tabindex="-1">Drift</h1></div><p>Review differences and conflicts before making changes.</p></div>
        <article class="card"><h2>Detected drift</h2><div id="conflicts" class="placeholder">Drift findings will appear here.</div></article>
      </section>

      <section class="view" data-view="activity" aria-labelledby="view-activity-heading" hidden>
        <div class="view-intro"><div><span class="eyebrow">Audit trail</span><h1 id="view-activity-heading" tabindex="-1">Activity</h1></div><p>Review Fleet operations and their outcomes.</p></div>
        <article class="card"><h2>Recent activity</h2><div class="placeholder">Activity records will appear here.</div></article>
      </section>
    </main>
  </div>
</div>

<div id="overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>
  <div id="preview" class="dialog-panel">
    <h2 id="dialog-title">Confirm action</h2>
    <div id="dialog-content"></div>
    <div class="dialog-actions"><button id="dialog-cancel" type="button">Cancel</button><button id="dialog-confirm" class="primary" type="button">Confirm</button></div>
  </div>
</div>
<div id="err" class="live-region" role="status" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;
}
