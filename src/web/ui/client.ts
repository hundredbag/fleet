interface InventoryViewAgent {
  id: string;
  displayName: string;
}
interface InventoryViewInstance {
  agent: string;
  availability: string;
  management: string;
}
interface InventoryViewCapability {
  kind: string;
  name: string;
  description?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  coordinate?: { ecosystem?: string; identifier?: string; version?: string };
  coverage: string;
  instances: InventoryViewInstance[];
}
interface InventoryViewInput {
  agents: InventoryViewAgent[];
  capabilities: InventoryViewCapability[];
}
export interface InventoryViewFilters {
  kind: string;
  status: string;
  sort: 'kind' | 'name';
  query: string;
}

/** Pure local view model shared by the generated client and deterministic tests. */
export function inventoryViewItems(
  inventory: InventoryViewInput,
  filters: InventoryViewFilters,
): InventoryViewCapability[] {
  function knownInstances(capability: InventoryViewCapability): InventoryViewInstance[] {
    return inventory.agents.map((agent) => {
      const matches = capability.instances.filter((instance) => instance.agent === agent.id);
      return matches.length === 1
        ? matches[0]!
        : { agent: agent.id, availability: 'unverifiable', management: 'none' };
    });
  }
  function searchText(capability: InventoryViewCapability): string {
    const coordinate = capability.coordinate ?? {};
    let safeUrl = '';
    if (typeof capability.sourceUrl === 'string') {
      try {
        const url = new URL(capability.sourceUrl);
        const sensitive = [...url.searchParams.keys()].some((key) =>
          /(token|key|secret|auth|sig|password|credential|session|bearer)/i.test(key),
        );
        if (url.protocol === 'https:' && !url.username && !url.password && !sensitive) {
          url.hash = '';
          safeUrl = url.toString();
        }
      } catch {
        safeUrl = '';
      }
    }
    return [
      capability.name,
      capability.kind,
      capability.description,
      capability.sourceLabel,
      safeUrl,
      coordinate.ecosystem,
      coordinate.identifier,
      coordinate.version,
      ...capability.instances.map((instance) => {
        const agent = inventory.agents.find((candidate) => candidate.id === instance.agent);
        return `${agent ? `${agent.displayName} ` : ''}${instance.agent}`;
      }),
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLocaleLowerCase();
  }
  function statusMatches(capability: InventoryViewCapability): boolean {
    if (filters.status === 'all') return true;
    if (filters.status === 'all-present' || filters.status === 'gap') {
      return capability.coverage === filters.status;
    }
    const instances = knownInstances(capability);
    if (filters.status === 'read-only' || filters.status === 'delegated') {
      return instances.some((instance) => instance.management === filters.status);
    }
    return instances.some((instance) => instance.availability === filters.status);
  }
  const query = filters.query.trim().toLocaleLowerCase();
  return inventory.capabilities
    .filter(
      (capability) =>
        (filters.kind === 'all' || capability.kind === filters.kind) &&
        statusMatches(capability) &&
        (!query || searchText(capability).includes(query)),
    )
    .slice()
    .sort((a, b) => {
      const kindCompare = filters.sort === 'kind' ? a.kind.localeCompare(b.kind) : 0;
      return kindCompare || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
    });
}

export interface InventoryPlanPayload {
  action: string;
  kind: string;
  name: string;
  from?: string;
  to?: string;
  coordinate?: { ecosystem?: string; identifier?: string; version?: string };
}

/** Build only a backend-valid logical preview payload from an advertised operation. */
export function inventoryOperationPayload(
  operation: string,
  capability: InventoryViewCapability,
  instance: InventoryViewInstance,
  inventory: InventoryViewInput,
): InventoryPlanPayload | null {
  const payload: InventoryPlanPayload = {
    action: operation,
    kind: capability.kind,
    name: capability.name,
  };
  if (capability.kind === 'plugin') {
    if (operation === 'install') payload.to = instance.agent;
    else if (operation === 'remove') payload.from = instance.agent;
    else return null;
    return payload;
  }
  if (operation === 'remove') payload.from = instance.agent;
  else if (operation === 'sync') {
    const sources = capability.instances.filter(
      (candidate) =>
        candidate.agent !== instance.agent &&
        (candidate.availability === 'installed' || candidate.availability === 'disabled') &&
        inventory.agents.some((agent) => agent.id === candidate.agent),
    );
    if (!sources.length) return null;
    payload.from = sources[0]!.agent;
    payload.to = instance.agent;
  } else if (operation === 'install') {
    const coordinate = capability.coordinate;
    if (
      !coordinate ||
      typeof coordinate.ecosystem !== 'string' ||
      typeof coordinate.identifier !== 'string'
    ) {
      return null;
    }
    payload.to = instance.agent;
    payload.coordinate = coordinate;
  } else if (operation === 'update') {
    const version = capability.coordinate?.version;
    if (typeof version !== 'string' || !version) return null;
    payload.to = instance.agent;
    payload.coordinate = { version };
  } else return null;
  return payload;
}

// Explicit helper source keeps the dev/tsx and built browser clients identical and closure-free.
// Tests execute these exact strings and compare them with the typed implementations above.
export const INVENTORY_VIEW_ITEMS_BROWSER_SOURCE = String.raw`function inventoryViewItems(inventory, filters) {
  function knownInstances(capability) {
    return inventory.agents.map(function(agent) {
      const matches = capability.instances.filter(function(instance) { return instance.agent === agent.id; });
      return matches.length === 1 ? matches[0] : { agent:agent.id, availability:'unverifiable', management:'none' };
    });
  }
  function searchText(capability) {
    const coordinate = capability.coordinate || {};
    let safeUrl = '';
    if(typeof capability.sourceUrl === 'string') {
      try {
        const url = new URL(capability.sourceUrl);
        const sensitive = Array.from(url.searchParams.keys()).some(function(key) {
          return /(token|key|secret|auth|sig|password|credential|session|bearer)/i.test(key);
        });
        if(url.protocol === 'https:' && !url.username && !url.password && !sensitive) {
          url.hash = '';
          safeUrl = url.toString();
        }
      } catch { safeUrl = ''; }
    }
    return [capability.name, capability.kind, capability.description, capability.sourceLabel, safeUrl,
      coordinate.ecosystem, coordinate.identifier, coordinate.version].concat(
        capability.instances.map(function(instance) {
          const agent = inventory.agents.find(function(candidate) { return candidate.id === instance.agent; });
          return (agent ? agent.displayName + ' ' : '') + instance.agent;
        })
      ).filter(function(value) { return typeof value === 'string'; }).join(' ').toLocaleLowerCase();
  }
  function statusMatches(capability) {
    if(filters.status === 'all') return true;
    if(filters.status === 'all-present' || filters.status === 'gap') return capability.coverage === filters.status;
    const instances = knownInstances(capability);
    if(filters.status === 'read-only' || filters.status === 'delegated') {
      return instances.some(function(instance) { return instance.management === filters.status; });
    }
    return instances.some(function(instance) { return instance.availability === filters.status; });
  }
  const query = filters.query.trim().toLocaleLowerCase();
  return inventory.capabilities.filter(function(capability) {
    return (filters.kind === 'all' || capability.kind === filters.kind) && statusMatches(capability)
      && (!query || searchText(capability).includes(query));
  }).slice().sort(function(a, b) {
    const kindCompare = filters.sort === 'kind' ? a.kind.localeCompare(b.kind) : 0;
    return kindCompare || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
  });
}`;

export const INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE = String.raw`function inventoryOperationPayload(operation, capability, instance, inventory) {
  const payload = { action:operation, kind:capability.kind, name:capability.name };
  if(capability.kind === 'plugin') {
    if(operation === 'install') payload.to = instance.agent;
    else if(operation === 'remove') payload.from = instance.agent;
    else return null;
    return payload;
  }
  if(operation === 'remove') payload.from = instance.agent;
  else if(operation === 'sync') {
    const sources = capability.instances.filter(function(candidate) {
      return candidate.agent !== instance.agent
        && (candidate.availability === 'installed' || candidate.availability === 'disabled')
        && inventory.agents.some(function(agent) { return agent.id === candidate.agent; });
    });
    if(!sources.length) return null;
    payload.from = sources[0].agent;
    payload.to = instance.agent;
  } else if(operation === 'install') {
    const coordinate = capability.coordinate;
    if(!coordinate || typeof coordinate.ecosystem !== 'string' || typeof coordinate.identifier !== 'string') return null;
    payload.to = instance.agent;
    payload.coordinate = coordinate;
  } else if(operation === 'update') {
    const version = capability.coordinate && capability.coordinate.version;
    if(typeof version !== 'string' || !version) return null;
    payload.to = instance.agent;
    payload.coordinate = { version:version };
  } else return null;
  return payload;
}`;

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
function safeHttpUrl(value){
  if(typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if(url.protocol !== 'https:' || url.username || url.password) return null;
    const sensitive = Array.from(url.searchParams.keys()).some(function(key){
      return /(token|key|secret|auth|sig|password|credential|session|bearer)/i.test(key);
    });
    if(sensitive) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}
const inventoryViewItems = ${INVENTORY_VIEW_ITEMS_BROWSER_SOURCE};
const operationPayload = ${INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE};

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
let inventoryKind = 'all';
let inventoryStatus = 'all';
let inventorySort = 'kind';
let dialogGeneration = 0;
let planGeneration = 0;
let planPending = false;
let inventoryQuery = '';
let inventoryModel = null;
const refreshButton = document.getElementById('refresh');
const availabilityLabels = { installed:'Installed', missing:'Missing', disabled:'Disabled', unavailable:'Unavailable', unsupported:'Unsupported', unverifiable:'Unverifiable' };
const coverageLabels = { 'all-present':'All present', gap:'Gap', 'agent-only':'Agent only', unverifiable:'Unverifiable' };
const kindLabels = { 'mcp-server':'MCP', skill:'Skill', rule:'Rule', plugin:'Plugin', permission:'Permission', subagent:'Subagent' };
const availabilityValues = ['installed','missing','disabled','unavailable','unsupported','unverifiable'];
const managementValues = ['writable','read-only','delegated','none'];
const operationValues = ['install','update','sync','remove'];
const warningValues = ['TRUST_WARNING','NO_CHANGE','PROVENANCE_WARNING','TRANSLATION_WARNING','OPERATION_WARNING'];
function isString(value){ return typeof value === 'string'; }
function isStringArray(value){ return Array.isArray(value) && value.every(isString); }
function validCoordinate(value){
  return !!value && isString(value.ecosystem) && isString(value.identifier)
    && (value.version === undefined || isString(value.version));
}
function validCapabilityMetadata(capability){
  return (capability.description === undefined || isString(capability.description))
    && (capability.tokensEst === undefined || Number.isInteger(capability.tokensEst))
    && (capability.sourceLabel === undefined || ['agent-config','local-skill','managed-rule','vendor-plugin'].indexOf(capability.sourceLabel) >= 0)
    && (capability.sourceUrl === undefined || isString(capability.sourceUrl))
    && (capability.coordinate === undefined || validCoordinate(capability.coordinate));
}
function validInventory(value){
  return !!value && Array.isArray(value.agents) && value.agents.every(function(agent){
    return isString(agent.id) && isString(agent.displayName) && typeof agent.present === 'boolean' && typeof agent.inventoryAvailable === 'boolean';
  })
    && new Set(value.agents.map(function(agent){ return agent.id; })).size === value.agents.length
    && Number.isInteger(value.capabilityInstances) && Number.isInteger(value.uniqueCapabilityKeys)
    && Array.isArray(value.capabilities) && value.capabilities.every(function(capability){
      return isString(capability.key) && isString(capability.kind) && isString(capability.name) && validCapabilityMetadata(capability) && Object.prototype.hasOwnProperty.call(coverageLabels, capability.coverage)
        && Array.isArray(capability.instances) && capability.instances.every(function(instance){
          return isString(instance.agent) && availabilityValues.indexOf(instance.availability) >= 0
            && managementValues.indexOf(instance.management) >= 0 && (instance.scope === undefined || isString(instance.scope))
            && (instance.enabled === undefined || typeof instance.enabled === 'boolean') && Array.isArray(instance.operations)
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
function validPlan(value){
  return !!value && isString(value.planId) && Number.isFinite(value.expiresAt)
    && isString(value.operationSummary) && isStringArray(value.warningCodes)
    && value.warningCodes.every(function(code){ return warningValues.indexOf(code) >= 0; })
    && Array.isArray(value.changes) && value.changes.every(function(change){
      return isString(change.agent) && Object.prototype.hasOwnProperty.call(kindLabels, change.kind)
        && isString(change.name) && operationValues.indexOf(change.op) >= 0
        && (change.scope === undefined || isString(change.scope));
    });
}
function planContent(plan){
  const content = node('div', 'plan-preview');
  content.append(node('p', 'plan-summary', plan.operationSummary));
  const list = node('ul', 'plan-changes');
  plan.changes.forEach(function(change){ list.append(node('li', '', change.op + ' · ' + change.kind + ' · ' + change.name + ' · ' + change.agent)); });
  if(!list.childNodes.length) list.append(node('li', '', 'No changes'));
  content.append(list);
  if(plan.warningCodes.length) content.append(node('p', 'plan-warnings', 'Warnings: ' + plan.warningCodes.join(', ')));
  content.append(node('p', 'preview-note', 'Preview only. No changes have been applied.'));
  return content;
}
async function doPlan(action, body, trigger){
  if(planPending){
    if(overlay && !overlay.hidden){
      const notice = node('p', 'dialog-error', 'Another preview request is already in progress.');
      notice.setAttribute('role', 'alert');
      dialogContent.append(notice);
    } else announce('Another preview request is already in progress.');
    return;
  }
  planPending = true;
  const requestGeneration = ++planGeneration;
  const startingDialogGeneration = dialogGeneration;
  const startedInDialog = Boolean(overlay && !overlay.hidden);
  const planTriggers = Array.from(document.querySelectorAll('button.plan-trigger'));
  planTriggers.forEach(function(button){ button.disabled = true; });
  try {
    const plan = await postJson('/api/plan', body);
    if(requestGeneration !== planGeneration || startingDialogGeneration !== dialogGeneration) return;
    if(!validPlan(plan)) throw new Error('Plan unavailable.');
    openDialog(action + ' preview', planContent(plan), null);
  } catch {
    if(requestGeneration !== planGeneration || startingDialogGeneration !== dialogGeneration) return;
    if(startedInDialog && overlay && !overlay.hidden){
      const prior = dialogContent.querySelector('.dialog-error');
      if(prior) prior.remove();
      const error = node('p', 'dialog-error', 'Preview unavailable. No changes were applied.');
      error.setAttribute('role', 'alert');
      dialogContent.append(error);
    } else announce('Preview unavailable. No changes were applied.');
  } finally {
    if(requestGeneration === planGeneration){
      planPending = false;
      planTriggers.forEach(function(button){ if(button.isConnected) button.disabled = false; });
    }
  }
}
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
  const payload = inventoryModel && operationPayload(operation, capability, instance, inventoryModel);
  if(!payload) return null;
  const button = node('button', 'cell-operation plan-trigger', operation.charAt(0).toUpperCase() + operation.slice(1));
  button.type = 'button';
  button.setAttribute('aria-label', operation + ' ' + capability.name + ' on ' + instance.agent);
  button.addEventListener('click', function(event){
    event.stopPropagation();
    void doPlan(operation.charAt(0).toUpperCase() + operation.slice(1), payload, button);
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
      instance.operations.forEach(function(operation){ const button = operationButton(operation, capability, instance); if(button) actions.append(button); });
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
function knownInstances(capability, inventory){
  return inventory.agents.map(function(agent){
    const matches = capability.instances.filter(function(instance){ return instance.agent === agent.id; });
    return matches.length === 1 ? matches[0] : { agent:agent.id, availability:'unverifiable', management:'none', operations:[] };
  });
}
function statusBadge(instance, inventory){
  const label = availabilityLabels[instance.availability] || 'Unverifiable';
  const agent = inventory.agents.find(function(item){ return item.id === instance.agent; });
  const badge = node('span', 'status-badge status-' + instance.availability);
  badge.setAttribute('aria-label', (agent ? agent.displayName : instance.agent) + ': ' + label);
  const icon = node('span', 'status-icon', instance.availability === 'installed' ? '●' : instance.availability === 'missing' ? '○' : '◆');
  icon.setAttribute('aria-hidden', 'true');
  badge.append(icon, node('span', '', label));
  return badge;
}
function detailContent(capability, inventory){
  const content = node('div', 'capability-detail');
  content.append(node('p', 'detail-kind', kindLabels[capability.kind] || capability.kind));
  if(capability.description) content.append(node('p', '', capability.description));
  if(capability.sourceLabel) content.append(node('p', 'detail-meta', 'Source: ' + capability.sourceLabel));
  if(capability.coordinate) content.append(node('p', 'detail-meta', 'Identifier: ' + capability.coordinate.identifier
    + (capability.coordinate.version ? ' · ' + capability.coordinate.version : '')));
  const sourceUrl = safeHttpUrl(capability.sourceUrl);
  if(sourceUrl){ const link = node('a', 'detail-link', sourceUrl); link.href = sourceUrl; link.rel = 'noreferrer'; content.append(link); }
  if((capability.kind === 'skill' || capability.kind === 'rule') && capability.tokensEst !== undefined) content.append(node('p', 'detail-meta', 'Estimated tokens: ' + capability.tokensEst));
  const list = node('ul', 'agent-states');
  knownInstances(capability, inventory).forEach(function(instance){
    const item = node('li', 'agent-state');
    const agent = inventory.agents.find(function(candidate){ return candidate.id === instance.agent; });
    item.append(node('strong', '', agent ? agent.displayName : instance.agent), statusBadge(instance, inventory));
    if(instance.management === 'read-only' || instance.management === 'delegated') item.append(node('span', 'management-label', instance.management === 'read-only' ? 'Read-only' : 'Delegated'));
    const actions = node('div', 'cell-actions');
    instance.operations.forEach(function(operation){ const button = operationButton(operation, capability, instance); if(button) actions.append(button); });
    if(actions.childNodes.length) item.append(actions);
    list.append(item);
  });
  content.append(list);
  return content;
}
function renderInventory(inventory){
  const target = document.getElementById('inventory');
  target.className = 'inventory-panel';
  const toolbar = node('div', 'inventory-toolbar');
  const kindCounts = { all:inventory.capabilities.length };
  inventory.capabilities.forEach(function(capability){ kindCounts[capability.kind] = (kindCounts[capability.kind] || 0) + 1; });
  const chips = node('div', 'inventory-kind-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Inventory kind');
  ['all'].concat(Object.keys(kindCounts).filter(function(kind){ return kind !== 'all'; }).sort()).forEach(function(kind){
    const button = node('button', '', (kind === 'all' ? 'All' : (kindLabels[kind] || kind)) + ' ' + kindCounts[kind]);
    button.type = 'button'; button.setAttribute('aria-pressed', kind === inventoryKind ? 'true' : 'false');
    button.setAttribute('data-inventory-kind', kind);
    button.addEventListener('click', function(){
      inventoryKind = kind;
      renderInventory(inventoryModel);
      const replacement = Array.from(document.querySelectorAll('[data-inventory-kind]')).find(function(candidate){
        return candidate.getAttribute('data-inventory-kind') === kind;
      });
      if(replacement) replacement.focus();
    }); chips.append(button);
  });
  const statusLabel = node('label', 'compact-control', 'Status ');
  const status = node('select'); status.id = 'inventory-status-filter';
  [['all','All'],['all-present','All present'],['gap','Gap'],['disabled','Disabled'],['unavailable','Unavailable'],['unsupported','Unsupported'],['read-only','Read-only'],['delegated','Delegated']].forEach(function(pair){ const option = node('option', '', pair[1]); option.value = pair[0]; option.selected = pair[0] === inventoryStatus; status.append(option); });
  status.addEventListener('change', function(){ inventoryStatus = status.value; renderInventory(inventoryModel); document.getElementById('inventory-status-filter').focus(); }); statusLabel.append(status);
  const sortLabel = node('label', 'compact-control', 'Sort '); const sort = node('select'); sort.id = 'inventory-sort';
  [['kind','Kind + name'],['name','Name']].forEach(function(pair){ const option = node('option', '', pair[1]); option.value = pair[0]; option.selected = pair[0] === inventorySort; sort.append(option); });
  sort.addEventListener('change', function(){ inventorySort = sort.value; renderInventory(inventoryModel); document.getElementById('inventory-sort').focus(); }); sortLabel.append(sort);
  toolbar.append(chips, statusLabel, sortLabel);
  const filtered = inventoryViewItems(inventory, {
    kind:inventoryKind,
    status:inventoryStatus,
    sort:inventorySort,
    query:inventoryQuery
  });
  const count = node('p', 'inventory-result-count', filtered.length + ' of ' + inventory.capabilities.length + ' results'); count.id = 'inventory-result-count'; count.setAttribute('aria-live','polite');
  const list = node('div', 'inventory-list');
  filtered.forEach(function(capability){
    const item = node('article', 'inventory-item');
    const heading = node('div', 'inventory-item-heading'); heading.append(node('span', 'kind-label', kindLabels[capability.kind] || capability.kind), node('h3', '', capability.name));
    const states = node('div', 'inventory-statuses'); knownInstances(capability, inventory).forEach(function(instance){ states.append(statusBadge(instance, inventory)); });
    const details = node('button', 'details-button', 'Details'); details.type = 'button'; details.setAttribute('aria-label', 'Details for ' + capability.name);
    details.addEventListener('click', function(){ openDialog(capability.name, detailContent(capability, inventory), null); });
    item.append(heading, states, details); list.append(item);
  });
  if(!inventory.capabilities.length) list.append(node('p', 'empty-state inventory-empty', 'No capabilities were reported.'));
  else if(!filtered.length) list.append(node('p', 'empty-state inventory-no-results', 'No inventory items match your search and filters.'));
  replaceChildren(target, [toolbar, count, list]);
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
        action = node('button', 'plan-trigger', 'Review update'); action.type = 'button';
        action.setAttribute('aria-label', 'Review update for ' + update.name + ' on ' + update.agent);
        action.addEventListener('click', function(){ void doPlan('Update', { action:'update', kind:update.kind, name:update.name, to:update.agent, coordinate:{ version:update.to } }, action); });
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
  if(results.inventory){ renderCapabilityMap(results.inventory); renderInventory(results.inventory); }
  else {
    const target = document.getElementById('capability-map'); target.className = 'placeholder error'; target.textContent = 'Unavailable';
    const inventoryTarget = document.getElementById('inventory'); inventoryTarget.className = 'placeholder error'; inventoryTarget.textContent = 'Inventory unavailable.';
  }
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
  if(overlay.hidden) return;
  dialogGeneration += 1;
  overlay.hidden = true;
  appShell.removeAttribute('inert');
  confirmAction = null;
  if(returnFocus) returnFocus.focus();
}
function openDialog(title, message, action){
  dialogGeneration += 1;
  if(overlay.hidden) returnFocus = document.activeElement;
  dialogTitle.textContent = title;
  if(message instanceof Node) replaceChildren(dialogContent, [message]);
  else dialogContent.textContent = message;
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

const globalSearch = document.getElementById('global-search');
const searchNote = document.getElementById('search-note');
searchNote.textContent = 'Search inventory by name, kind, agent, or public source metadata.';
globalSearch.addEventListener('input', function(){
  inventoryQuery = globalSearch.value;
  if(inventoryModel) renderInventory(inventoryModel);
});
void refresh();
});
`;
