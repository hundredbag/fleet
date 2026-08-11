export const DASHBOARD_CLIENT = `
// Storage can be unavailable in privacy modes; shell startup must remain safe.
function sGet(store, key){ try { return store.getItem(key); } catch(e){ return null; } }
function sSet(store, key, value){ try { store.setItem(key, value); } catch(e){} }
function storage(name){ try { return window[name]; } catch(e){ return null; } }
const localStore = storage('localStorage');
const sessionStore = storage('sessionStorage');

// Apply the persisted preference in <head>, before first paint. The rest of the
// client waits for the document so the page still uses exactly one inline script.
let theme = sGet(localStore, 'fleet_theme');
if(theme !== 'light' && theme !== 'dark') theme = 'dark';
document.documentElement.setAttribute('data-theme', theme);

// Capture the bearer token once, then remove it from browser history and Referer data.
let token = sGet(sessionStore, 'fleet_token') || '';
const suppliedToken = new URLSearchParams(location.search).get('token');
const allowedHash = /^#(?:overview|inventory|discover|drift|activity)$/;
if(suppliedToken){
  token = suppliedToken;
  sSet(sessionStore, 'fleet_token', suppliedToken);
  history.replaceState(null, '', location.pathname + (allowedHash.test(location.hash) ? location.hash : ''));
}

async function get(path){
  const response = await fetch(path, { headers:{ authorization:'Bearer ' + token } });
  if(!response.ok) throw new Error(path + ': HTTP ' + response.status);
  return response.json();
}
async function postJson(path, body){
  const response = await fetch(path, {
    method:'POST',
    headers:{ authorization:'Bearer ' + token, 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
  const data = await response.json().catch(function(){ return {}; });
  if(!response.ok){
    const code = data && typeof data.code === 'string' && /^[A-Z0-9_]+$/.test(data.code)
      ? data.code : 'REQUEST_FAILED';
    throw new Error('Request failed (' + code + ').');
  }
  return data;
}
// Keep remote text inert. Future renderers may only create links for HTTPS URLs.
function safeHttpUrl(value){ return typeof value === 'string' && /^https:\\/\\//i.test(value) ? value : null; }

document.addEventListener('DOMContentLoaded', function(){
const views = ['overview','inventory','discover','drift','activity'];
const viewTitles = { overview:'Overview', inventory:'Inventory', discover:'Discover', drift:'Drift', activity:'Activity' };
function requestedView(){
  const value = location.hash.slice(1);
  return views.indexOf(value) >= 0 ? value : 'overview';
}
function activateView(focusHeading){
  const view = requestedView();
  if(location.hash !== '#' + view) history.replaceState(null, '', location.pathname + location.search + '#' + view);
  document.querySelectorAll('[data-view]').forEach(function(section){
    const active = section.getAttribute('data-view') === view;
    section.hidden = !active;
    if(active && focusHeading){
      const heading = section.querySelector('h1');
      if(heading) heading.focus({ preventScroll:true });
    }
  });
  document.querySelectorAll('[data-nav-view]').forEach(function(link){
    if(link.getAttribute('data-nav-view') === view) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  document.getElementById('current-view-title').textContent = viewTitles[view];
  document.title = viewTitles[view] + ' · Fleet';
}
window.addEventListener('hashchange', function(){ activateView(true); });
document.querySelectorAll('[data-nav-view]').forEach(function(link){
  link.addEventListener('click', function(){
    if(location.hash === link.getAttribute('href')) activateView(true);
  });
});
activateView(false);

const themeButton = document.getElementById('theme');
function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme);
  const next = theme === 'dark' ? 'light' : 'dark';
  themeButton.textContent = next === 'light' ? 'Light theme' : 'Dark theme';
  themeButton.setAttribute('aria-label', 'Switch to ' + next + ' theme');
}
applyTheme();
themeButton.addEventListener('click', function(){
  theme = theme === 'dark' ? 'light' : 'dark';
  sSet(localStore, 'fleet_theme', theme);
  applyTheme();
});

const live = document.getElementById('err');
function announce(message, isError){
  live.className = 'live-region' + (isError ? ' error' : '');
  live.textContent = message;
}
let refreshGeneration = 0;
const refreshButton = document.getElementById('refresh');
async function refresh(){
  const generation = ++refreshGeneration;
  refreshButton.disabled = true;
  announce('Refreshing Fleet data…', false);
  try {
    await Promise.all([get('/api/inventory'), get('/api/feed?refresh=1'), get('/api/conflicts')]);
    if(generation === refreshGeneration) announce('Fleet data refreshed.', false);
  } catch(error){
    if(generation === refreshGeneration) announce(error && error.message ? error.message : 'Refresh failed.', true);
  } finally {
    if(generation === refreshGeneration) refreshButton.disabled = false;
  }
}
refreshButton.addEventListener('click', refresh);

const overlay = document.getElementById('overlay');
const dialogTitle = document.getElementById('dialog-title');
const dialogContent = document.getElementById('dialog-content');
const dialogConfirm = document.getElementById('dialog-confirm');
const dialogCancel = document.getElementById('dialog-cancel');
const appShell = document.querySelector('.app-shell');
let confirmAction = null;
let returnFocus = null;
function closeDialog(){
  overlay.hidden = true;
  appShell.removeAttribute('inert');
  confirmAction = null;
  if(returnFocus) returnFocus.focus();
}
function openDialog(title, message, action){
  returnFocus = document.activeElement;
  dialogTitle.textContent = title;
  dialogContent.textContent = message;
  confirmAction = action;
  appShell.setAttribute('inert', '');
  overlay.hidden = false;
  dialogCancel.focus();
}
dialogCancel.addEventListener('click', closeDialog);
dialogConfirm.addEventListener('click', function(){ if(confirmAction) confirmAction(); });
overlay.addEventListener('click', function(event){ if(event.target === overlay) closeDialog(); });
document.addEventListener('keydown', function(event){
  if(overlay.hidden) return;
  if(event.key === 'Escape'){
    closeDialog();
    return;
  }
  if(event.key === 'Tab'){
    const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    if(!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
  }
});
document.getElementById('rollback').addEventListener('click', function(){
  openDialog('Rollback latest change', 'Restore the latest Fleet-managed change?', async function(){
    dialogConfirm.disabled = true;
    try {
      const result = await postJson('/api/rollback', {});
      closeDialog();
      announce('Rollback complete: ' + (result.action || 'done'), false);
      await refresh();
    } catch(error){
      closeDialog();
      announce(error && error.message ? error.message : String(error), true);
    } finally {
      dialogConfirm.disabled = false;
    }
  });
});

// Search is deliberately present as a shell control; filtering is implemented in Task 6.
void safeHttpUrl;
});
`;
