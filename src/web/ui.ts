/**
 * The dashboard page: a single self-contained HTML document (no framework, no
 * build step). It reads the session token from its own URL and calls the
 * read-only JSON API. Kept deliberately small; Part 3 adds action buttons.
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
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background:#0e1116; color:#d7dde5; }
  header { padding: 14px 20px; border-bottom:1px solid #232a33; display:flex; align-items:center; gap:16px; }
  header h1 { font-size:16px; margin:0; color:#fff; }
  header .muted { color:#7d8794; font-size:12px; }
  button { font:inherit; background:#1b2530; color:#d7dde5; border:1px solid #2d3947; border-radius:6px; padding:5px 12px; cursor:pointer; }
  button:hover { background:#243040; }
  main { padding: 20px; display:grid; gap:24px; max-width:1100px; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#8b97a5; margin:0 0 10px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid #1c232c; }
  th { color:#8b97a5; font-weight:600; font-size:12px; }
  td.kind { color:#6f7b8a; text-transform:uppercase; font-size:11px; }
  td.name { color:#e8edf3; }
  td.cell { text-align:center; color:#3a4553; }
  td.cell.on { color:#4ade80; font-weight:700; }
  .row { padding:4px 0; }
  .star { color:#fbbf24; }
  .why { color:#7d8794; }
  .muted { color:#6f7b8a; }
  .warn { color:#f59e0b; }
  .foot { color:#5c6674; font-size:12px; padding:0 20px 24px; }
  #err { color:#f87171; }
  #err.flash { color:#4ade80; }
  button.act { padding:2px 9px; font-size:12px; margin-left:8px; }
  td.cell.on { cursor:default; }
  .preview { background:#12202e; border:1px solid #24435c; border-radius:8px; padding:12px 14px; margin:0; }
  .preview .ptitle { color:#cfe0ee; margin-bottom:6px; font-weight:600; }
  .pactions { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <h1>fleet</h1>
  <span class="muted">unified cross-agent capability manager · read-only dashboard</span>
  <span style="flex:1"></span>
  <span id="err"></span>
  <button id="rollback">Rollback last</button>
  <button id="refresh">Refresh</button>
</header>
<main>
  <div id="preview" class="preview" style="display:none"></div>
  <section><h2>Inventory — what's installed where (click a ✓ to remove)</h2><div id="inventory"></div></section>
  <section><h2>Updates available</h2><div id="updates"></div></section>
  <section><h2>New / recommended MCP servers (heuristic)</h2><div id="recommended"></div></section>
  <section><h2>Recommended skills (sampled from skill registries — not exhaustive)</h2><div id="recskills"></div></section>
  <section><h2>Possible conflicts (heuristic)</h2><div id="conflicts"></div></section>
</main>
<div class="foot">Recommendations & conflicts are heuristic — verify before acting. Empty feed may mean sources were unreachable.</div>
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

let agents = [];
function setErr(e){ const x=document.getElementById('err'); x.className=''; x.textContent = e ? (e.message ? e.message : String(e)) : ''; }
function flash(msg){ const x=document.getElementById('err'); x.textContent=msg; x.className='flash'; setTimeout(function(){ if(x.className==='flash'){ x.textContent=''; x.className=''; } }, 2600); }
async function postJson(path, body){
  const r = await fetch(path, { method:'POST', headers:{ 'authorization':'Bearer '+token, 'content-type':'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error((data && data.error) ? data.error : (path+': HTTP '+r.status));
  return data;
}
function clearPreview(){ const bar=document.getElementById('preview'); bar.style.display='none'; bar.innerHTML=''; }
let pendingPlanId = null;
function showPreview(res, onConfirm){
  const preview = res.preview || res;
  const bar = document.getElementById('preview'); bar.innerHTML=''; bar.style.display='block';
  const changes = preview.changes || [];
  bar.appendChild(el('div','ptitle', changes.length ? ('Preview — '+changes.length+' change(s):') : ('Nothing to apply ('+preview.status+')')));
  if(res.runs){ bar.appendChild(el('div','row','runs: '+res.runs)); }
  changes.forEach(function(c){
    bar.appendChild(el('div','row', (c.op==='remove'?'− ':'+ ')+'['+c.agent+'] '+c.op+' "'+c.name+'"'));
    (c.warnings||[]).forEach(function(w){ bar.appendChild(el('div','warn','    ⚠ '+w)); });
  });
  (preview.skips||[]).forEach(function(s){ bar.appendChild(el('div','muted','· ['+s.agent+'] skipped: '+s.reason)); });
  const act = el('div','pactions');
  if(changes.length){ const ok=el('button',null,'Confirm & apply'); ok.addEventListener('click', onConfirm); act.appendChild(ok); }
  const cancel=el('button',null,'Cancel'); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
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
      } catch(e){ setErr(e); }
    });
  } catch(e){ setErr(e); }
}
function pickAgentsThen(cb){
  const bar = document.getElementById('preview'); bar.innerHTML=''; bar.style.display='block';
  bar.appendChild(el('div','ptitle','Install to which agent(s)?'));
  const act = el('div','pactions');
  const allb = el('button',null,'All agents'); allb.addEventListener('click', function(){ cb('all'); }); act.appendChild(allb);
  agents.forEach(function(a){ const b=el('button',null,a); b.addEventListener('click', function(){ cb([a]); }); act.appendChild(b); });
  const cancel=el('button',null,'Cancel'); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
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
  const rows = {};
  function add(kind, item){ const k=kind+'|'+item.name; if(!rows[k])rows[k]={kind:kind,name:item.name,agents:{},effects:{}}; rows[k].agents[item.agent]=true; if(item.effect) rows[k].effects[item.agent]=item.effect; }
  inv.servers.forEach(function(s){ add('mcp', s); });
  inv.skills.forEach(function(s){ add('skill', s); });
  inv.rules.forEach(function(s){ add('rule', s); });
  (inv.permissions||[]).forEach(function(s){ add('permission', s); });
  const box = document.getElementById('inventory'); box.innerHTML='';
  const keys = Object.keys(rows);
  if(keys.length===0){ box.appendChild(el('p','muted','No capabilities found.')); return; }
  const table = el('table');
  const head = el('tr'); head.appendChild(el('th',null,'kind')); head.appendChild(el('th',null,'capability'));
  agents.forEach(function(a){ head.appendChild(el('th',null,a)); });
  table.appendChild(head);
  keys.map(function(k){ return rows[k]; }).sort(function(a,b){ return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name); }).forEach(function(row){
    const tr = el('tr');
    tr.appendChild(el('td','kind',row.kind));
    tr.appendChild(el('td','name',row.name));
    agents.forEach(function(a){
      const val = row.agents[a] ? (row.kind==='permission' && row.effects[a] ? row.effects[a] : '✓') : '·';
      const td=el('td','cell', val);
      if(row.agents[a]){ td.classList.add('on');
        if(row.kind==='mcp'){ td.title='click to remove'; td.style.cursor='pointer'; td.addEventListener('click', function(){ doPlan({ action:'remove', name:row.name, from:[a] }); }); }
      }
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  box.appendChild(table);
}

async function loadFeed(){
  const feed = await get('/api/feed');
  const up = document.getElementById('updates'); up.innerHTML='';
  if(!feed.updates.length) up.appendChild(el('p','muted','(none)'));
  feed.updates.forEach(function(u){
    const d = el('div','row');
    d.appendChild(el('span',null,'↑ ['+u.agent+'] '+u.name+': '+u.installed+' → '+u.available));
    if(u.identifier && (u.ecosystem==='npm' || u.ecosystem==='pypi')){
      const b=el('button','act','Update'); b.addEventListener('click', function(){ doPlan({ action:'update', name:u.name, to:[u.agent], coordinate:{ version:u.available } }); }); d.appendChild(b);
    }
    up.appendChild(d);
  });
  const rec = document.getElementById('recommended'); rec.innerHTML='';
  const rsk = document.getElementById('recskills'); rsk.innerHTML='';
  const servers = (feed.recommendations||[]).filter(function(r){ return r.kind !== 'skill'; });
  const skills = (feed.recommendations||[]).filter(function(r){ return r.kind === 'skill'; });
  if(!servers.length) rec.appendChild(el('p','muted','(none)'));
  servers.forEach(function(r){
    const d = el('div','row');
    d.appendChild(el('span','star','★ '));
    d.appendChild(el('span','name', r.name + (r.identifier ? (' ('+r.identifier+')') : '')));
    d.appendChild(el('span','why', ' — ' + (r.reasons||[]).join('; ')));
    if(r.trust && r.trust.level==='caution'){ d.appendChild(el('span','warn', '  ⚠ ' + (r.trust.reasons||[]).join(', '))); }
    else if(r.trust && r.trust.level==='unknown'){ d.appendChild(el('span','muted', '  · ' + (r.trust.reasons||[]).join(', '))); }
    if(r.identifier && (r.ecosystem==='npm' || r.ecosystem==='pypi')){
      const b = el('button','act','Install'); b.addEventListener('click', function(){ pickAgentsThen(function(to){ doPlan({ action:'install', name:r.name, to:to, coordinate:{ ecosystem:r.ecosystem, identifier:r.identifier } }); }); }); d.appendChild(b);
    }
    rec.appendChild(d);
  });
  if(!skills.length) rsk.appendChild(el('p','muted','(none)'));
  skills.forEach(function(r){
    const d = el('div','row');
    d.appendChild(el('span','star','◆ '));
    d.appendChild(el('span','muted','['+(r.category||'other')+'] '));
    d.appendChild(el('span','name', r.name));
    d.appendChild(el('span','why', ' — ' + (r.reasons||[]).join('; ')));
    if(r.url){ const a=el('a','why',' repo'); a.href=r.url; a.target='_blank'; a.rel='noreferrer noopener'; d.appendChild(a); }
    rsk.appendChild(d);
  });
  if(feed.failures && feed.failures.length){ rec.appendChild(el('p','warn', "⚠ couldn't reach: " + feed.failures.map(function(f){ return f.source; }).join(', '))); }
}

async function loadConflicts(){
  const c = await get('/api/conflicts');
  const box = document.getElementById('conflicts'); box.innerHTML='';
  if(!c.findings.length){ box.appendChild(el('p','muted','No likely conflicts found.')); return; }
  c.findings.forEach(function(f){ box.appendChild(el('div','row warn','⚠ ['+f.agent+'] "'+f.a+'" vs "'+f.b+'" — '+f.axis)); });
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
