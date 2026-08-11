interface ShellAssets {
  css: string;
  client: string;
}

export function renderShell({ css, client }: ShellAssets): string {
  return `<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>fleet</title>
<style>${css}</style>
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
<div class="foot"><span data-t="foot"></span></div>
<div id="overlay"><div id="preview"></div></div>
<script>${client}</script>
</body>
</html>`;
}
