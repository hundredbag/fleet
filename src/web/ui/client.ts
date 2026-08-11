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
let selectedKind = 'all';
let inventoryModel = null;
const refreshButton = document.getElementById('refresh');
const availabilityLabels = { installed:'Installed', missing:'Missing', disabled:'Disabled', unavailable:'Unavailable', unsupported:'Unsupported', unverifiable:'Unverifiable' };
const coverageLabels = { 'all-present':'All present', gap:'Gap', 'agent-only':'Agent only', unverifiable:'Unverifiable' };
const kindLabels = { 'mcp-server':'MCP', skill:'Skill', rule:'Rule', plugin:'Plugin', permission:'Permission', subagent:'Subagent' };
const availabilityValues = ['installed','missing','disabled','unavailable','unsupported','unverifiable'];
const managementValues = ['writable','read-only','delegated','none'];
const operationValues = ['install','update','sync','remove'];
function isString(value){ return typeof value === 'string'; }
function isStringArray(value){ return Array.isArray(value) && value.every(isString); }
function validInventory(value){
  return !!value && Array.isArray(value.agents) && value.agents.every(function(agent){ return isString(agent.id) && isString(agent.displayName); })
    && Number.isInteger(value.capabilityInstances) && Number.isInteger(value.uniqueCapabilityKeys)
    && Array.isArray(value.capabilities) && value.capabilities.every(function(capability){
      return isString(capability.kind) && isString(capability.name) && Object.prototype.hasOwnProperty.call(coverageLabels, capability.coverage)
        && Array.isArray(capability.instances) && capability.instances.every(function(instance){
          return isString(instance.agent) && availabilityValues.indexOf(instance.availability) >= 0
            && managementValues.indexOf(instance.management) >= 0 && Array.isArray(instance.operations)
            && instance.operations.every(function(operation){ return operationValues.indexOf(operation) >= 0; });
        });
    });
}
function validOverview(value){
  return !!value && Number.isInteger(value.presentAgents) && Array.isArray(value.agents)
    && value.agents.every(function(agent){ return isString(agent.displayName) && typeof agent.present === 'boolean' && typeof agent.inventoryAvailable === 'boolean'; })
    && value.drift && Array.isArray(value.drift.findings) && Array.isArray(value.drift.unmanaged)
    && value.drift.findings.concat(value.drift.unmanaged).every(function(finding){
      return isString(finding.name) && isString(finding.agent) && isString(finding.state) && (finding.reasonCode === undefined || isString(finding.reasonCode));
    });
}
function validFeed(value){
  return !!value && Array.isArray(value.updates) && Array.isArray(value.skillUpdates) && Array.isArray(value.failures)
    && value.updates.every(function(update){ return isString(update.kind) && isString(update.name) && isString(update.agent)
      && (update.operation === null || update.operation === 'update') && (update.to === undefined || isString(update.to)); })
    && value.skillUpdates.every(function(update){ return isString(update.name) && isString(update.agent) && isString(update.state)
      && (update.operation === null || update.operation === 'update'); })
    && value.failures.every(function(failure){ return isString(failure.source); });
}
function validConflicts(value){
  return !!value && Array.isArray(value.conflicts) && value.conflicts.every(function(conflict){
    return isString(conflict.name) && isStringArray(conflict.agents) && isString(conflict.reasonCode);
  });
}
function node(tag, className, text){
  const element = document.createElement(tag);
  if(className) element.className = className;
  if(text !== undefined) element.textContent = String(text);
  return element;
}
function replaceChildren(target, children){ target.replaceChildren.apply(target, children); }
function setMetric(id, value){ document.getElementById(id).textContent = value === null ? 'Unavailable' : String(value); }
function matchesFilter(capability){
  if(selectedKind === 'all') return true;
  if(selectedKind === 'read-only') return capability.instances.some(function(instance){ return instance.management === 'read-only'; });
  return capability.kind === selectedKind;
}
function logicalDetails(capability, instance){
  const details = [kindLabels[capability.kind] || capability.kind, capability.name, coverageLabels[capability.coverage] || 'Unverifiable'];
  if(instance) details.push(instance.agent, availabilityLabels[instance.availability] || 'Unverifiable', instance.management);
  return details.join(' · ');
}
function operationButton(operation, capability, instance){
  const button = node('button', 'cell-operation', operation.charAt(0).toUpperCase() + operation.slice(1));
  button.type = 'button';
  button.setAttribute('aria-label', operation + ' ' + capability.name + ' on ' + instance.agent);
  button.addEventListener('click', function(event){
    event.stopPropagation();
    openDialog('Review ' + operation, logicalDetails(capability, instance), null);
  });
  return button;
}
function renderCapabilityMap(inventory){
  const target = document.getElementById('capability-map');
  target.className = '';
  const table = node('table', 'fleet-table');
  const head = node('thead');
  const headerRow = node('tr');
  headerRow.append(node('th', '', 'Capability'));
  inventory.agents.forEach(function(agent){ headerRow.append(node('th', '', agent.displayName)); });
  headerRow.append(node('th', '', 'Coverage'));
  head.append(headerRow); table.append(head);
  const body = node('tbody');
  inventory.capabilities.filter(matchesFilter).forEach(function(capability){
    const row = node('tr', 'capability-row');
    const nameCell = node('th'); nameCell.scope = 'row';
    nameCell.append(node('span', 'kind-label', kindLabels[capability.kind] || capability.kind), node('strong', '', capability.name));
    const detailsButton = node('button', 'details-button', 'Details');
    detailsButton.type = 'button';
    detailsButton.setAttribute('aria-label', 'Details for ' + capability.name);
    detailsButton.addEventListener('click', function(){ openDialog(capability.name, logicalDetails(capability), null); });
    nameCell.append(detailsButton);
    row.append(nameCell);
    inventory.agents.forEach(function(agent){
      const matches = capability.instances.filter(function(instance){ return instance.agent === agent.id; });
      const instance = matches.length === 1 ? matches[0] : { agent:agent.id, availability:'unverifiable', management:'none', operations:[] };
      const cell = node('td', 'state-cell state-' + instance.availability);
      cell.append(node('span', 'state-label', availabilityLabels[instance.availability] || 'Unverifiable'));
      if(instance.management === 'read-only') cell.append(node('small', 'management-label', 'Read-only'));
      else if(instance.management === 'delegated') cell.append(node('small', 'management-label', 'Delegated'));
      const actions = node('div', 'cell-actions');
      instance.operations.forEach(function(operation){ actions.append(operationButton(operation, capability, instance)); });
      if(actions.childNodes.length) cell.append(actions);
      row.append(cell);
    });
    const coverage = node('td');
    const badge = node('span', 'coverage coverage-' + capability.coverage, coverageLabels[capability.coverage] || 'Unverifiable');
    badge.setAttribute('data-coverage-label', capability.coverage);
    coverage.append(badge); row.append(coverage);
    body.append(row);
  });
  if(!body.childNodes.length){ const row = node('tr'); const cell = node('td', 'empty-state', 'No capabilities match this filter.'); cell.colSpan = inventory.agents.length + 2; row.append(cell); body.append(row); }
  table.append(body); replaceChildren(target, [table]);
}
function attentionItem(title, detail, action){
  const item = node('li', 'attention-item');
  item.append(node('strong', '', title), node('span', '', detail));
  if(action) item.append(action);
  return item;
}
function renderAttention(results){
  const target = document.getElementById('attention');
  target.className = '';
  const list = node('ul', 'attention-list');
  const feed = results.feed;
  if(feed){
    feed.updates.forEach(function(update){
      let action = null;
      if(update.operation === 'update' && isString(update.to)){
        action = node('button', '', 'Review update'); action.type = 'button';
        action.setAttribute('aria-label', 'Review update for ' + update.name + ' on ' + update.agent);
        action.addEventListener('click', async function(){
          action.disabled = true;
          try {
            const plan = await postJson('/api/plan', { action:'update', kind:update.kind, name:update.name, to:update.agent, coordinate:{ version:update.to } });
            if(!plan || !isString(plan.operationSummary) || !isStringArray(plan.warningCodes)) throw new Error('Plan unavailable.');
            openDialog('Update plan', plan.operationSummary + (plan.warningCodes.length ? ' · ' + plan.warningCodes.join(', ') : ''), null);
          } catch(error){ announce(error && error.message ? error.message : 'Plan unavailable.', true); }
          finally { action.disabled = false; }
        });
      }
      list.append(attentionItem('MCP update · ' + update.name, update.agent + (update.to ? ' · ' + update.to : ''), action));
    });
    feed.skillUpdates.forEach(function(update){ list.append(attentionItem('Skill update · ' + update.name, update.agent + ' · ' + update.state, null)); });
    feed.failures.forEach(function(failure){ list.append(attentionItem('Source unavailable', failure.source, null)); });
  } else list.append(attentionItem('Feed unavailable', 'Update and source state could not be loaded.', null));
  if(results.conflicts) results.conflicts.conflicts.forEach(function(conflict){ list.append(attentionItem('Rule conflict · ' + conflict.name, conflict.agents.join(', ') + ' · ' + conflict.reasonCode, null)); });
  else list.append(attentionItem('Conflicts unavailable', 'Rule conflict state could not be loaded.', null));
  if(results.overview){
    results.overview.agents.filter(function(agent){ return agent.present && !agent.inventoryAvailable; }).forEach(function(agent){ list.append(attentionItem('Agent inventory unavailable', agent.displayName, null)); });
    results.overview.drift.findings.forEach(function(finding){ list.append(attentionItem('Drift ' + finding.state + ' · ' + finding.name, finding.agent + (finding.reasonCode ? ' · ' + finding.reasonCode : ''), null)); });
    results.overview.drift.unmanaged.forEach(function(finding){ list.append(attentionItem('Unmanaged · ' + finding.name, finding.agent + ' · ' + finding.reasonCode, null)); });
  } else list.append(attentionItem('Overview unavailable', 'Agent and drift state could not be loaded.', null));
  if(!results.inventory) list.append(attentionItem('Inventory unavailable', 'Capability map could not be loaded.', null));
  if(!list.childNodes.length) list.append(attentionItem('No attention items', 'All reported sources returned no findings.', null));
  replaceChildren(target, [list]);
}
function renderResults(results){
  inventoryModel = results.inventory;
  if(results.inventory) renderCapabilityMap(results.inventory);
  else { const target = document.getElementById('capability-map'); target.className = 'placeholder error'; target.textContent = 'Unavailable'; }
  setMetric('metric-agents', results.overview ? results.overview.agents.length + ' / ' + results.overview.presentAgents : null);
  setMetric('metric-instances', results.inventory ? results.inventory.capabilityInstances : null);
  setMetric('metric-keys', results.inventory ? results.inventory.uniqueCapabilityKeys : null);
  setMetric('metric-updates', results.feed ? results.feed.updates.length + results.feed.skillUpdates.length : null);
  setMetric('metric-drift', results.overview ? results.overview.drift.findings.length : null);
  renderAttention(results);
}
async function refresh(){
  const generation = ++refreshGeneration;
  refreshButton.disabled = true;
  announce('Refreshing Fleet data…', false);
  try {
    const settled = await Promise.allSettled([get('/api/inventory'), get('/api/overview'), get('/api/feed?refresh=1'), get('/api/conflicts')]);
    if(generation !== refreshGeneration) return;
    const results = {
      inventory:settled[0].status === 'fulfilled' && validInventory(settled[0].value) ? settled[0].value : null,
      overview:settled[1].status === 'fulfilled' && validOverview(settled[1].value) ? settled[1].value : null,
      feed:settled[2].status === 'fulfilled' && validFeed(settled[2].value) ? settled[2].value : null,
      conflicts:settled[3].status === 'fulfilled' && validConflicts(settled[3].value) ? settled[3].value : null
    };
    renderResults(results);
    const failures = Object.keys(results).filter(function(key){ return results[key] === null; }).length;
    announce(failures ? failures + ' Fleet endpoint' + (failures === 1 ? ' is' : 's are') + ' unavailable.' : 'Fleet data refreshed.', failures > 0);
  } catch(error){
    if(generation === refreshGeneration) announce('Fleet data is unavailable.', true);
  } finally {
    if(generation === refreshGeneration) refreshButton.disabled = false;
  }
}
refreshButton.addEventListener('click', refresh);
document.querySelectorAll('[data-kind-filter]').forEach(function(button){
  button.addEventListener('click', function(){
    selectedKind = button.getAttribute('data-kind-filter');
    document.querySelectorAll('[data-kind-filter]').forEach(function(item){ item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    if(inventoryModel) renderCapabilityMap(inventoryModel);
  });
});

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
  dialogConfirm.hidden = !action;
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
    const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), [href]:not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'));
    if(!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
  }
});
document.getElementById('rollback').addEventListener('click', function(){
  dialogConfirm.hidden = false;
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
void refresh();
});
`;
