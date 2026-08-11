export const DASHBOARD_CSS = `
  :root {
    color-scheme:dark;
    --bg:#080d12; --surface:#0d141a; --surface-raised:#111a22; --border:#1d2730;
    --text:#e7edf3; --muted:#82909c; --accent:#2bd4c0; --accent-ink:#05211d;
    --good:#44d28b; --warn:#e0a83a; --danger:#f2555a; --focus:#35e6d1;
    --action-bg:var(--accent); --muted-on-bg:var(--muted);
    --shadow:rgba(0,0,0,.38); --hover:rgba(255,255,255,.045);
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    --mono:ui-monospace,'SFMono-Regular',Consolas,monospace;
  }
  [data-theme="light"] {
    color-scheme:light;
    --bg:#f4f7f7; --surface:#ffffff; --surface-raised:#fbfcfc; --border:#dfe6e5;
    --text:#172222; --muted:#657572; --accent:#0d9488; --accent-ink:#ffffff;
    --good:#168b69; --warn:#a86914; --danger:#c83f45; --focus:#006b63;
    --action-bg:#08736b; --muted-on-bg:#596966;
    --shadow:rgba(20,40,40,.1); --hover:rgba(13,148,136,.06);
  }
  * { box-sizing:border-box; }
  html { background:var(--bg); }
  body { margin:0; min-width:280px; background:var(--bg); color:var(--text); font:14px/1.55 var(--sans); }
  button, input, select { font:inherit; }
  button, select {
    min-height:38px; border:1px solid var(--border); border-radius:8px; background:var(--surface-raised);
    color:var(--text); padding:7px 12px;
  }
  button { cursor:pointer; font-weight:650; }
  button:hover { border-color:var(--accent); background:var(--hover); }
  button.primary { border-color:var(--action-bg); background:var(--action-bg); color:var(--accent-ink); }
  button.primary:hover { filter:brightness(1.06); }
  select:disabled { cursor:not-allowed; color:var(--muted); opacity:1; }
  :focus-visible { outline:3px solid var(--focus); outline-offset:3px; }
  [hidden] { display:none !important; }
  .visually-hidden { position:absolute!important; width:1px!important; height:1px!important; padding:0!important; margin:-1px!important; overflow:hidden!important; clip:rect(0,0,0,0)!important; white-space:nowrap!important; border:0!important; }

  .app-shell { min-height:100vh; display:grid; grid-template-columns:224px minmax(0,1fr); }
  .rail {
    position:sticky; top:0; height:100vh; z-index:20; display:flex; flex-direction:column; gap:22px;
    padding:22px 16px; background:var(--surface); border-right:1px solid var(--border);
  }
  .brand { display:flex; align-items:center; gap:11px; min-width:0; }
  .brand .mark { width:29px; height:29px; flex:none; filter:drop-shadow(0 0 10px var(--focus)); }
  .brand .mark path { stroke:var(--accent); fill:color-mix(in srgb,var(--accent) 12%,transparent); }
  .brand .mark circle { fill:var(--accent); }
  .brand strong { display:block; font-size:18px; letter-spacing:-.02em; }
  .brand span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.09em; }
  .safety-state { display:flex; gap:9px; align-items:flex-start; padding:11px; border:1px solid var(--border); border-radius:10px; background:var(--surface-raised); }
  .safety-state strong, .safety-state small { display:block; }
  .safety-state strong { font-size:12px; }
  .safety-state small { color:var(--muted); font-size:10px; }
  .status-dot { width:8px; height:8px; margin-top:5px; border-radius:50%; background:currentColor; box-shadow:0 0 0 3px color-mix(in srgb,currentColor 15%,transparent); }
  .status-dot.good { color:var(--good); }
  .view-nav { display:flex; flex-direction:column; gap:4px; min-width:0; }
  .nav-link { display:flex; align-items:center; gap:10px; min-height:40px; padding:9px 11px; border-radius:8px; color:var(--muted); text-decoration:none; font-weight:650; white-space:nowrap; }
  .nav-link:hover { color:var(--text); background:var(--hover); }
  .nav-link[aria-current="page"] { color:var(--text); background:color-mix(in srgb,var(--accent) 11%,transparent); }
  .nav-mark { width:7px; height:7px; border:1px solid currentColor; border-radius:50%; flex:none; }
  .nav-link[aria-current="page"] .nav-mark { color:var(--accent); background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent); }

  .workspace { min-width:0; }
  .topbar {
    position:sticky; top:0; z-index:15; display:flex; align-items:center; gap:16px; min-height:70px;
    padding:12px 24px; border-bottom:1px solid var(--border); background:var(--bg); background:color-mix(in srgb,var(--bg) 88%,transparent); backdrop-filter:blur(12px);
  }
  .view-heading { min-width:130px; }
  .view-heading span, .view-heading strong { display:block; }
  .view-heading strong { font-size:16px; }
  .eyebrow { color:var(--muted-on-bg); font:700 10px/1.3 var(--sans); text-transform:uppercase; letter-spacing:.11em; }
  .search-field { flex:1; max-width:520px; min-width:150px; height:40px; display:flex; align-items:center; gap:8px; padding:0 11px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--muted); }
  .search-field:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--focus); }
  .search-field input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:var(--text); }
  .search-field input::placeholder { color:var(--muted); opacity:1; }
  .top-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }

  #app-main { width:min(1280px,100%); margin:0 auto; padding:28px 30px 54px; }
  .view { min-width:0; }
  .view-intro { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; margin-bottom:24px; }
  .view-intro h1 { margin:4px 0 0; font-size:30px; line-height:1.15; letter-spacing:-.035em; }
  .view-intro p { max-width:52ch; margin:0; color:var(--muted-on-bg); text-align:right; }
  .placeholder-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  .card { min-width:0; padding:20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); box-shadow:0 8px 26px -24px var(--shadow); }
  .card h2 { margin:0 0 12px; font-size:15px; }
  .card p, .placeholder { color:var(--muted); }
  .placeholder { padding:18px 0; border-top:1px solid var(--border); }
  .overflow-region { max-width:100%; overflow:auto; overscroll-behavior-inline:contain; scrollbar-gutter:stable; }
  .overflow-region > * { min-width:520px; }
  .summary-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
  .metric { min-width:0; padding:15px 17px; border:1px solid var(--border); border-radius:11px; background:var(--surface); }
  .metric span, .metric strong { display:block; }
  .metric span { color:var(--muted-on-bg); font-size:11px; }
  .metric strong { margin-top:5px; font-size:23px; letter-spacing:-.03em; overflow-wrap:anywhere; }
  .overview-layout { display:grid; grid-template-columns:minmax(0,3fr) minmax(230px,1fr); gap:16px; align-items:start; }
  .fleet-map-card { padding:0; overflow:hidden; }
  .card-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:18px 20px 12px; }
  .card-heading h2 { margin:3px 0 0; }
  .kind-filters { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
  .kind-filters button { min-height:30px; padding:4px 9px; font-size:11px; }
  .kind-filters button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb,var(--accent) 10%,transparent); }
  .fleet-table { width:100%; min-width:700px; border-collapse:collapse; }
  .fleet-table th, .fleet-table td { padding:12px 13px; border-top:1px solid var(--border); text-align:left; vertical-align:top; }
  .fleet-table thead th { color:var(--muted-on-bg); font-size:10px; text-transform:uppercase; letter-spacing:.07em; }
  .capability-row:hover { background:var(--hover); }
  .capability-row th strong, .kind-label, .state-label, .management-label { display:block; }
  .details-button { margin-top:7px; min-height:28px; padding:3px 8px; font-size:10px; }
  .kind-label { color:var(--muted); font-size:9px; text-transform:uppercase; letter-spacing:.08em; }
  .state-label { font-size:12px; font-weight:700; }
  .management-label { color:var(--muted); font-size:10px; }
  .state-installed .state-label { color:var(--good); }
  .state-missing .state-label, .state-disabled .state-label { color:var(--warn); }
  .state-unavailable .state-label, .state-unverifiable .state-label { color:var(--danger); }
  .cell-actions { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
  .cell-operation { min-height:26px; padding:2px 7px; font-size:10px; }
  .coverage { display:inline-block; white-space:nowrap; padding:3px 7px; border:1px solid var(--border); border-radius:999px; font-size:10px; font-weight:700; }
  .coverage-all-present { color:var(--good); }
  .coverage-gap, .coverage-agent-only { color:var(--warn); }
  .coverage-unverifiable { color:var(--danger); }
  .state-legend { display:flex; flex-wrap:wrap; gap:7px 13px; padding:11px 20px 16px; border-top:1px solid var(--border); color:var(--muted); font-size:10px; }
  .attention-card h2 { margin-top:3px; }
  .attention-list { display:grid; gap:0; margin:0; padding:0; list-style:none; }
  .attention-item { display:grid; gap:3px; padding:11px 0; border-top:1px solid var(--border); }
  .attention-item span { color:var(--muted); font-size:11px; overflow-wrap:anywhere; }
  .attention-item button { justify-self:start; min-height:30px; margin-top:4px; padding:4px 8px; font-size:11px; }
  .empty-state { color:var(--muted); text-align:center!important; }

  .inventory-panel { min-width:0!important; }
  .inventory-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-bottom:12px; border-bottom:1px solid var(--border); }
  .inventory-kind-chips { display:flex; flex:1; flex-wrap:wrap; gap:5px; }
  .inventory-kind-chips button { min-height:30px; padding:4px 9px; font-size:11px; }
  .inventory-kind-chips button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb,var(--accent) 10%,transparent); }
  .compact-control { display:flex; align-items:center; gap:5px; color:var(--muted); font-size:11px; }
  .compact-control select { min-height:32px; padding:4px 24px 4px 8px; }
  .inventory-result-count { margin:10px 0 5px; color:var(--muted); font-size:11px; }
  .inventory-list { display:grid; }
  .inventory-item { display:grid; grid-template-columns:minmax(150px,1fr) minmax(260px,2fr) auto; align-items:center; gap:12px; padding:9px 0; border-top:1px solid var(--border); }
  .inventory-item:first-child { border-top:0; }
  .inventory-item-heading h3 { margin:1px 0 0; font-size:13px; overflow-wrap:anywhere; }
  .inventory-statuses { display:flex; flex-wrap:wrap; gap:5px; }
  .status-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border:1px solid var(--border); border-radius:999px; font-size:10px; font-weight:700; white-space:nowrap; }
  .status-icon { font-size:8px; }
  .status-installed { color:var(--good); }
  .status-missing, .status-disabled { color:var(--warn); }
  .status-unavailable, .status-unverifiable { color:var(--danger); }
  .capability-detail { display:grid; gap:9px; }
  .capability-detail p { margin:0; }
  .detail-kind, .detail-meta, .preview-note { color:var(--muted); font-size:11px; }
  .detail-link { color:var(--accent); overflow-wrap:anywhere; }
  .agent-states, .plan-changes { margin:4px 0 0; padding:0; list-style:none; }
  .agent-state { display:grid; grid-template-columns:minmax(100px,1fr) auto; align-items:center; gap:6px 10px; padding:9px 0; border-top:1px solid var(--border); }
  .agent-state .cell-actions { grid-column:1 / -1; }
  .vendor-managed { padding:11px 12px; border:1px solid color-mix(in srgb,var(--accent) 45%,var(--border)); border-radius:9px; background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
  .vendor-managed-title { color:var(--accent); }
  .vendor-managed-note { margin-top:4px!important; color:var(--muted); font-size:11px; }
  .vendor-metadata { grid-column:1 / -1; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:3px 10px; margin:2px 0; font-size:11px; }
  .vendor-metadata dt { color:var(--muted); }
  .vendor-metadata dd { margin:0; overflow-wrap:anywhere; }
  .plan-summary { font-weight:700; }
  .plan-changes li { padding:5px 0; border-top:1px solid var(--border); font-size:12px; }
  .plan-warnings { color:var(--warn); }
  .dialog-error { margin:12px 0 0; color:var(--danger); font-weight:650; }

  .discovery-toolbar { display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap; margin-bottom:16px; padding:12px; border:1px solid var(--border); border-radius:11px; background:var(--surface); }
  .discovery-filter-group { display:flex; flex-wrap:wrap; gap:5px; }
  .discovery-filter-group button { min-height:30px; padding:4px 9px; font-size:11px; }
  .discovery-filter-group button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb,var(--accent) 10%,transparent); }
  .source-failures { flex-basis:100%; }
  .source-failures:empty { display:none; }
  .source-failures p { margin:4px 0 0; color:var(--muted); font-size:11px; }
  .discovery-list { display:grid; }
  .discovery-section-title { margin:14px 0 3px; color:var(--muted-on-bg); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .discovery-item { padding:13px 0; border-top:1px solid var(--border); }
  .discovery-item:first-child { border-top:0; }
  .discovery-item-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .discovery-item h3, .discovery-item h4 { margin:0; font-size:14px; overflow-wrap:anywhere; }
  .discovery-description { margin:6px 0; color:var(--text)!important; }
  .discovery-meta { margin:5px 0; color:var(--muted); font-size:10px; overflow-wrap:anywhere; }
  .trust, .reason { display:inline-flex; padding:2px 7px; border:1px solid var(--border); border-radius:999px; color:var(--muted); font-size:9px; font-weight:700; white-space:nowrap; }
  .trust-no-flags { border-color:color-mix(in srgb,var(--accent) 42%,var(--border)); color:var(--accent); }
  .trust-caution, .trust-unknown { color:var(--muted-on-bg); }
  .reason-list, .discovery-actions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-top:7px; }
  .discovery-actions { justify-content:space-between; gap:8px 12px; }
  .discovery-actions a { min-height:30px; display:inline-flex; align-items:center; }
  .guidance-note { flex:1 1 210px; color:var(--muted); font-size:10px; }
  .discovery-actions button, .discovery-toggle { min-height:30px; padding:4px 9px; font-size:11px; }
  .discovery-toggle { justify-self:start; margin-top:10px; }

  .drift-summary { margin:0; color:var(--text)!important; font-weight:700; }
  .drift-note, .activity-note { margin:6px 0 12px; color:var(--muted); font-size:11px; }
  .drift-groups { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .drift-group { min-width:0; padding:12px; border:1px solid var(--border); border-radius:9px; background:var(--surface-raised); }
  .drift-group h3 { margin:0 0 6px; font-size:12px; }
  .drift-list { margin:0; padding-left:18px; color:var(--muted); font-size:11px; overflow-wrap:anywhere; }
  .drift-list li + li { margin-top:4px; }
  .activity-list { display:grid; gap:7px; margin:0; padding:0; list-style:none; }
  .activity-record { min-width:0; }
  .activity-item { width:100%; min-height:0; display:grid; grid-template-columns:minmax(130px,.7fr) minmax(150px,1.4fr) minmax(110px,1fr) auto; align-items:center; gap:8px; padding:11px 12px; border:1px solid var(--border); border-radius:9px; background:var(--surface-raised); color:var(--text); text-align:left; }
  button.activity-item:hover { border-color:var(--accent); }
  .activity-time, .activity-meta, .activity-outcome { color:var(--muted); font-size:10px; overflow-wrap:anywhere; }
  .activity-outcome { justify-self:end; text-transform:capitalize; }
  .delegated-recovery { margin-top:5px; padding:9px 12px; border-left:3px solid var(--warn); border-radius:0 7px 7px 0; background:color-mix(in srgb,var(--warn) 8%,var(--surface)); color:var(--muted); font-size:11px; }
  .rollback-warning { color:var(--warn); }

  .overlay { position:fixed; inset:0; z-index:100; display:grid; place-items:center; padding:18px; background:rgba(3,7,10,.72); }
  .dialog-panel { width:min(520px,100%); padding:22px; border:1px solid var(--border); border-radius:14px; background:var(--surface-raised); box-shadow:0 24px 80px var(--shadow); }
  .dialog-panel h2 { margin:0 0 12px; }
  .dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
  .live-region { position:fixed; right:18px; bottom:18px; z-index:120; max-width:min(420px,calc(100vw - 36px)); padding:0; border-radius:8px; background:var(--surface-raised); color:var(--text); box-shadow:0 8px 30px var(--shadow); }
  .live-region:not(:empty) { padding:10px 14px; border:1px solid var(--border); }
  .live-region.error { color:var(--danger); }

  @media (prefers-reduced-motion:reduce) {
    *, *::before, *::after { scroll-behavior:auto!important; transition-duration:0.01ms!important; animation-duration:0.01ms!important; animation-iteration-count:1!important; }
  }

  @media (min-width:640px) and (max-width:1023px) {
    .app-shell { grid-template-columns:88px minmax(0,1fr); }
    .rail { padding:18px 10px; align-items:stretch; }
    .brand { justify-content:center; }
    .brand > div, .safety-state { display:none; }
    .view-nav { align-items:stretch; }
    .nav-link { flex-direction:column; justify-content:center; gap:3px; padding:7px 3px; font-size:10px; }
    .topbar { padding-inline:16px; }
    #app-main { padding-inline:22px; }
  }
  @media (max-width:760px) {
    .topbar { align-items:flex-start; flex-wrap:wrap; }
    .view-heading { flex:1; }
    .search-field { order:3; flex-basis:100%; max-width:none; }
    .top-actions { max-width:70%; }
    .placeholder-grid { grid-template-columns:1fr; }
    .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .overview-layout { grid-template-columns:1fr; }
    .card-heading { flex-direction:column; }
    .kind-filters { justify-content:flex-start; }
    .inventory-item { grid-template-columns:1fr auto; }
    .inventory-statuses { grid-column:1 / -1; }
    .drift-groups { grid-template-columns:1fr; }
    .activity-item { grid-template-columns:1fr 1fr; }
    .activity-outcome { justify-self:start; }
  }
  @media (max-width:639px) {
    .app-shell { display:block; }
    .rail { position:static; width:100%; height:auto; padding:12px 14px 0; gap:12px; border-right:0; border-bottom:1px solid var(--border); }
    .brand { padding-inline:2px; }
    .brand > div span, .safety-state { display:none; }
    .view-nav { flex-direction:row; gap:4px; overflow-x:auto; padding:0 0 10px; scrollbar-width:thin; }
    .nav-link { flex:none; min-height:36px; padding:7px 10px; }
    .topbar { position:static; padding:12px 14px; gap:10px; }
    .view-heading { min-width:100px; }
    .top-actions { max-width:none; width:100%; margin-left:0; flex:1 0 100%; justify-content:flex-start; }
    .top-actions button, .language-control, .language-control select { min-width:0; }
    #app-main { padding:22px 14px 42px; }
    .view-intro { align-items:flex-start; flex-direction:column; gap:10px; }
    .view-intro p { text-align:left; }
    .view-intro h1 { font-size:26px; }
    .card { padding:16px; }
    .fleet-map-card { padding:0; }
    .summary-grid { grid-template-columns:1fr; }
    .inventory-item { grid-template-columns:minmax(0,1fr); }
    .inventory-statuses { grid-column:auto; }
    .inventory-item .details-button { justify-self:start; }
    .activity-item { grid-template-columns:minmax(0,1fr); }
    .vendor-metadata { grid-template-columns:minmax(0,1fr); gap:1px; }
    .vendor-metadata dd + dt { margin-top:5px; }
    .delegated-recovery { overflow-wrap:anywhere; }
    .dialog-panel { max-height:calc(100dvh - 28px); overflow:auto; padding:18px; }
  }
`;
