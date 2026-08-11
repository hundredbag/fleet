export const DASHBOARD_CSS = `
  :root {
    color-scheme: dark;
    --bg:#0b0e13; --glow:#0f2b2b; --surface:#141a22; --elevated:#1b2430; --border:#28323f; --border-soft:#1e2732;
    --text:#e8edf4; --text-2:#9aa8ba; --text-3:#647285;
    --accent:#2bd4c0; --accent-hi:#5ee7d6; --accent-ink:#052723;
    --green:#4cc38a; --red:#f2555a; --yellow:#e0a83a; --blue:#6ca7f5; --violet:#a78bfa;
    --orange:#f09046; --pink:#e17ec2; --hover:rgba(255,255,255,.025); --btn-hover:#232d3a; --shadow:rgba(0,0,0,.45);
    --hdr:rgba(11,14,19,.8); --ring:rgba(43,212,192,.45);
    --sans:-apple-system,'Segoe UI',Roboto,'Helvetica Neue','Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg:#f5f8fa; --glow:#e2f0ee; --surface:#ffffff; --elevated:#ffffff; --border:#dde4ec; --border-soft:#edf1f6;
    --text:#132030; --text-2:#45566b; --text-3:#647285;
    --accent:#0d9488; --accent-hi:#0f766e; --accent-ink:#ffffff;
    --green:#1f9d63; --red:#d43f44; --yellow:#a2740a; --blue:#2f6fd0; --violet:#7c5fd8;
    --orange:#c96a1c; --pink:#c25ba3; --hover:rgba(15,60,55,.035); --btn-hover:#eef3f2; --shadow:rgba(20,40,60,.1);
    --hdr:rgba(245,248,250,.85); --ring:rgba(13,148,136,.4);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; font:14px/1.6 var(--sans); color:var(--text); word-break:keep-all;
    background:
      radial-gradient(900px 420px at 82% -8%, var(--glow) 0%, transparent 60%),
      radial-gradient(700px 380px at 6% 2%, var(--glow) 0%, transparent 55%),
      var(--bg);
    background-attachment:fixed;
  }
  :focus-visible { outline:2px solid var(--ring); outline-offset:2px; border-radius:6px; }
  /* ── header ─────────────────────────────────────────── */
  header {
    position:sticky; top:0; z-index:20; backdrop-filter:blur(10px) saturate(1.2);
    background:var(--hdr); border-bottom:1px solid var(--border-soft);
    display:flex; align-items:center; gap:12px; padding:12px 22px; flex-wrap:wrap;
  }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand .mark { width:24px; height:24px; flex:none; color:var(--accent); filter:drop-shadow(0 0 10px var(--ring)); }
  .brand .mark path { stroke:var(--accent); fill:color-mix(in srgb, var(--accent) 16%, transparent); }
  .brand .mark circle { fill:var(--accent); }
  .brand h1 { font-size:18px; margin:0; letter-spacing:-.01em; font-weight:800; }
  .brand .sub { color:var(--text-3); font-size:11px; text-transform:uppercase; letter-spacing:.13em; font-weight:600; }
  @media (max-width:680px){ .brand .sub { display:none; } }
  .spacer { flex:1; }
  #err { font:600 12px/1.4 var(--sans); color:var(--red); max-width:42ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #err.flash { color:var(--accent); }
  button {
    font:650 13px/1 var(--sans); color:var(--text); background:var(--elevated);
    border:1px solid var(--border); border-radius:9px; padding:8px 14px; cursor:pointer;
    transition:background .14s, border-color .14s, transform .05s;
  }
  button:hover { background:var(--btn-hover); border-color:var(--accent); }
  button:active { transform:translateY(1px); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:750; box-shadow:0 2px 12px -4px var(--ring); }
  button.primary:hover { background:var(--accent-hi); border-color:var(--accent-hi); }
  button.act { padding:6px 13px; font-size:12px; border-radius:99px; flex:none; }
  button.icon { padding:8px 11px; font-size:13px; }
  /* ── layout ─────────────────────────────────────────── */
  main { max-width:1200px; margin:0 auto; padding:22px 22px 12px; display:grid; gap:16px; }
  .statstrip { display:grid; grid-template-columns:repeat(6, 1fr); gap:12px; }
  @media (max-width:900px){ .statstrip { grid-template-columns:repeat(3, 1fr); } }
  @media (max-width:480px){ .statstrip { grid-template-columns:repeat(2, 1fr); } }
  .stat {
    position:relative; background:var(--surface); border:1px solid var(--border-soft); border-radius:14px;
    padding:14px 16px 12px; min-width:0; overflow:hidden; transition:border-color .14s, transform .1s;
  }
  .stat::before { content:''; position:absolute; left:0; top:0; height:100%; width:3px; background:var(--accent); opacity:0; transition:opacity .14s; }
  .stat:hover { border-color:var(--border); transform:translateY(-1px); }
  .stat:hover::before { opacity:.7; }
  .stat .n { font-size:27px; font-weight:800; letter-spacing:-.03em; font-variant-numeric:tabular-nums; line-height:1.05; }
  .stat .l { font-size:10.5px; color:var(--text-3); letter-spacing:.1em; text-transform:uppercase; margin-top:4px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid2 { grid-template-columns:1fr; } }
  section.card {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:16px; padding:18px 20px 15px; min-width:0;
    box-shadow:0 1px 2px var(--shadow);
  }
  section.card > .head { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
  section.card h2 {
    font-size:14px; font-weight:750; margin:0; letter-spacing:-.01em; position:relative; padding-left:12px;
  }
  section.card h2::before { content:''; position:absolute; left:0; top:50%; transform:translateY(-50%); width:4px; height:15px; border-radius:2px; background:var(--accent); }
  section.card .hint { font-size:11px; color:var(--text-3); margin-left:auto; text-align:right; }
  .empty { color:var(--text-3); font-size:13px; border:1px dashed var(--border); border-radius:12px; padding:18px; text-align:center; }
  /* ── matrix ─────────────────────────────────────────── */
  .tblwrap { overflow-x:auto; margin:0 -4px; }
  table { border-collapse:collapse; width:100%; min-width:520px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--border-soft); font-size:13px; }
  tr:last-child td { border-bottom:none; }
  thead th { color:var(--text-3); font-weight:700; font-size:10.5px; text-transform:uppercase; letter-spacing:.09em; border-bottom:1px solid var(--border); }
  tbody tr { transition:background .1s; }
  tbody tr:hover { background:var(--hover); }
  td.name { font-family:var(--mono); font-size:12.5px; overflow-wrap:anywhere; font-weight:500; }
  td.cell { text-align:center; width:110px; }
  .chip {
    display:inline-block; font:700 10px/1 var(--sans); letter-spacing:.07em; text-transform:uppercase;
    padding:4px 9px; border-radius:6px; border:1px solid; white-space:nowrap;
  }
  .chip.mcp        { color:var(--blue);   border-color:color-mix(in srgb, var(--blue) 35%, transparent);   background:color-mix(in srgb, var(--blue) 12%, transparent); }
  .chip.skill      { color:var(--violet); border-color:color-mix(in srgb, var(--violet) 35%, transparent); background:color-mix(in srgb, var(--violet) 12%, transparent); }
  .chip.rule       { color:var(--green);  border-color:color-mix(in srgb, var(--green) 35%, transparent);  background:color-mix(in srgb, var(--green) 12%, transparent); }
  .chip.permission { color:var(--orange); border-color:color-mix(in srgb, var(--orange) 35%, transparent); background:color-mix(in srgb, var(--orange) 12%, transparent); }
  .chip.plugin     { color:var(--pink);   border-color:color-mix(in srgb, var(--pink) 35%, transparent);   background:color-mix(in srgb, var(--pink) 12%, transparent); }
  .chip.subagent   { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 35%, transparent); background:color-mix(in srgb, var(--accent) 10%, transparent); }
  .chip.other      { color:var(--text-2); border-color:var(--border); background:var(--hover); }
  .dot { display:inline-block; width:9px; height:9px; border-radius:99px; background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  .dot.off { background:transparent; box-shadow:inset 0 0 0 1.5px var(--border); }
  .pill { display:inline-block; font:700 10.5px/1 var(--mono); padding:4px 8px; border-radius:6px; margin:1px; }
  .pill.allow { color:var(--green); background:color-mix(in srgb, var(--green) 14%, transparent); }
  .pill.deny  { color:var(--red); background:color-mix(in srgb, var(--red) 14%, transparent); }
  .pill.ask   { color:var(--yellow); background:color-mix(in srgb, var(--yellow) 16%, transparent); }
  .pill.policy{ color:var(--text-2); background:var(--hover); }
  td.cell.rm { cursor:pointer; }
  td.cell.rm:hover .dot { background:var(--red); box-shadow:0 0 0 3px color-mix(in srgb, var(--red) 22%, transparent); }
  /* ── list rows ──────────────────────────────────────── */
  .item { display:flex; align-items:center; gap:12px; padding:11px 2px; border-bottom:1px solid var(--border-soft); }
  .item:last-child { border-bottom:none; }
  .item .body { min-width:0; flex:1; }
  .item .title { font-weight:700; font-size:13.5px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; overflow-wrap:anywhere; min-width:0; }
  .item .title .id { font-family:var(--mono); font-weight:400; font-size:11.5px; color:var(--text-3); overflow-wrap:anywhere; }
  .item .desc { font-size:12.5px; color:var(--text-2); margin-top:3px; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  @media (max-width:640px){ .item .desc { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; } }
  .item .meta { font-size:11.5px; color:var(--text-3); margin-top:3px; overflow-wrap:anywhere; }
  .item .meta .warn { color:var(--yellow); }
  .item a { color:var(--accent); text-decoration:none; font-size:12px; font-weight:600; white-space:nowrap; }
  .item a:hover { text-decoration:underline; }
  .badge { display:inline-block; font:800 9.5px/1 var(--sans); letter-spacing:.08em; padding:4px 7px; border-radius:5px; text-transform:uppercase; }
  .badge.new { color:var(--accent-ink); background:var(--accent); }
  .badge.pop { color:var(--blue); background:color-mix(in srgb, var(--blue) 14%, transparent); border:1px solid color-mix(in srgb, var(--blue) 30%, transparent); }
  .catchip { display:inline-block; font:700 10px/1 var(--mono); padding:4px 7px; border-radius:5px;
    color:var(--violet); background:color-mix(in srgb, var(--violet) 12%, transparent); border:1px solid color-mix(in srgb, var(--violet) 28%, transparent); white-space:nowrap; }
  .upver { font-family:var(--mono); font-size:12px; color:var(--green); font-weight:600; }
  .srcwarn { margin-top:12px; font-size:12px; color:var(--yellow); }
  /* ── preview / detail modal ─────────────────────────── */
  #overlay { position:fixed; inset:0; z-index:50; display:none; background:rgba(4,8,10,.6); backdrop-filter:blur(3px); }
  #overlay.show { display:flex; align-items:flex-start; justify-content:center; padding:11vh 16px 0; }
  #preview { width:min(580px, 100%); background:var(--elevated); border:1px solid var(--border);
    border-radius:18px; padding:20px 22px 18px; box-shadow:0 24px 70px var(--shadow); animation:pop .16s ease-out; }
  @keyframes pop { from { opacity:0; transform:translateY(-8px) scale(.98); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: reduce) { #preview { animation:none; } }
  #preview .ptitle { font-weight:800; font-size:15px; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--border-soft); display:flex; align-items:center; gap:8px; }
  #preview .row { font-family:var(--mono); font-size:12.5px; padding:3px 0; color:var(--text-2); overflow-wrap:anywhere; }
  #preview .row.add { color:var(--green); }
  #preview .row.del { color:var(--red); }
  #preview .row.warn { color:var(--yellow); }
  #preview .row.muted { color:var(--text-3); }
  .pactions { margin-top:16px; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .drow { display:flex; align-items:center; gap:12px; padding:9px 0; border-bottom:1px solid var(--border-soft); font-size:13px; }
  .drow:last-of-type { border-bottom:none; }
  .dlabel { color:var(--text-2); min-width:120px; display:flex; align-items:center; gap:8px; flex:none; font-weight:500; }
  .dval { color:var(--text); overflow-wrap:anywhere; display:flex; align-items:center; gap:10px; justify-content:space-between; flex:1; min-width:0; }
  .dval .faint { color:var(--text-3); font-size:12.5px; }
  .dsect { font-weight:700; font-size:10.5px; color:var(--text-3); text-transform:uppercase; letter-spacing:.09em; margin-top:14px; padding-bottom:6px; }
  /* ── sort segmented control ─────────────────────────── */
  .seg { display:inline-flex; gap:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  .seg button { border:none; border-radius:0; padding:5px 12px; font-size:11px; font-weight:600; background:transparent; color:var(--text-2); }
  .seg button:hover { background:var(--hover); border-color:transparent; }
  .seg button + button { border-left:1px solid var(--border-soft); }
  .seg button.active { background:var(--accent); color:var(--accent-ink); font-weight:750; }
  /* ── footer ─────────────────────────────────────────── */
  .foot { color:var(--text-3); font-size:12px; text-align:center; padding:10px 20px 28px; }
`;
