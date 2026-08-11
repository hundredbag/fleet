export const DASHBOARD_CSS = `
  :root {
    color-scheme:dark;
    --bg:#080d12; --surface:#0d141a; --surface-raised:#111a22; --border:#1d2730;
    --text:#e7edf3; --muted:#82909c; --accent:#2bd4c0; --accent-ink:#05211d;
    --good:#44d28b; --warn:#e0a83a; --danger:#f2555a; --focus:rgba(43,212,192,.55);
    --action-bg:var(--accent); --muted-on-bg:var(--muted);
    --shadow:rgba(0,0,0,.38); --hover:rgba(255,255,255,.045);
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    --mono:ui-monospace,'SFMono-Regular',Consolas,monospace;
  }
  [data-theme="light"] {
    color-scheme:light;
    --bg:#f4f7f7; --surface:#ffffff; --surface-raised:#fbfcfc; --border:#dfe6e5;
    --text:#172222; --muted:#657572; --accent:#0d9488; --accent-ink:#ffffff;
    --good:#168b69; --warn:#a86914; --danger:#c83f45; --focus:rgba(13,148,136,.45);
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
  :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
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

  .overlay { position:fixed; inset:0; z-index:100; display:grid; place-items:center; padding:18px; background:rgba(3,7,10,.72); }
  .dialog-panel { width:min(520px,100%); padding:22px; border:1px solid var(--border); border-radius:14px; background:var(--surface-raised); box-shadow:0 24px 80px var(--shadow); }
  .dialog-panel h2 { margin:0 0 12px; }
  .dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
  .live-region { position:fixed; right:18px; bottom:18px; z-index:120; max-width:min(420px,calc(100vw - 36px)); padding:0; border-radius:8px; background:var(--surface-raised); color:var(--text); box-shadow:0 8px 30px var(--shadow); }
  .live-region:not(:empty) { padding:10px 14px; border:1px solid var(--border); }
  .live-region.error { color:var(--danger); }

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
    .top-actions { max-width:none; margin-left:0; flex:1; }
    #app-main { padding:22px 14px 42px; }
    .view-intro { align-items:flex-start; flex-direction:column; gap:10px; }
    .view-intro p { text-align:left; }
    .view-intro h1 { font-size:26px; }
    .card { padding:16px; }
  }
`;
