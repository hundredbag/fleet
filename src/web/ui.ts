/**
 * The dashboard page: a single self-contained HTML document (no framework, no
 * build step, no external resources — the CSP forbids them). Design: "command
 * deck" — card-based, light/dark themable, ko/en switchable (Korean default).
 * All dynamic values render via textContent (XSS-safe); the session token never
 * touches the URL after first load.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>fleet</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0c10; --glow:#141a26; --surface:#12151b; --elevated:#191e26; --border:#232936; --border-soft:#1a1f29;
    --text:#e8ebf0; --text-2:#9aa4b2; --text-3:#67707e;
    --accent:#f0b429; --accent-hi:#ffc94d; --accent-ink:#231a00;
    --green:#4cc38a; --red:#f2555a; --yellow:#d99b1d; --blue:#6ca7f5; --violet:#a78bfa;
    --orange:#f09046; --pink:#e17ec2; --hover:rgba(255,255,255,.02); --btn-hover:#20262f; --shadow:rgba(0,0,0,.5);
    --hdr:rgba(10,12,16,.82);
    --sans:-apple-system,'Segoe UI',Roboto,'Helvetica Neue','Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg:#f4f6f9; --glow:#e9eef5; --surface:#ffffff; --elevated:#ffffff; --border:#dbe1ea; --border-soft:#e7ebf1;
    --text:#1b2434; --text-2:#44506a; --text-3:#5d6980; /* small-text contrast ≥4.5:1 on white */
    --accent:#e8a812; --accent-hi:#f5bd33; --accent-ink:#231a00;
    --green:#1f9d63; --red:#d43f44; --yellow:#a87708; --blue:#2f6fd0; --violet:#7c5fd8;
    --orange:#d0741f; --pink:#c25ba3; --hover:rgba(20,30,50,.03); --btn-hover:#f0f3f8; --shadow:rgba(30,40,60,.18);
    --hdr:rgba(246,247,250,.85);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; font:14px/1.6 var(--sans); color:var(--text); word-break:keep-all;
    background:radial-gradient(1200px 500px at 50% -10%, var(--glow) 0%, var(--bg) 60%) fixed var(--bg);
  }
  /* ── header ─────────────────────────────────────────── */
  header {
    position:sticky; top:0; z-index:20; backdrop-filter:blur(8px);
    background:var(--hdr); border-bottom:1px solid var(--border-soft);
    display:flex; align-items:center; gap:10px; padding:10px 20px; flex-wrap:wrap;
  }
  .brand { display:flex; align-items:center; gap:9px; }
  .brand .mark { width:22px; height:22px; flex:none; }
  .brand h1 { font-size:17px; margin:0; letter-spacing:.02em; font-weight:700; }
  .brand .sub { color:var(--text-3); font-size:12px; }
  @media (max-width:640px){ .brand .sub { display:none; } }
  .spacer { flex:1; }
  #err { font-size:12.5px; color:var(--red); max-width:44ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #err.flash { color:var(--green); }
  button {
    font:600 13px/1 var(--sans); color:var(--text); background:var(--elevated);
    border:1px solid var(--border); border-radius:8px; padding:8px 13px; cursor:pointer;
    transition:background .12s, border-color .12s;
  }
  button:hover { background:var(--btn-hover); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
  button.primary:hover { background:var(--accent-hi); border-color:var(--accent-hi); }
  button.act { padding:5px 12px; font-size:12px; border-radius:7px; flex:none; }
  button.icon { padding:8px 10px; font-size:13px; }
  /* ── layout ─────────────────────────────────────────── */
  main { max-width:1160px; margin:0 auto; padding:18px 20px 10px; display:grid; gap:14px; }
  .statstrip { display:grid; grid-template-columns:repeat(6, 1fr); gap:10px; }
  @media (max-width:900px){ .statstrip { grid-template-columns:repeat(3, 1fr); } }
  @media (max-width:480px){ .statstrip { grid-template-columns:repeat(2, 1fr); } }
  .stat { background:var(--surface); border:1px solid var(--border-soft); border-radius:12px; padding:10px 14px 9px; min-width:0; }
  .stat .n { font-size:21px; font-weight:750; letter-spacing:-.02em; }
  .stat .l { font-size:11px; color:var(--text-3); letter-spacing:.05em; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:900px){ .grid2 { grid-template-columns:1fr; } }
  section.card { background:var(--surface); border:1px solid var(--border-soft); border-radius:14px; padding:14px 16px 12px; min-width:0; }
  section.card > .head { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; flex-wrap:wrap; }
  section.card h2 { font-size:14px; font-weight:700; margin:0; }
  section.card .hint { font-size:11.5px; color:var(--text-3); margin-left:auto; text-align:right; }
  .empty { color:var(--text-3); font-size:13px; border:1px dashed var(--border); border-radius:10px; padding:13px; text-align:center; }
  /* ── matrix ─────────────────────────────────────────── */
  .tblwrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:520px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border-soft); font-size:13px; }
  tr:last-child td { border-bottom:none; }
  th { color:var(--text-3); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.07em; }
  tbody tr:hover { background:var(--hover); }
  td.name { font-family:var(--mono); font-size:12.5px; overflow-wrap:anywhere; }
  td.cell { text-align:center; width:110px; }
  .chip { display:inline-block; font:600 10.5px/1 var(--sans); letter-spacing:.05em; text-transform:uppercase; padding:4px 8px; border-radius:99px; border:1px solid; white-space:nowrap; }
  /* per-kind chip colors via theme vars (light theme gets darker variants automatically) */
  .chip.mcp        { color:var(--blue);   border-color:color-mix(in srgb, var(--blue) 40%, transparent);   background:color-mix(in srgb, var(--blue) 10%, transparent); }
  .chip.skill      { color:var(--violet); border-color:color-mix(in srgb, var(--violet) 40%, transparent); background:color-mix(in srgb, var(--violet) 10%, transparent); }
  .chip.rule       { color:var(--green);  border-color:color-mix(in srgb, var(--green) 40%, transparent);  background:color-mix(in srgb, var(--green) 10%, transparent); }
  .chip.permission { color:var(--orange); border-color:color-mix(in srgb, var(--orange) 40%, transparent); background:color-mix(in srgb, var(--orange) 10%, transparent); }
  .chip.plugin     { color:var(--pink);   border-color:color-mix(in srgb, var(--pink) 40%, transparent);   background:color-mix(in srgb, var(--pink) 10%, transparent); }
  .chip.subagent   { color:var(--blue);   border-color:color-mix(in srgb, var(--blue) 40%, transparent);   background:color-mix(in srgb, var(--blue) 6%, transparent); }
  .chip.other      { color:var(--text-2); border-color:var(--border); background:var(--hover); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; background:var(--green); box-shadow:0 0 6px rgba(76,195,138,.5); }
  .dot.off { background:var(--border); box-shadow:none; }
  .pill { display:inline-block; font:600 11px/1 var(--mono); padding:3px 8px; border-radius:6px; margin:1px; }
  .pill.allow { color:var(--green); background:rgba(76,195,138,.12); }
  .pill.deny  { color:var(--red); background:rgba(242,85,90,.12); }
  .pill.ask   { color:var(--yellow); background:rgba(240,180,41,.14); }
  .pill.policy{ color:var(--text-2); background:rgba(154,164,178,.14); }
  td.cell.rm { cursor:pointer; }
  td.cell.rm:hover .dot { background:var(--red); box-shadow:0 0 6px rgba(242,85,90,.5); }
  /* ── list rows ──────────────────────────────────────── */
  .item { display:flex; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid var(--border-soft); }
  .item:last-child { border-bottom:none; }
  .item .body { min-width:0; flex:1; }
  .item .title { font-weight:650; font-size:13.5px; display:flex; align-items:center; gap:7px; flex-wrap:wrap; overflow-wrap:anywhere; min-width:0; }
  .item .title .id { font-family:var(--mono); font-weight:400; font-size:11.5px; color:var(--text-3); overflow-wrap:anywhere; }
  .item .desc { font-size:12.5px; color:var(--text-2); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  @media (max-width:640px){ .item .desc { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; } }
  .item .meta { font-size:11.5px; color:var(--text-3); margin-top:2px; overflow-wrap:anywhere; }
  .item .meta .warn { color:var(--yellow); }
  .item a { color:var(--blue); text-decoration:none; font-size:12px; white-space:nowrap; }
  .item a:hover { text-decoration:underline; }
  .badge { display:inline-block; font:700 10px/1 var(--sans); letter-spacing:.06em; padding:3.5px 7px; border-radius:6px; text-transform:uppercase; }
  .badge.new { color:var(--accent-ink); background:var(--accent); }
  .badge.pop { color:var(--blue); background:color-mix(in srgb, var(--blue) 12%, transparent); border:1px solid color-mix(in srgb, var(--blue) 30%, transparent); }
  .catchip { display:inline-block; font:600 10.5px/1 var(--mono); padding:3px 7px; border-radius:6px;
    color:var(--violet); background:rgba(167,139,250,.12); border:1px solid rgba(167,139,250,.28); white-space:nowrap; }
  .upver { font-family:var(--mono); font-size:12px; color:var(--green); }
  .srcwarn { margin-top:10px; font-size:12px; color:var(--yellow); }
  /* ── preview overlay ────────────────────────────────── */
  #overlay { position:fixed; inset:0; z-index:50; display:none; background:rgba(5,7,10,.55); }
  #overlay.show { display:flex; align-items:flex-start; justify-content:center; padding:12vh 16px 0; }
  #preview { width:min(560px, 100%); background:var(--elevated); border:1px solid var(--border);
    border-radius:14px; padding:18px 20px 16px; box-shadow:0 18px 60px var(--shadow); }
  #preview .ptitle { font-weight:700; font-size:14.5px; margin-bottom:10px; }
  #preview .row { font-family:var(--mono); font-size:12.5px; padding:3px 0; color:var(--text-2); overflow-wrap:anywhere; }
  #preview .row.add { color:var(--green); }
  #preview .row.del { color:var(--red); }
  #preview .row.warn { color:var(--yellow); }
  #preview .row.muted { color:var(--text-3); }
  .pactions { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  /* detail modal rows */
  .drow { display:flex; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid var(--border-soft); font-size:13px; }
  .drow:last-of-type { border-bottom:none; }
  .dlabel { color:var(--text-2); min-width:120px; display:flex; align-items:center; gap:7px; flex:none; }
  .dval { color:var(--text); overflow-wrap:anywhere; display:flex; align-items:center; gap:10px; justify-content:space-between; flex:1; min-width:0; }
  .dval .faint { color:var(--text-3); font-size:12.5px; }
  .dsect { font-weight:700; font-size:12px; color:var(--text-3); text-transform:uppercase; letter-spacing:.07em; margin-top:12px; padding-bottom:4px; }
  /* sort segmented control */
  .seg { display:inline-flex; gap:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  .seg button { border:none; border-radius:0; padding:5px 11px; font-size:11.5px; background:transparent; color:var(--text-2); }
  .seg button + button { border-left:1px solid var(--border-soft); }
  .seg button.active { background:var(--accent); color:var(--accent-ink); font-weight:700; }
  .foot { color:var(--text-3); font-size:12px; text-align:center; padding:8px 20px 24px; }
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
    <span class="sub" data-t="sub"></span>
  </div>
  <span class="spacer"></span>
  <span id="err"></span>
  <button id="lang" class="icon" title="language"></button>
  <button id="theme" class="icon" title="theme"></button>
  <button id="rollback" data-t="rollback"></button>
  <button id="refresh" class="primary" data-t="refresh"></button>
</header>
<main>
  <div class="statstrip">
    <div class="stat"><div class="n" id="st-agents">–</div><div class="l" data-t="stAgents"></div></div>
    <div class="stat"><div class="n" id="st-mcp">–</div><div class="l" data-t="stMcp"></div></div>
    <div class="stat"><div class="n" id="st-skill">–</div><div class="l" data-t="stSkill"></div></div>
    <div class="stat"><div class="n" id="st-rule">–</div><div class="l" data-t="stRule"></div></div>
    <div class="stat"><div class="n" id="st-plugin">–</div><div class="l" data-t="stPlugin"></div></div>
    <div class="stat"><div class="n" id="st-upd">–</div><div class="l" data-t="stUpd"></div></div>
  </div>
  <section class="card">
    <div class="head"><h2 data-t="invTitle"></h2><span class="hint" data-t="invHint"></span></div>
    <div class="tblwrap"><div id="inventory"></div></div>
  </section>
  <div class="grid2">
    <section class="card">
      <div class="head"><h2 data-t="updTitle"></h2><span class="hint" data-t="updHint"></span></div>
      <div id="updates"></div>
    </section>
    <section class="card">
      <div class="head"><h2 data-t="cfTitle"></h2><span class="hint" data-t="cfHint"></span></div>
      <div id="conflicts"></div>
    </section>
  </div>
  <section class="card">
    <div class="head"><h2 data-t="recTitle"></h2><span class="seg" id="sort-rec"></span><span class="hint" data-t="recHint"></span></div>
    <div id="recommended"></div>
  </section>
  <section class="card">
    <div class="head"><h2 data-t="skTitle"></h2><span class="seg" id="sort-sk"></span><span class="hint" data-t="skHint"></span></div>
    <div id="recskills"></div>
  </section>
  <section class="card">
    <div class="head"><h2 data-t="plTitle"></h2><span class="hint" data-t="plHint"></span></div>
    <div id="recplugins"></div>
  </section>
</main>
<div class="foot" data-t="foot"></div>
<div id="overlay"><div id="preview"></div></div>
<script>
// storage may be blocked (private mode / cookie-block) — a throw must not kill the page
function sGet(store, k){ try { return store.getItem(k); } catch(e){ return null; } }
function sSet(store, k, v){ try { store.setItem(k, v); } catch(e){} }
// Take the token off the URL: stash in sessionStorage and strip ?token= so it
// doesn't linger in history or leak via a future Referer.
let token = sGet(sessionStorage, 'fleet_token') || '';
const qtok = new URLSearchParams(location.search).get('token');
if (qtok) { token = qtok; sSet(sessionStorage, 'fleet_token', qtok); history.replaceState(null, '', location.pathname); }

/* ── i18n (ko default) ─────────────────────────────────── */
const I18N = {
  ko: {
    sub:'크로스-에이전트 능력 관리자', rollback:'롤백', refresh:'새로고침',
    stAgents:'에이전트', stMcp:'MCP 서버', stSkill:'스킬', stRule:'룰', stPlugin:'플러그인', stUpd:'업데이트',
    invTitle:'인벤토리', invHint:'행을 클릭하면 상세 · 에이전트별 설치/제거',
    dStatus:'에이전트별 상태', dDesc:'설명', dRuns:'실행 명령', dPath:'경로', dMarket:'마켓', dVer:'버전', dTokens:'컨텍스트 비용(추정)',
    dInstalled:'설치됨', dNot:'없음', dInstallTo:'{a}에 설치', dRemoveFrom:'{a}에서 제거', dInstallAllMissing:'없는 에이전트 모두에 설치',
    dInfoOnly:'이 종류({k})는 읽기 전용이에요 — fleet은 조회만 하고 변경하지 않아요.', close:'닫기',
    updTitle:'업데이트', updHint:'레지스트리에 새 버전이 있는 항목',
    cfTitle:'충돌', cfHint:'상시 룰 간 상충 · 휴리스틱',
    recTitle:'추천 MCP 서버', recHint:'내 설정 기준 추천 · 휴리스틱',
    skTitle:'추천 스킬', skHint:'스킬 레지스트리 샘플 — 전체 아님',
    plTitle:'추천 플러그인', plHint:'등록된 마켓 카탈로그 기준 · 설치는 CLI',
    emptyPl:'등록된 마켓에 추천할 플러그인이 없습니다.', fromMarket:'마켓에서 설치 가능',
    installHint:'설치: fleet plugin install {id} --to claude-code  (미리보기 확인 후 --commit)',
    sortRec:'추천순', sortNew:'최신순', sortPop:'인기순',
    skillUp:'스킬 원본이 갱신됨 — 재설치로 업데이트', skillUpLocal:'원본 갱신 + 로컬 수정 있음 — 재설치 시 수정 덮어씀',
    foot:'추천·충돌은 휴리스틱입니다 — 적용 전에 직접 확인하세요. 피드가 비면 소스에 접속 못 했을 수 있습니다.',
    kind:'종류', cap:'이름', emptyInv:'아직 설치된 것이 없어요 — 아래 추천을 둘러보세요.',
    emptyUpd:'고정된 버전은 모두 최신입니다.', emptyCf:'충돌 후보가 없습니다.', emptyRec:'지금은 추천이 없습니다.', emptySk:'지금은 스킬 추천이 없습니다.',
    install:'설치', update:'업데이트', repo:'저장소 →', badgeNew:'NEW', badgePop:'인기',
    related:'관련', conflictOn:'상충 가능', cantReach:'접속 실패: ',
    pvTitle:'미리보기 — {n}개 변경', pvNone:'적용할 것 없음 ({s})', pvRuns:'실행: ',
    confirm:'확인 후 적용', cancel:'취소', pickTitle:'어느 에이전트에 설치할까요?', allAgents:'모든 에이전트',
    applied:'적용됨 ✓', done:'완료: ', rolled:'롤백됨: ', removeFrom:'{a}에서 제거',
    ops:{ install:'설치', remove:'제거', update:'업데이트' },
    statuses:{ preview:'미리보기', 'nothing-to-do':'변경 없음', applied:'적용됨', refused:'거부됨', failed:'실패' },
    axes:{ verbosity:'응답 길이', autonomy:'자율성', tone:'말투' },
  },
  en: {
    sub:'cross-agent capability manager', rollback:'Rollback', refresh:'Refresh',
    stAgents:'agents', stMcp:'MCP servers', stSkill:'skills', stRule:'rules', stPlugin:'plugins', stUpd:'updates',
    invTitle:'Inventory', invHint:'click a row for details · per-agent install/remove',
    dStatus:'Status by agent', dDesc:'Description', dRuns:'Runs', dPath:'Path', dMarket:'Marketplace', dVer:'Version', dTokens:'Context cost (est.)',
    dInstalled:'installed', dNot:'not installed', dInstallTo:'Install to {a}', dRemoveFrom:'Remove from {a}', dInstallAllMissing:'Install to all missing agents',
    dInfoOnly:'{k} is read-only — fleet inventories it but never changes it.', close:'Close',
    updTitle:'Updates', updHint:'newer version on the registry',
    cfTitle:'Conflicts', cfHint:'opposing always-on rules · heuristic',
    recTitle:'Recommended MCP servers', recHint:'for your setup · heuristic',
    skTitle:'Recommended skills', skHint:'sampled from skill registries — not exhaustive',
    plTitle:'Recommended plugins', plHint:'from your registered marketplaces · install via CLI',
    emptyPl:'No plugin recommendations from registered marketplaces.', fromMarket:'in your marketplace',
    installHint:'install: fleet plugin install {id} --to claude-code  (preview first, then --commit)',
    sortRec:'Top', sortNew:'Newest', sortPop:'Popular',
    skillUp:'skill source updated — reinstall to update', skillUpLocal:'source updated + LOCAL EDITS — reinstall overwrites them',
    foot:'Recommendations & conflicts are heuristic — verify before acting. An empty feed may mean sources were unreachable.',
    kind:'kind', cap:'capability', emptyInv:'Nothing installed yet — try the recommendations below.',
    emptyUpd:'Everything pinned is current.', emptyCf:'No likely conflicts found.', emptyRec:'No recommendations right now.', emptySk:'No skill recommendations right now.',
    install:'Install', update:'Update', repo:'repo →', badgeNew:'NEW', badgePop:'POPULAR',
    related:'related', conflictOn:'possible conflict', cantReach:"couldn't reach: ",
    pvTitle:'Preview — {n} change(s)', pvNone:'Nothing to apply ({s})', pvRuns:'runs: ',
    confirm:'Confirm & apply', cancel:'Cancel', pickTitle:'Install to which agent(s)?', allAgents:'All agents',
    applied:'Applied ✓', done:'Done: ', rolled:'Rolled back: ', removeFrom:'remove from {a}',
    ops:{}, statuses:{}, axes:{},
  },
};
let lang = sGet(localStorage, 'fleet_lang') || 'ko';
function T(k){ return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; }
/* server enum words (op/status/axis) get a ko mapping; unknown values pass through */
function TT(map, v){ const m = I18N[lang][map] || {}; return m[v] || v; }
function applyStatic(){
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(function(n){ n.textContent = T(n.getAttribute('data-t')); });
  document.getElementById('lang').textContent = lang === 'ko' ? 'EN' : '한';
  document.getElementById('theme').textContent = theme === 'dark' ? '☀' : '🌙';
}

/* ── theme ─────────────────────────────────────────────── */
let theme = sGet(localStorage, 'fleet_theme') ||
  (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function applyTheme(){ document.documentElement.setAttribute('data-theme', theme); }
applyTheme();

async function get(path){
  const r = await fetch(path, { headers: { 'authorization': 'Bearer ' + token } });
  if(!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return r.json();
}
function el(tag, cls, txt){ const e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
function stat(id, n){ document.getElementById(id).textContent = String(n); }

const KINDS = ['mcp','skill','rule','permission','plugin','subagent'];
function kindChip(kind){
  return el('span','chip ' + (KINDS.indexOf(kind) >= 0 ? kind : 'other'), kind);
}
/* remote URLs may be hostile — only https ever becomes a link (javascript: would
 * execute in this origin; the CSP permits inline script). */
function safeHttpUrl(u){ return (typeof u === 'string' && /^https:\\/\\//i.test(u)) ? u : null; }
/* reasons[] → badges (NEW/인기) + remaining text (e.g. relevance) */
function reasonBits(reasons){
  const badges = [], rest = [];
  (reasons||[]).forEach(function(r){
    if(r === 'new') badges.push(['new', T('badgeNew')]);
    else if(r === 'popular') badges.push(['pop', T('badgePop')]);
    else if(r === 'marketplace') rest.push(T('fromMarket'));
    else {
      const m = /^related to your setup \\((.+)\\)$/.exec(r);
      rest.push(m ? (T('related') + ': ' + m[1]) : r);
    }
  });
  return { badges: badges, text: rest.join(' · ') };
}

/* ── sort controls (client-side over the fetched slice) ── */
const sorts = { rec:'rec', sk:'rec' };
function ts(v){ const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; } // missing → last (0 < any real date)
const SORT_FNS = {
  rec: function(a,b){ return b.score - a.score; },
  new: function(a,b){ return ts(b.updatedAt) - ts(a.updatedAt); },
  pop: function(a,b){ return (b.popularity||0) - (a.popularity||0); },
};
function renderSortSeg(elId, key){
  const box = document.getElementById(elId); box.innerHTML='';
  [['rec','sortRec'],['new','sortNew'],['pop','sortPop']].forEach(function(pair){
    const b = el('button', sorts[key]===pair[0] ? 'active' : null, T(pair[1]));
    b.addEventListener('click', function(){ sorts[key]=pair[0]; if(cache.feed) renderFeed(cache.feed); });
    box.appendChild(b);
  });
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
function showPreview(res, onConfirm){
  const preview = res.preview || res;
  const bar = document.getElementById('preview'); bar.innerHTML='';
  document.getElementById('overlay').className='show';
  const changes = preview.changes || [];
  bar.appendChild(el('div','ptitle', changes.length ? T('pvTitle').replace('{n}', changes.length) : T('pvNone').replace('{s}', TT('statuses', preview.status))));
  if(res.runs){ bar.appendChild(el('div','row', T('pvRuns')+res.runs)); }
  changes.forEach(function(c){
    bar.appendChild(el('div','row '+(c.op==='remove'?'del':'add'), (c.op==='remove'?'− ':'+ ')+'['+c.agent+'] '+TT('ops', c.op)+' "'+c.name+'"'));
    (c.warnings||[]).forEach(function(w){ bar.appendChild(el('div','row warn','  ⚠ '+w)); });
  });
  (preview.skips||[]).forEach(function(s){ bar.appendChild(el('div','row muted','· ['+s.agent+'] '+s.reason)); });
  const act = el('div','pactions');
  const cancel=el('button',null,T('cancel')); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
  if(changes.length){ const ok=el('button','primary',T('confirm')); ok.addEventListener('click', onConfirm); act.appendChild(ok); }
  bar.appendChild(act);
}
async function doPlan(req){
  setErr('');
  try {
    const res = await postJson('/api/plan', req);
    const planId = res.planId; // closure-captured: no cross-plan race
    showPreview(res, async function(){
      try {
        const applied = await postJson('/api/apply', { planId: planId });
        clearPreview(); await refresh();
        flash(applied.status==='applied' ? T('applied') : (T('done')+TT('statuses', applied.status)));
      } catch(e){ setErr(e); clearPreview(); }
    });
  } catch(e){ setErr(e); }
}
function pickAgentsThen(cb){
  const bar = document.getElementById('preview'); bar.innerHTML='';
  document.getElementById('overlay').className='show';
  bar.appendChild(el('div','ptitle',T('pickTitle')));
  const act = el('div','pactions');
  const cancel=el('button',null,T('cancel')); cancel.addEventListener('click', clearPreview); act.appendChild(cancel);
  agents.forEach(function(a){ const b=el('button',null,a); b.addEventListener('click', function(){ cb([a]); }); act.appendChild(b); });
  const allb = el('button','primary',T('allAgents')); allb.addEventListener('click', function(){ cb('all'); }); act.appendChild(allb);
  bar.appendChild(act);
}
/* ── inventory detail modal ────────────────────────────── */
function itemsOf(kind, name){
  const inv = cache.inv; if(!inv) return [];
  const src = kind==='mcp' ? inv.servers : kind==='skill' ? inv.skills : kind==='rule' ? inv.rules
    : kind==='permission' ? (inv.permissions||[]) : kind==='subagent' ? (inv.subagents||[]) : (inv.plugins||[]);
  return src.filter(function(x){ return x.name === name; });
}
function kv(box, label, value){
  if(value == null || value === '') return;
  const row = el('div','drow');
  row.appendChild(el('span','dlabel', label));
  row.appendChild(el('span','dval', String(value)));
  box.appendChild(row);
}
function openDetail(kind, name){
  const found = itemsOf(kind, name);
  const bar = document.getElementById('preview'); bar.innerHTML='';
  document.getElementById('overlay').className='show';
  const head = el('div','ptitle');
  head.appendChild(kindChip(kind));
  head.appendChild(el('span',null,' ' + name));
  bar.appendChild(head);
  const first = found[0] || {};
  const desc = first.description || (first.meta && first.meta.description);
  if(desc) kv(bar, T('dDesc'), desc);
  if(first.target) kv(bar, T('dRuns'), first.target);
  if(first.version || (first.meta && first.meta.version)) kv(bar, T('dVer'), first.version || first.meta.version);
  if(first.marketplace) kv(bar, T('dMarket'), first.marketplace);
  if(first.tools && first.tools.length) kv(bar, 'tools', first.tools.join(', '));
  if(first.model) kv(bar, 'model', first.model);
  if(first.tokensEst != null) kv(bar, T('dTokens'), '~' + first.tokensEst + ' tokens' + (kind === 'rule' ? ' · always-on' : ''));
  bar.appendChild(el('div','dsect', T('dStatus')));
  // core kind name for the API; permission/subagent have no writer → read-only
  const CORE_KIND = { mcp:'mcp-server', skill:'skill', rule:'rule', plugin:'plugin' };
  const coreKind = CORE_KIND[kind];
  const canAct = !!coreKind;
  const haveAgents = found.map(function(x){ return x.agent; });
  agents.forEach(function(a){
    const mine = found.filter(function(x){ return x.agent === a; });
    const row = el('div','drow');
    const st = el('span','dlabel');
    st.appendChild(el('span', 'dot' + (mine.length ? '' : ' off')));
    st.appendChild(el('span', null, ' ' + a));
    row.appendChild(st);
    const right = el('span','dval');
    if(mine.length){
      const bits = mine.map(function(x){
        return (x.scope||'') + (x.enabled === false ? ' · off' : '') + (x.effect ? ' · '+x.effect : '');
      }).join(', ');
      right.appendChild(el('span','faint', bits || T('dInstalled')));
      if(canAct){
        const b = el('button','act', T('dRemoveFrom').replace('{a}', a));
        b.addEventListener('click', function(){ doPlan({ action:'remove', kind:coreKind, name:name, from:[a] }); });
        right.appendChild(b);
      }
    } else {
      right.appendChild(el('span','faint', T('dNot')));
      if(canAct && haveAgents.length){
        const b = el('button','act primary', T('dInstallTo').replace('{a}', a));
        if(coreKind === 'plugin'){
          // plugins re-install from their source marketplace on the target agent
          const srcEntry = found.filter(function(x){ return x.agent === haveAgents[0]; })[0] || {};
          b.addEventListener('click', function(){ doPlan({ action:'install', kind:'plugin', name:name, to:[a], marketplace:srcEntry.marketplace }); });
        } else {
          b.addEventListener('click', function(){ doPlan({ action:'sync', kind:coreKind, name:name, from:haveAgents[0], to:[a] }); });
        }
        right.appendChild(b);
      }
    }
    row.appendChild(right);
    bar.appendChild(row);
  });
  // one-click "put this on every agent that's missing it"
  const missing = agents.filter(function(a){ return haveAgents.indexOf(a) < 0; });
  if(canAct && haveAgents.length && missing.length > 1){
    const allBtn = el('button','act primary', T('dInstallAllMissing'));
    allBtn.style.marginTop = '8px';
    allBtn.addEventListener('click', function(){
      if(coreKind === 'plugin'){
        const srcEntry = found.filter(function(x){ return x.agent === haveAgents[0]; })[0] || {};
        // plugins target one agent each — fire them sequentially via the picker-less path
        doPlan({ action:'install', kind:'plugin', name:name, to:[missing[0]], marketplace:srcEntry.marketplace });
      } else {
        doPlan({ action:'sync', kind:coreKind, name:name, from:haveAgents[0], to:missing });
      }
    });
    bar.appendChild(allBtn);
  }
  if(!canAct){ bar.appendChild(el('div','meta', T('dInfoOnly').replace('{k}', kind))); }
  const act = el('div','pactions');
  const close = el('button',null,T('close')); close.addEventListener('click', clearPreview); act.appendChild(close);
  bar.appendChild(act);
}

async function doRollback(){
  setErr('');
  try { const r = await postJson('/api/rollback', {}); await refresh(); flash(T('rolled') + (r.action || 'done')); }
  catch(e){ setErr(e); }
}

/* last responses cached so a language toggle re-renders instantly, offline */
const cache = { inv:null, feed:null, conf:null };

async function loadInventory(){
  cache.inv = await get('/api/inventory');
  renderInventory(cache.inv);
}
function renderInventory(inv){
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
  (inv.subagents||[]).forEach(function(s){ add('subagent', s); });
  const box = document.getElementById('inventory'); box.innerHTML='';
  const keys = Object.keys(rows);
  if(keys.length===0){ box.appendChild(el('p','empty',T('emptyInv'))); return; }
  const table = el('table');
  const thead = el('thead'); const head = el('tr');
  head.appendChild(el('th',null,T('kind'))); head.appendChild(el('th',null,T('cap')));
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
          String(row.effects[a]).split(',').forEach(function(eff){ td.appendChild(el('span','pill '+eff, eff)); });
        } else {
          td.appendChild(el('span','dot'));
        }
      } else {
        td.appendChild(el('span','dot off'));
      }
      tr.appendChild(td);
    });
    tr.style.cursor='pointer';
    tr.addEventListener('click', function(){ openDetail(row.kind, row.name); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
}

function titleRow(name, id){
  const t = el('div','title');
  t.appendChild(el('span',null,name));
  if(id) t.appendChild(el('span','id', id));
  return t;
}
function addBadges(t, badges){
  badges.forEach(function(b){ t.appendChild(el('span','badge '+b[0], b[1])); });
}

async function loadFeed(live){
  cache.feed = await get('/api/feed' + (live ? '?refresh=1' : ''));
  renderFeed(cache.feed);
}
function renderFeed(feed){
  stat('st-upd', feed.updates.length + ((feed.skillUpdates||[]).length));
  const up = document.getElementById('updates'); up.innerHTML='';
  var totalUps = feed.updates.length + ((feed.skillUpdates||[]).length);
  if(!totalUps) up.appendChild(el('p','empty',T('emptyUpd')));
  (feed.skillUpdates||[]).forEach(function(u){
    var d = el('div','item');
    var body = el('div','body');
    var t = titleRow(u.name, '['+u.agent+']');
    body.appendChild(t);
    var m = el('div','meta');
    if(u.state === 'update+local-edits'){
      m.appendChild(el('span','warn','\u26a0 ' + T('skillUpLocal')));
    } else {
      m.appendChild(el('span',null, T('skillUp')));
    }
    body.appendChild(m);
    var hint = el('div','meta');
    hint.appendChild(el('span','faint', u.applyHint));
    body.appendChild(hint);
    d.appendChild(body);
    up.appendChild(d);
  });
  feed.updates.forEach(function(u){
    const d = el('div','item');
    const body = el('div','body');
    const t = titleRow(u.name, '['+u.agent+']');
    body.appendChild(t);
    const m = el('div','meta');
    m.appendChild(el('span','upver', u.installed+' → '+u.available));
    body.appendChild(m);
    d.appendChild(body);
    if(u.identifier && (u.ecosystem==='npm' || u.ecosystem==='pypi')){
      const b=el('button','act primary',T('update')); b.addEventListener('click', function(){ doPlan({ action:'update', name:u.name, to:[u.agent], coordinate:{ version:u.available } }); }); d.appendChild(b);
    }
    up.appendChild(d);
  });
  const rec = document.getElementById('recommended'); rec.innerHTML='';
  const rsk = document.getElementById('recskills'); rsk.innerHTML='';
  const rpl = document.getElementById('recplugins'); rpl.innerHTML='';
  renderSortSeg('sort-rec','rec'); renderSortSeg('sort-sk','sk');
  const servers = (feed.recommendations||[]).filter(function(r){ return !r.kind || r.kind === 'mcp-server'; }).slice().sort(SORT_FNS[sorts.rec]);
  const skills = (feed.recommendations||[]).filter(function(r){ return r.kind === 'skill'; }).slice().sort(SORT_FNS[sorts.sk]);
  const plugins = (feed.recommendations||[]).filter(function(r){ return r.kind === 'plugin'; });
  if(!servers.length) rec.appendChild(el('p','empty',T('emptyRec')));
  servers.forEach(function(r){
    const bits = reasonBits(r.reasons);
    const d = el('div','item');
    const body = el('div','body');
    const t = titleRow(r.name, r.identifier);
    addBadges(t, bits.badges);
    body.appendChild(t);
    if(r.description){ body.appendChild(el('div','desc', r.description)); }
    const metaBits = [];
    if(bits.text) metaBits.push(bits.text);
    const m = el('div','meta');
    if(metaBits.length) m.appendChild(el('span',null, metaBits.join(' · ')));
    if(r.trust && r.trust.level==='caution'){ m.appendChild(el('span','warn',' ⚠ ' + (r.trust.reasons||[]).join(', '))); }
    if(m.childNodes.length) body.appendChild(m);
    d.appendChild(body);
    if(r.identifier && (r.ecosystem==='npm' || r.ecosystem==='pypi')){
      const b = el('button','act',T('install')); b.addEventListener('click', function(){ pickAgentsThen(function(to){ doPlan({ action:'install', name:r.name, to:to, coordinate:{ ecosystem:r.ecosystem, identifier:r.identifier } }); }); }); d.appendChild(b);
    }
    rec.appendChild(d);
  });
  if(!skills.length) rsk.appendChild(el('p','empty',T('emptySk')));
  skills.forEach(function(r){
    const bits = reasonBits(r.reasons);
    const d = el('div','item');
    const body = el('div','body');
    const t = el('div','title');
    t.appendChild(el('span','catchip', r.category||'other'));
    t.appendChild(el('span',null, r.name));
    addBadges(t, bits.badges);
    body.appendChild(t);
    if(r.description){ body.appendChild(el('div','desc', r.description)); }
    if(bits.text){ const m = el('div','meta'); m.appendChild(el('span',null,bits.text)); body.appendChild(m); }
    d.appendChild(body);
    const safeUrl = safeHttpUrl(r.url);
    if(safeUrl){ const a=el('a',null,T('repo')); a.href=safeUrl; a.target='_blank'; a.rel='noreferrer noopener'; d.appendChild(a); }
    rsk.appendChild(d);
  });
  if(!plugins.length) rpl.appendChild(el('p','empty',T('emptyPl')));
  plugins.forEach(function(r){
    const d = el('div','item');
    const body = el('div','body');
    const t = el('div','title');
    t.appendChild(el('span','catchip', r.category||'other'));
    t.appendChild(el('span',null, r.name));
    body.appendChild(t);
    if(r.description){ body.appendChild(el('div','desc', r.description)); }
    const m = el('div','meta');
    m.appendChild(el('span',null, T('installHint').replace('{id}', r.identifier || r.name)));
    body.appendChild(m);
    d.appendChild(body);
    rpl.appendChild(d);
  });
  if(feed.failures && feed.failures.length){ rec.appendChild(el('p','srcwarn', '⚠ ' + T('cantReach') + feed.failures.map(function(f){ return f.source; }).join(', '))); }
}

async function loadConflicts(){
  cache.conf = await get('/api/conflicts');
  renderConflicts(cache.conf);
}
function renderConflicts(c){
  const box = document.getElementById('conflicts'); box.innerHTML='';
  if(!c.findings.length){ box.appendChild(el('p','empty',T('emptyCf'))); return; }
  c.findings.forEach(function(f){
    const d = el('div','item');
    const body = el('div','body');
    body.appendChild(el('div','title', '"'+f.a+'" vs "'+f.b+'"'));
    const m = el('div','meta');
    m.appendChild(el('span','warn','⚠ '+TT('axes', f.axis)+' — '+T('conflictOn')));
    m.appendChild(el('span',null,' ['+f.agent+']'));
    body.appendChild(m);
    d.appendChild(body);
    box.appendChild(d);
  });
}

async function refresh(){
  try { await Promise.all([loadInventory(), loadFeed(refresh._live === true), loadConflicts()]); document.getElementById('err').textContent=''; }
  catch(e){ setErr(e); }
}
document.getElementById('refresh').addEventListener('click', function(){ refresh._live = true; refresh().finally(function(){ refresh._live = false; }); });
document.getElementById('rollback').addEventListener('click', doRollback);
document.getElementById('theme').addEventListener('click', function(){
  theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); applyStatic(); sSet(localStorage, 'fleet_theme', theme);
});
document.getElementById('lang').addEventListener('click', function(){
  lang = lang === 'ko' ? 'en' : 'ko'; applyStatic(); sSet(localStorage, 'fleet_lang', lang);
  // instant, offline re-render from cache (no refetch; nothing stays stale)
  if(cache.inv) renderInventory(cache.inv);
  if(cache.feed) renderFeed(cache.feed);
  if(cache.conf) renderConflicts(cache.conf);
  if(!cache.inv) refresh();
});
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') clearPreview(); });
applyStatic();
refresh();
</script>
</body>
</html>`;
}
