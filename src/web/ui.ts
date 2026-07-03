/**
 * The dashboard page: a single self-contained HTML document (no framework, no
 * build step, no external resources — the CSP forbids them). Design: "command
 * deck" — dark, card-based, sans-serif UI with mono reserved for identifiers.
 * All dynamic values render via textContent (XSS-safe); the session token never
 * touches the URL after first load.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>fleet</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0c10; --surface:#12151b; --elevated:#191e26; --border:#232936; --border-soft:#1a1f29;
    --text:#e8ebf0; --text-2:#9aa4b2; --text-3:#67707e;
    --accent:#f0b429; --accent-hi:#ffc94d; --accent-ink:#231a00;
    --green:#4cc38a; --red:#f2555a; --yellow:#f0b429; --blue:#6ca7f5; --violet:#a78bfa;
    --teal:#45c4b0; --orange:#f09046; --pink:#e17ec2;
    --sans:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; font:14px/1.55 var(--sans); color:var(--text);
    background:radial-gradient(1200px 500px at 50% -10%, #141a26 0%, var(--bg) 60%) fixed var(--bg);
  }
  /* ── header ─────────────────────────────────────────── */
  header {
    position:sticky; top:0; z-index:20; backdrop-filter:blur(8px);
    background:rgba(10,12,16,.82); border-bottom:1px solid var(--border-soft);
    display:flex; align-items:center; gap:14px; padding:12px 24px;
  }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand .mark { width:22px; height:22px; }
  .brand h1 { font-size:17px; margin:0; letter-spacing:.02em; font-weight:700; }
  .brand .sub { color:var(--text-3); font-size:12px; margin-left:4px; }
  .spacer { flex:1; }
  #err { font-size:12.5px; color:var(--red); max-width:46ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #err.flash { color:var(--green); }
  button {
    font:600 13px/1 var(--sans); color:var(--text); background:var(--elevated);
    border:1px solid var(--border); border-radius:8px; padding:8px 14px; cursor:pointer;
    transition:background .12s, border-color .12s;
  }
  button:hover { background:#20262f; border-color:#2e3644; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
  button.primary:hover { background:var(--accent-hi); border-color:var(--accent-hi); }
  button.act { padding:5px 12px; font-size:12px; border-radius:7px; }
  /* ── layout ─────────────────────────────────────────── */
  main { max-width:1160px; margin:0 auto; padding:22px 24px 12px; display:grid; gap:16px; }
  .statstrip { display:flex; gap:12px; flex-wrap:wrap; }
  .stat {
    flex:1 1 120px; background:var(--surface); border:1px solid var(--border-soft); border-radius:12px;
    padding:12px 16px 10px;
  }
  .stat .n { font-size:22px; font-weight:750; letter-spacing:-.02em; }
  .stat .l { font-size:11.5px; color:var(--text-3); text-transform:uppercase; letter-spacing:.08em; margin-top:1px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid2 { grid-template-columns:1fr; } }
  section.card {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:14px; padding:16px 18px 14px;
  }
  section.card > .head { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
  section.card h2 { font-size:13.5px; font-weight:700; margin:0; letter-spacing:.01em; }
  section.card .hint { font-size:11.5px; color:var(--text-3); margin-left:auto; text-align:right; }
  .empty { color:var(--text-3); font-size:13px; border:1px dashed var(--border); border-radius:10px; padding:14px; text-align:center; }
  /* ── matrix ─────────────────────────────────────────── */
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border-soft); font-size:13px; }
  tr:last-child td { border-bottom:none; }
  th { color:var(--text-3); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.07em; }
  tbody tr:hover { background:rgba(255,255,255,.02); }
  td.name { font-family:var(--mono); font-size:12.5px; }
  td.cell { text-align:center; width:120px; }
  .chip {
    display:inline-block; font:600 10.5px/1 var(--sans); letter-spacing:.05em; text-transform:uppercase;
    padding:4px 8px; border-radius:99px; border:1px solid;
  }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; background:var(--green); box-shadow:0 0 6px rgba(76,195,138,.5); }
  .dot.off { background:#333b47; box-shadow:none; }
  .pill { display:inline-block; font:600 11px/1 var(--mono); padding:3px 8px; border-radius:6px; }
  .pill.allow { color:var(--green); background:rgba(76,195,138,.1); }
  .pill.deny  { color:var(--red); background:rgba(242,85,90,.1); }
  .pill.ask   { color:var(--yellow); background:rgba(240,180,41,.1); }
  .pill.policy{ color:var(--text-2); background:rgba(154,164,178,.1); }
  td.cell.rm { cursor:pointer; }
  td.cell.rm:hover .dot { background:var(--red); box-shadow:0 0 6px rgba(242,85,90,.5); }
  /* ── list rows (updates / recommendations) ──────────── */
  .item { display:flex; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid var(--border-soft); }
  .item:last-child { border-bottom:none; }
  .item .body { min-width:0; flex:1; }
  .item .title { font-weight:600; font-size:13.5px; }
  .item .title .id { font-family:var(--mono); font-weight:400; font-size:11.5px; color:var(--text-3); margin-left:8px; }
  .item .meta { font-size:12px; color:var(--text-2); margin-top:1px; }
  .item .meta .warn { color:var(--yellow); }
  .item .meta .faint { color:var(--text-3); }
  .item a { color:var(--blue); text-decoration:none; font-size:12px; }
  .item a:hover { text-decoration:underline; }
  .catchip { display:inline-block; font:600 10.5px/1 var(--mono); padding:3px 7px; border-radius:6px; margin-right:2px;
    color:var(--violet); background:rgba(167,139,250,.1); border:1px solid rgba(167,139,250,.25); white-space:nowrap; }
  .upver { font-family:var(--mono); font-size:12px; color:var(--green); }
  .srcwarn { margin-top:10px; font-size:12px; color:var(--yellow); }
  /* ── preview overlay ────────────────────────────────── */
  #overlay { position:fixed; inset:0; z-index:50; display:none; background:rgba(5,7,10,.6); }
  #overlay.show { display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; }
  #preview {
    width:min(560px, calc(100vw - 40px)); background:var(--elevated); border:1px solid var(--border);
    border-radius:14px; padding:18px 20px 16px; box-shadow:0 18px 60px rgba(0,0,0,.5);
  }
  #preview .ptitle { font-weight:700; font-size:14.5px; margin-bottom:10px; }
  #preview .row { font-family:var(--mono); font-size:12.5px; padding:3px 0; color:var(--text-2); }
  #preview .row.add { color:var(--green); }
  #preview .row.del { color:var(--red); }
  #preview .row.warn { color:var(--yellow); }
  #preview .row.muted { color:var(--text-3); }
  .pactions { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .foot { color:var(--text-3); font-size:12px; text-align:center; padding:10px 20px 26px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z" stroke="#f0b429" stroke-width="1.6" fill="rgba(240,180,41,.12)"/>
      <circle cx="12" cy="12" r="2.6" fill="#f0b429"/>
    </svg>
    <h1>fleet</h1>
    <span class="sub">cross-agent capability manager</span>
  </div>
  <span class="spacer"></span>
  <span id="err"></span>
  <button id="rollback">Rollback</button>
  <button id="refresh" class="primary">Refresh</button>
</header>
<main>
  <div class="statstrip">
    <div class="stat"><div class="n" id="st-agents">–</div><div class="l">agents</div></div>
    <div class="stat"><div class="n" id="st-mcp">–</div><div class="l">mcp servers</div></div>
    <div class="stat"><div class="n" id="st-skill">–</div><div class="l">skills</div></div>
    <div class="stat"><div class="n" id="st-rule">–</div><div class="l">rules</div></div>
    <div class="stat"><div class="n" id="st-plugin">–</div><div class="l">plugins</div></div>
    <div class="stat"><div class="n" id="st-upd">–</div><div class="l">updates</div></div>
  </div>
  <section class="card">
    <div class="head"><h2>Inventory</h2><span class="hint">what's installed where · click an MCP dot to remove</span></div>
    <div id="inventory"></div>
  </section>
  <div class="grid2">
    <section class="card">
      <div class="head"><h2>Updates</h2><span class="hint">newer version on the registry</span></div>
      <div id="updates"></div>
    </section>
    <section class="card">
      <div class="head"><h2>Conflicts</h2><span class="hint">opposing always-on rules · heuristic</span></div>
      <div id="conflicts"></div>
    </section>
  </div>
  <section class="card">
    <div class="head"><h2>New MCP servers</h2><span class="hint">recommended for your setup · heuristic</span></div>
    <div id="recommended"></div>
  </section>
  <section class="card">
    <div class="head"><h2>Skills</h2><span class="hint">sampled from skill registries — not exhaustive</span></div>
    <div id="recskills"></div>
  </section>
</main>
<div class="foot">Recommendations &amp; conflicts are heuristic — verify before acting. An empty feed may mean sources were unreachable.</div>
<div id="overlay"><div id="preview"></div></div>
<script>
// Take the token off the URL: stash in sessionStorage and strip ?token= so it
// doesn't linger in history or leak via a future Referer.
let token = sessionStorage.getItem('fleet_token') || '';
const qtok = new URLSearchParams(location.search).get('token');
if (qtok) { token = qtok; sessionStorage.setItem('fleet_token', qtok); history.replaceState(null, '', location.pathname); }
async function get(path){
  const r = await fetch(path, { headers: { 'authorization': 'Bearer ' + token } });
  if(!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return r.json();
}
function el(tag, cls, txt){ const e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
function stat(id, n){ document.getElementById(id).textContent = String(n); }

const KIND_COLORS = { mcp:'#6ca7f5', skill:'#a78bfa', rule:'#45c4b0', permission:'#f09046', plugin:'#e17ec2' };
function kindChip(kind){
  const c = el('span','chip', kind);
  const col = KIND_COLORS[kind] || '#9aa4b2';
  c.style.color = col; c.style.borderColor = col + '55'; c.style.background = col + '14';
  return c;
}

let agents = [];
function setErr(e){ const x=document.getElementById('err'); x.className=''; x.textContent = e ? (e.message ? e.message : String(e)) : ''; }
function flash(msg){ const x=document.getElementById('err'); x.textContent=msg; x.className='flash'; setTimeout(function(){ if(x.className==='flash'){ x.textContent=''; x.className=''; } }, 2600); }
async function postJson(path, body){
  const r = await fetch(path, { method:'POST', headers:{ 'authorization':'Bearer '+token, 'content-type':'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error((data && data.error) ? data.error : (path+': HTTP '+r.status));
  return data;
}
function clearPreview(){ document.getElementById('overlay').className=''; document.getElementById('preview').innerHTML=''; }
document.getElementById('overlay').addEventListener('click', function(e){ if(e.target===this) clearPreview(); });
let pendingPlanId = null;
function showPreview(res, onConfirm){
  const preview = res.preview || res;
  const bar = document.getElementById('preview'); bar.innerHTML='';
  document.getElementById('overlay').className='show';
  const changes = preview.changes || [];
  bar.appendChild(el('div','ptitle', changes.length ? ('Preview — '+changes.length+' change(s)') : ('Nothing to apply ('+preview.status+')')));
  if(res.runs){ bar.appendChild(el('div','row','runs: '+res.runs)); }
  changes.forEach(function(c){
    bar.appendChild(el('div','row '+(c.op==='remove'?'del':'add'), (c.op==='remove'?'− ':'+ ')+'['+c.agent+'] '+c.op+' "'+c.name+'"'));
    (c.warnings||[]).forEach(function(w){ bar.appendChild(el('div','row warn','  ⚠ '+w)); });
  });
  (preview.skips||[]).forEach(function(s){ bar.appendChild(el('div','row muted','· ['+s.agent+'] skipped: '+s.reason)); });
  const act = el('div','pactions');
  const cancel=el('button',null,'Cancel'); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
  if(changes.length){ const ok=el('button','primary','Confirm & apply'); ok.addEventListener('click', onConfirm); act.appendChild(ok); }
  bar.appendChild(act);
}
async function doPlan(req){
  setErr('');
  try {
    const res = await postJson('/api/plan', req);
    pendingPlanId = res.planId;
    showPreview(res, async function(){
      try {
        const applied = await postJson('/api/apply', { planId: pendingPlanId });
        pendingPlanId=null; clearPreview(); await refresh();
        flash(applied.status==='applied' ? 'Applied ✓' : ('Done: '+applied.status));
      } catch(e){ setErr(e); clearPreview(); }
    });
  } catch(e){ setErr(e); }
}
function pickAgentsThen(cb){
  const bar = document.getElementById('preview'); bar.innerHTML='';
  document.getElementById('overlay').className='show';
  bar.appendChild(el('div','ptitle','Install to which agent(s)?'));
  const act = el('div','pactions');
  const cancel=el('button',null,'Cancel'); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
  agents.forEach(function(a){ const b=el('button',null,a); b.addEventListener('click', function(){ cb([a]); }); act.appendChild(b); });
  const allb = el('button','primary','All agents'); allb.addEventListener('click', function(){ cb('all'); }); act.appendChild(allb);
  bar.appendChild(act);
}
async function doRollback(){
  setErr('');
  try { const r = await postJson('/api/rollback', {}); await refresh(); flash('Rolled back: ' + (r.action || 'done')); }
  catch(e){ setErr(e); }
}

async function loadInventory(){
  const inv = await get('/api/inventory');
  agents = inv.agents.map(function(a){ return a.id; });
  stat('st-agents', inv.agents.filter(function(a){ return a.present; }).length);
  stat('st-mcp', inv.servers.length);
  stat('st-skill', inv.skills.length);
  stat('st-rule', inv.rules.length);
  stat('st-plugin', (inv.plugins||[]).length);
  const rows = {};
  function add(kind, item){ const k=kind+'|'+item.name; if(!rows[k])rows[k]={kind:kind,name:item.name,agents:{},effects:{}}; rows[k].agents[item.agent]=true; if(item.effect) rows[k].effects[item.agent]=item.effect; }
  inv.servers.forEach(function(s){ add('mcp', s); });
  inv.skills.forEach(function(s){ add('skill', s); });
  inv.rules.forEach(function(s){ add('rule', s); });
  (inv.permissions||[]).forEach(function(s){ add('permission', s); });
  (inv.plugins||[]).forEach(function(s){ add('plugin', s); });
  const box = document.getElementById('inventory'); box.innerHTML='';
  const keys = Object.keys(rows);
  if(keys.length===0){ box.appendChild(el('p','empty','Nothing installed yet — try the recommendations below.')); return; }
  const table = el('table');
  const thead = el('thead'); const head = el('tr');
  head.appendChild(el('th',null,'kind')); head.appendChild(el('th',null,'capability'));
  agents.forEach(function(a){ const th=el('th',null,a); th.style.textAlign='center'; head.appendChild(th); });
  thead.appendChild(head); table.appendChild(thead);
  const tbody = el('tbody');
  keys.map(function(k){ return rows[k]; }).sort(function(a,b){ return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name); }).forEach(function(row){
    const tr = el('tr');
    const tdk = el('td'); tdk.appendChild(kindChip(row.kind)); tr.appendChild(tdk);
    tr.appendChild(el('td','name',row.name));
    agents.forEach(function(a){
      const td = el('td','cell');
      if(row.agents[a]){
        if(row.kind==='permission' && row.effects[a]){
          const effects = String(row.effects[a]).split(',');
          effects.forEach(function(eff){ td.appendChild(el('span','pill '+eff, eff)); });
        } else {
          td.appendChild(el('span','dot'));
          if(row.kind==='mcp'){
            td.classList.add('rm'); td.title='remove from '+a;
            td.addEventListener('click', function(){ doPlan({ action:'remove', name:row.name, from:[a] }); });
          }
        }
      } else {
        td.appendChild(el('span','dot off'));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
}

async function loadFeed(){
  const feed = await get('/api/feed');
  stat('st-upd', feed.updates.length);
  const up = document.getElementById('updates'); up.innerHTML='';
  if(!feed.updates.length) up.appendChild(el('p','empty','Everything pinned is current.'));
  feed.updates.forEach(function(u){
    const d = el('div','item');
    const body = el('div','body');
    const t = el('div','title', u.name);
    t.appendChild(el('span','id','['+u.agent+']'));
    body.appendChild(t);
    const m = el('div','meta');
    m.appendChild(el('span','upver', u.installed+' → '+u.available));
    body.appendChild(m);
    d.appendChild(body);
    if(u.identifier && (u.ecosystem==='npm' || u.ecosystem==='pypi')){
      const b=el('button','act primary','Update'); b.addEventListener('click', function(){ doPlan({ action:'update', name:u.name, to:[u.agent], coordinate:{ version:u.available } }); }); d.appendChild(b);
    }
    up.appendChild(d);
  });
  const rec = document.getElementById('recommended'); rec.innerHTML='';
  const rsk = document.getElementById('recskills'); rsk.innerHTML='';
  const servers = (feed.recommendations||[]).filter(function(r){ return r.kind !== 'skill'; });
  const skills = (feed.recommendations||[]).filter(function(r){ return r.kind === 'skill'; });
  if(!servers.length) rec.appendChild(el('p','empty','No recommendations right now.'));
  servers.forEach(function(r){
    const d = el('div','item');
    const body = el('div','body');
    const t = el('div','title', r.name);
    if(r.identifier) t.appendChild(el('span','id', r.identifier));
    body.appendChild(t);
    const m = el('div','meta');
    m.appendChild(el('span',null,(r.reasons||[]).join(' · ')));
    if(r.trust && r.trust.level==='caution'){ m.appendChild(el('span','warn','  ⚠ ' + (r.trust.reasons||[]).join(', '))); }
    else if(r.trust && r.trust.level==='unknown'){ m.appendChild(el('span','faint','  · ' + (r.trust.reasons||[]).join(', '))); }
    body.appendChild(m);
    d.appendChild(body);
    if(r.identifier && (r.ecosystem==='npm' || r.ecosystem==='pypi')){
      const b = el('button','act','Install'); b.addEventListener('click', function(){ pickAgentsThen(function(to){ doPlan({ action:'install', name:r.name, to:to, coordinate:{ ecosystem:r.ecosystem, identifier:r.identifier } }); }); }); d.appendChild(b);
    }
    rec.appendChild(d);
  });
  if(!skills.length) rsk.appendChild(el('p','empty','No skill recommendations right now.'));
  skills.forEach(function(r){
    const d = el('div','item');
    const body = el('div','body');
    const t = el('div','title');
    t.appendChild(el('span','catchip', r.category||'other'));
    t.appendChild(el('span',null,' ' + r.name));
    body.appendChild(t);
    const m = el('div','meta');
    m.appendChild(el('span',null,(r.reasons||[]).join(' · ')));
    body.appendChild(m);
    d.appendChild(body);
    if(r.url){ const a=el('a',null,'repo →'); a.href=r.url; a.target='_blank'; a.rel='noreferrer noopener'; d.appendChild(a); }
    rsk.appendChild(d);
  });
  if(feed.failures && feed.failures.length){ rec.appendChild(el('p','srcwarn', "⚠ couldn't reach: " + feed.failures.map(function(f){ return f.source; }).join(', '))); }
}

async function loadConflicts(){
  const c = await get('/api/conflicts');
  const box = document.getElementById('conflicts'); box.innerHTML='';
  if(!c.findings.length){ box.appendChild(el('p','empty','No likely conflicts found.')); return; }
  c.findings.forEach(function(f){
    const d = el('div','item');
    const body = el('div','body');
    body.appendChild(el('div','title', '"'+f.a+'" vs "'+f.b+'"'));
    const m = el('div','meta');
    m.appendChild(el('span','warn','⚠ possible '+f.axis+' conflict'));
    m.appendChild(el('span','faint','  ['+f.agent+']'));
    body.appendChild(m);
    d.appendChild(body);
    box.appendChild(d);
  });
}

async function refresh(){
  try { await Promise.all([loadInventory(), loadFeed(), loadConflicts()]); document.getElementById('err').textContent=''; }
  catch(e){ document.getElementById('err').textContent = (e && e.message) ? e.message : String(e); }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('rollback').addEventListener('click', doRollback);
refresh();
</script>
</body>
</html>`;
}
