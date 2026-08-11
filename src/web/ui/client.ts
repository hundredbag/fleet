export interface DiscoveryViewItem {
  kind: string;
  name: string;
  category?: string;
  identifier?: string;
  ecosystem?: string;
  version?: string;
  description?: string;
  source: string;
  reasons: string[];
  trust: string;
  url?: string;
  operation: 'install' | null;
}
export interface DiscoveryViewFilters {
  query: string;
  kind: string;
  trust: string;
}
export interface DiscoveryViewSection {
  kind: 'mcp-server' | 'skill' | 'plugin';
  visible: DiscoveryViewItem[];
  total: number;
  canExpand: boolean;
  canCollapse: boolean;
}

/** Pure, local discovery filtering that preserves server recommendation order. */
export function discoveryViewSections(
  feed: { recommendations: DiscoveryViewItem[] },
  filters: DiscoveryViewFilters,
  expanded: Partial<Record<'mcp-server' | 'skill' | 'plugin', boolean>>,
): DiscoveryViewSection[] {
  const kinds = ['mcp-server', 'skill', 'plugin'] as const;
  const limits = { 'mcp-server': 6, skill: 6, plugin: 4 } as const;
  const query = filters.query.trim().toLocaleLowerCase();
  const matching = feed.recommendations.filter((item) => {
    const search = [item.name, item.identifier, item.description, item.category]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLocaleLowerCase();
    return (
      (filters.kind === 'all' || item.kind === filters.kind) &&
      (filters.trust === 'all' || item.trust === filters.trust) &&
      (!query || search.includes(query))
    );
  });
  return kinds
    .filter((kind) => filters.kind === 'all' || filters.kind === kind)
    .map((kind) => {
      const items = matching.filter((item) => item.kind === kind);
      const isExpanded = expanded[kind] === true;
      return {
        kind,
        visible: isExpanded ? items : items.slice(0, limits[kind]),
        total: items.length,
        canExpand: !isExpanded && items.length > limits[kind],
        canCollapse: isExpanded && items.length > limits[kind],
      };
    });
}

export const DISCOVERY_RECOMMENDATION_VALIDATOR_BROWSER_SOURCE = String.raw`function validDiscoveryRecommendation(item) {
  const kinds = ['mcp-server','skill','plugin'];
  const trusts = ['no-flags','caution','unknown'];
  const optional = ['category','identifier','ecosystem','version','description','url'];
  function isString(value) { return typeof value === 'string'; }
  function validReason(reason) {
    return reason === 'new' || reason === 'popular' || reason === 'marketplace'
      || /^related to your setup \([a-z0-9]{4,}(, [a-z0-9]{4,}){0,2}\)$/.test(reason);
  }
  return !!item && kinds.indexOf(item.kind) >= 0 && isString(item.name) && isString(item.source)
    && Array.isArray(item.reasons) && item.reasons.every(validReason) && trusts.indexOf(item.trust) >= 0
    && (item.operation === null || item.operation === 'install')
    && optional.every(function(key) { return item[key] === undefined || isString(item[key]); });
}`;

export const DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE = String.raw`function discoveryViewSections(feed, filters, expanded) {
  const kinds = ['mcp-server','skill','plugin'];
  const limits = { 'mcp-server':6, skill:6, plugin:4 };
  const query = filters.query.trim().toLocaleLowerCase();
  const matching = feed.recommendations.filter(function(item) {
    const search = [item.name,item.identifier,item.description,item.category]
      .filter(function(value) { return typeof value === 'string'; }).join(' ').toLocaleLowerCase();
    return (filters.kind === 'all' || item.kind === filters.kind)
      && (filters.trust === 'all' || item.trust === filters.trust)
      && (!query || search.includes(query));
  });
  return kinds.filter(function(kind) { return filters.kind === 'all' || filters.kind === kind; }).map(function(kind) {
    const items = matching.filter(function(item) { return item.kind === kind; });
    const isExpanded = expanded[kind] === true;
    return { kind:kind, visible:isExpanded ? items : items.slice(0,limits[kind]), total:items.length,
      canExpand:!isExpanded && items.length > limits[kind], canCollapse:isExpanded && items.length > limits[kind] };
  });
}`;

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

const messages = {
  en:{
    'nav.overview':'Overview','nav.inventory':'Inventory','nav.discover':'Discover','nav.drift':'Drift','nav.activity':'Activity',
    'brand.control':'Capability control','brand.console':'Fleet console','safety.active':'Safety active','safety.preview':'Preview before apply',
    'a11y.navigation':'Fleet navigation','a11y.views':'Fleet views','language.label':'Language',
    'search.fleet':'Search Fleet','search.inventory':'Search Inventory','search.discovery':'Search Discovery','search.note':'Search Inventory or Discover locally by the public metadata shown in each view.',
    'overview.eyebrow':'Current state','overview.intro':'Operational entry point for your connected agent fleet.','overview.summary':'Fleet summary',
    'metric.agents':'Detected / present agents','metric.instances':'Capability instances','metric.keys':'Unique capability keys','metric.updates':'Updates','metric.drift':'Drift findings',
    'map.eyebrow':'Server-reported state','map.title':'Capability fleet map','map.filter':'Filter capabilities by kind','map.table':'Capability fleet map table','map.legend':'Fleet map legend',
    'inventory.eyebrow':'Connected capabilities','inventory.intro':'Inspect capabilities reported by each present agent.','inventory.title':'Capability inventory','inventory.table':'Capability inventory table',
    'discover.eyebrow':'Registry sources','discover.intro':'Review available capabilities before choosing an action.','discover.skillsPlugins':'Skills and plugins',
    'drift.eyebrow':'Configuration signals','drift.intro':'Review differences and conflicts before making changes.','drift.title':'Detected drift',
    'activity.eyebrow':'Audit trail','activity.intro':'Review Fleet operations and their outcomes.','activity.title':'Recent activity',
    'attention.eyebrow':'Updates and signals','attention.title':'Needs attention',
    'loading.map':'Loading capability map…','loading.attention':'Loading attention items…','loading.inventory':'Loading capability inventory…','loading.discovery':'Discovery results will appear here.','loading.registry':'Registry results will appear here.','loading.drift':'Drift findings will appear here.','loading.activity':'Activity records will appear here.',
    'action.refresh':'Refresh','action.cancel':'Cancel','action.confirm':'Confirm','action.details':'Details','action.install':'Install','action.update':'Update','action.sync':'Sync','action.remove':'Remove','action.rollback':'Rollback','action.reviewUpdate':'Review update',
    'theme.toLight':'Light theme','theme.toDark':'Dark theme','theme.switchLight':'Switch to light theme','theme.switchDark':'Switch to dark theme',
    'dialog.confirmAction':'Confirm action','preview.title':'{action} preview','preview.summary':'{action} · {count} planned change(s)','preview.none':'No changes','preview.warnings':'Warnings: {codes}','preview.note':'Preview only. No changes have been applied.','preview.pending':'Another preview request is already in progress.','preview.planUnavailable':'Plan unavailable.','preview.unavailable':'Preview unavailable. No changes were applied.',
    'filter.all':'All','filter.status':'Status ','filter.sort':'Sort ','filter.allTrust':'All trust','filter.noFlags':'No flags','filter.caution':'Caution','filter.unknown':'Unknown','filter.kindName':'Kind + name','filter.name':'Name',
    'kind.mcpServers':'MCP servers','kind.skills':'Skills','kind.rules':'Rules','kind.plugins':'Plugins','kind.skill':'Skill','kind.rule':'Rule','kind.plugin':'Plugin','kind.permission':'Permission','kind.subagent':'Subagent',
    'state.installed':'Installed','state.missing':'Missing','state.disabled':'Disabled','state.unavailable':'Unavailable','state.unsupported':'Unsupported','state.unverifiable':'Unverifiable',
    'coverage.all-present':'All present','coverage.gap':'Gap','coverage.agent-only':'Agent only','management.writable':'Writable','management.read-only':'Read-only','management.delegated':'Delegated','management.none':'Not managed',
    'trust.no-flags':'No flags','trust.caution':'Caution','trust.unknown':'Unknown','reason.new':'New','reason.popular':'Popular','reason.marketplace':'Marketplace','reason.related':'Related to your setup ({items})',
    'source.core-audit':'Core audit','source.delegated-plugin':'Delegated plugin','source.agent-config':'Agent config','source.local-skill':'Local skill','source.managed-rule':'Managed rule','source.vendor-plugin':'Vendor plugin',
    'scope.user':'User','scope.project':'Project','scope.local':'Local','outcome.applied':'Applied','outcome.failed':'Failed','outcome.rolled-back':'Rolled back','outcome.unknown':'Unknown',
    'delegated.available':'Available','delegated.not-present':'Not present','delegated.unavailable':'Unavailable','delegated.malformed':'Malformed','rollback.restored':'restored','rollback.removed':'removed','rollback.skipped':'skipped',
    'skillUpdate.update':'Update available','skillUpdate.update+local-edits':'Update with local edits','skillUpdate.update+missing':'Update with missing content','skillUpdate.update+unverifiable':'Update cannot be verified',
    'table.capability':'Capability','table.coverage':'Coverage','empty.map':'No capabilities match this filter.','empty.inventory':'No capabilities were reported.','empty.inventorySearch':'No inventory items match your search and filters.','empty.discovery':'No discovery items match your search and filters.','empty.none':'None reported.','empty.activity':'No activity records were reported.','empty.attention':'No attention items',
    'results.count':'{shown} of {total} results','details.for':'Details for {name}','operation.on':'{operation} {name} on {agent}','source.label':'Source: {value}','identifier.label':'Identifier: {value}','category.label':'Category: {value}','tokens.label':'Estimated tokens: {value}',
    'discover.kind':'Discovery kind','discover.trust':'Discovery trust','discover.showAll':'Show all','discover.collapse':'Collapse','discover.sourceUnavailable':'Source unavailable: {source}','discover.unavailable':'Discovery unavailable.','discover.trustLabel':'Trust: {value}','discover.reasons':'Recommendation reasons for {name}','discover.openSource':'Open HTTPS source','discover.openMarketplace':'Open marketplace source','discover.noCli':'Local CLI guidance was not provided by this source.','discover.useGuidance':'Use the marketplace or CLI instructions from this source.','discover.noGuidance':'Marketplace or CLI guidance was not provided by this source.','discover.previewInstall':'Preview install',
    'attention.mcpUpdate':'MCP update · {name}','attention.skillUpdate':'Skill update · {name}','attention.sourceUnavailable':'Source unavailable','attention.feedUnavailable':'Feed unavailable','attention.feedDetail':'Update and source state could not be loaded.','attention.ruleConflict':'Rule conflict · {name}','attention.conflictsUnavailable':'Conflicts unavailable','attention.conflictsDetail':'Rule conflict state could not be loaded.','agent.unavailable':'Agent inventory unavailable','attention.drift':'Drift {state} · {name}','attention.unmanaged':'Unmanaged · {name}','attention.overviewUnavailable':'Overview unavailable','attention.overviewDetail':'Agent and drift state could not be loaded.','attention.inventoryUnavailable':'Inventory unavailable','attention.inventoryDetail':'Capability map could not be loaded.','attention.noneDetail':'All reported sources returned no findings.',
    'drift.unavailable':'Drift unavailable.','drift.summary':'{checked} checked · {findings} findings · {unmanaged} unmanaged','drift.note':'Unmanaged capabilities are informational: Fleet did not install them. Lock metadata is best-effort and may make an item unverifiable.','drift.modified':'Modified','drift.missing':'Missing','drift.unverifiable':'Unverifiable','drift.unmanaged':'Unmanaged','drift.conflicts':'{count} rule conflict(s) reported.','drift.conflictsUnavailable':'Rule conflicts unavailable.',
    'rollback.title':'Rollback capability change','rollback.scope':'Scope: {scope}','rollback.guard':'Divergence guard: rollback is skipped if the capability changed after Fleet wrote it.','rollback.responseUnavailable':'Rollback response unavailable.','rollback.result':'Rollback {action}{reason}','rollback.failed':'Rollback was not completed.','rollback.confirm':'Confirm rollback','rollback.select':'Select {op} {name} on {agent}{scope}, from {source}, recorded {time}, for rollback','rollback.openActivity':'Open Activity to select a rollback target',
    'activity.unavailable':'Activity unavailable.','activity.rolledBack':'Rolled back','activity.delegated':'Delegated activity: {status}.',
    'refresh.progress':'Refreshing Fleet data…','refresh.endpoints':'{count} Fleet endpoint(s) unavailable.','refresh.sources':'{count} Discovery source(s) unavailable.','refresh.done':'Fleet data refreshed.','refresh.unavailable':'Fleet data is unavailable.','common.unavailable':'Unavailable'
  },
  ko:{
    'nav.overview':'개요','nav.inventory':'인벤토리','nav.discover':'탐색','nav.drift':'드리프트','nav.activity':'활동',
    'brand.control':'기능 제어','brand.console':'Fleet 콘솔','safety.active':'안전 모드 활성','safety.preview':'적용 전 미리보기',
    'a11y.navigation':'Fleet 탐색','a11y.views':'Fleet 화면','language.label':'언어',
    'search.fleet':'Fleet 검색','search.inventory':'인벤토리 검색','search.discovery':'탐색 검색','search.note':'각 화면에 표시된 공개 메타데이터로 인벤토리 또는 탐색을 로컬 검색합니다.',
    'overview.eyebrow':'현재 상태','overview.intro':'연결된 에이전트 Fleet의 운영 진입점입니다.','overview.summary':'Fleet 요약',
    'metric.agents':'감지됨 / 사용 가능 에이전트','metric.instances':'기능 인스턴스','metric.keys':'고유 기능 키','metric.updates':'업데이트','metric.drift':'드리프트 항목',
    'map.eyebrow':'서버 보고 상태','map.title':'기능 Fleet 맵','map.filter':'종류별 기능 필터','map.table':'기능 Fleet 맵 표','map.legend':'Fleet 맵 범례',
    'inventory.eyebrow':'연결된 기능','inventory.intro':'각 사용 가능 에이전트가 보고한 기능을 확인합니다.','inventory.title':'기능 인벤토리','inventory.table':'기능 인벤토리 표',
    'discover.eyebrow':'레지스트리 소스','discover.intro':'작업을 선택하기 전에 사용 가능한 기능을 검토합니다.','discover.skillsPlugins':'스킬 및 플러그인',
    'drift.eyebrow':'구성 신호','drift.intro':'변경 전에 차이와 충돌을 검토합니다.','drift.title':'감지된 드리프트',
    'activity.eyebrow':'감사 기록','activity.intro':'Fleet 작업과 결과를 검토합니다.','activity.title':'최근 활동',
    'attention.eyebrow':'업데이트 및 신호','attention.title':'확인 필요',
    'loading.map':'기능 맵 불러오는 중…','loading.attention':'확인 항목 불러오는 중…','loading.inventory':'기능 인벤토리 불러오는 중…','loading.discovery':'탐색 결과가 여기에 표시됩니다.','loading.registry':'레지스트리 결과가 여기에 표시됩니다.','loading.drift':'드리프트 항목이 여기에 표시됩니다.','loading.activity':'활동 기록이 여기에 표시됩니다.',
    'action.refresh':'새로고침','action.cancel':'취소','action.confirm':'확인','action.details':'상세','action.install':'설치','action.update':'업데이트','action.sync':'동기화','action.remove':'제거','action.rollback':'롤백','action.reviewUpdate':'업데이트 검토',
    'theme.toLight':'라이트 테마','theme.toDark':'다크 테마','theme.switchLight':'라이트 테마로 전환','theme.switchDark':'다크 테마로 전환',
    'dialog.confirmAction':'작업 확인','preview.title':'{action} 미리보기','preview.summary':'{action} · 계획된 변경 {count}개','preview.none':'변경 없음','preview.warnings':'경고: {codes}','preview.note':'미리보기 전용입니다. 변경 사항이 적용되지 않았습니다.','preview.pending':'다른 미리보기 요청이 진행 중입니다.','preview.planUnavailable':'계획을 사용할 수 없습니다.','preview.unavailable':'미리보기를 사용할 수 없습니다. 변경 사항이 적용되지 않았습니다.',
    'filter.all':'전체','filter.status':'상태 ','filter.sort':'정렬 ','filter.allTrust':'모든 신뢰도','filter.noFlags':'문제 없음','filter.caution':'주의','filter.unknown':'알 수 없음','filter.kindName':'종류 + 이름','filter.name':'이름',
    'kind.mcpServers':'MCP 서버','kind.skills':'스킬','kind.rules':'규칙','kind.plugins':'플러그인','kind.skill':'스킬','kind.rule':'규칙','kind.plugin':'플러그인','kind.permission':'권한','kind.subagent':'하위 에이전트',
    'state.installed':'설치됨','state.missing':'누락','state.disabled':'비활성','state.unavailable':'사용 불가','state.unsupported':'지원되지 않음','state.unverifiable':'확인 불가',
    'coverage.all-present':'모두 존재','coverage.gap':'차이','coverage.agent-only':'에이전트 전용','management.writable':'쓰기 가능','management.read-only':'읽기 전용','management.delegated':'위임됨','management.none':'관리되지 않음',
    'trust.no-flags':'문제 없음','trust.caution':'주의','trust.unknown':'알 수 없음','reason.new':'신규','reason.popular':'인기','reason.marketplace':'마켓플레이스','reason.related':'현재 설정과 관련됨 ({items})',
    'source.core-audit':'코어 감사','source.delegated-plugin':'위임 플러그인','source.agent-config':'에이전트 구성','source.local-skill':'로컬 스킬','source.managed-rule':'관리 규칙','source.vendor-plugin':'공급자 플러그인',
    'scope.user':'사용자','scope.project':'프로젝트','scope.local':'로컬','outcome.applied':'적용됨','outcome.failed':'실패','outcome.rolled-back':'롤백됨','outcome.unknown':'알 수 없음',
    'delegated.available':'사용 가능','delegated.not-present':'존재하지 않음','delegated.unavailable':'사용 불가','delegated.malformed':'형식 오류','rollback.restored':'복원됨','rollback.removed':'제거됨','rollback.skipped':'건너뜀',
    'skillUpdate.update':'업데이트 가능','skillUpdate.update+local-edits':'로컬 수정이 있는 업데이트','skillUpdate.update+missing':'누락 항목이 있는 업데이트','skillUpdate.update+unverifiable':'업데이트 확인 불가',
    'table.capability':'기능','table.coverage':'적용 범위','empty.map':'이 필터와 일치하는 기능이 없습니다.','empty.inventory':'보고된 기능이 없습니다.','empty.inventorySearch':'검색 및 필터와 일치하는 인벤토리 항목이 없습니다.','empty.discovery':'검색 및 필터와 일치하는 탐색 항목이 없습니다.','empty.none':'보고된 항목 없음.','empty.activity':'보고된 활동 기록이 없습니다.','empty.attention':'확인할 항목 없음',
    'results.count':'전체 {total}개 중 {shown}개 결과','details.for':'{name} 상세','operation.on':'{agent}에서 {name} {operation}','source.label':'소스: {value}','identifier.label':'식별자: {value}','category.label':'카테고리: {value}','tokens.label':'예상 토큰: {value}',
    'discover.kind':'탐색 종류','discover.trust':'탐색 신뢰도','discover.showAll':'모두 보기','discover.collapse':'접기','discover.sourceUnavailable':'소스 사용 불가: {source}','discover.unavailable':'탐색을 사용할 수 없습니다.','discover.trustLabel':'신뢰도: {value}','discover.reasons':'{name} 추천 이유','discover.openSource':'HTTPS 소스 열기','discover.openMarketplace':'마켓플레이스 소스 열기','discover.noCli':'이 소스는 로컬 CLI 안내를 제공하지 않습니다.','discover.useGuidance':'이 소스의 마켓플레이스 또는 CLI 안내를 사용하세요.','discover.noGuidance':'이 소스는 마켓플레이스 또는 CLI 안내를 제공하지 않습니다.','discover.previewInstall':'설치 미리보기',
    'attention.mcpUpdate':'MCP 업데이트 · {name}','attention.skillUpdate':'스킬 업데이트 · {name}','attention.sourceUnavailable':'소스 사용 불가','attention.feedUnavailable':'피드 사용 불가','attention.feedDetail':'업데이트 및 소스 상태를 불러오지 못했습니다.','attention.ruleConflict':'규칙 충돌 · {name}','attention.conflictsUnavailable':'충돌 정보 사용 불가','attention.conflictsDetail':'규칙 충돌 상태를 불러오지 못했습니다.','agent.unavailable':'에이전트 인벤토리 사용 불가','attention.drift':'드리프트 {state} · {name}','attention.unmanaged':'관리되지 않음 · {name}','attention.overviewUnavailable':'개요 사용 불가','attention.overviewDetail':'에이전트 및 드리프트 상태를 불러오지 못했습니다.','attention.inventoryUnavailable':'인벤토리 사용 불가','attention.inventoryDetail':'기능 맵을 불러오지 못했습니다.','attention.noneDetail':'보고된 모든 소스에 항목이 없습니다.',
    'drift.unavailable':'드리프트를 사용할 수 없습니다.','drift.summary':'{checked}개 확인 · {findings}개 항목 · {unmanaged}개 관리되지 않음','drift.note':'관리되지 않는 기능은 정보 제공용입니다. Fleet이 설치하지 않았습니다. 잠금 메타데이터는 최선의 정보이므로 항목을 확인하지 못할 수 있습니다.','drift.modified':'수정됨','drift.missing':'누락','drift.unverifiable':'확인 불가','drift.unmanaged':'관리되지 않음','drift.conflicts':'규칙 충돌 {count}개가 보고되었습니다.','drift.conflictsUnavailable':'규칙 충돌을 사용할 수 없습니다.',
    'rollback.title':'기능 변경 롤백','rollback.scope':'범위: {scope}','rollback.guard':'차이 보호: Fleet이 기록한 후 기능이 변경되었다면 롤백을 건너뜁니다.','rollback.responseUnavailable':'롤백 응답을 사용할 수 없습니다.','rollback.result':'롤백 {action}{reason}','rollback.failed':'롤백을 완료하지 못했습니다.','rollback.confirm':'롤백 확인','rollback.select':'{agent}의 {name} {op}{scope}, 소스 {source}, 기록 {time}, 롤백 대상으로 선택','rollback.openActivity':'롤백 대상을 선택하려면 활동 열기',
    'activity.unavailable':'활동을 사용할 수 없습니다.','activity.rolledBack':'롤백됨','activity.delegated':'위임 활동: {status}.',
    'refresh.progress':'Fleet 데이터 새로고치는 중…','refresh.endpoints':'Fleet 엔드포인트 {count}개를 사용할 수 없습니다.','refresh.sources':'탐색 소스 {count}개를 사용할 수 없습니다.','refresh.done':'Fleet 데이터를 새로고쳤습니다.','refresh.unavailable':'Fleet 데이터를 사용할 수 없습니다.','common.unavailable':'사용 불가'
  }
};
let language = sGet(localStore, 'fleet_language');
if(language !== 'en' && language !== 'ko') language = 'en';
document.documentElement.lang = language;
function t(key, vars){
  const table = messages[language] || messages.en;
  let value = table[key] || messages.en[key] || key;
  Object.keys(vars || {}).forEach(function(name){ value = value.split('{' + name + '}').join(String(vars[name])); });
  return value;
}
function unknownEnum(map, value){ return map[value] || value; }

// Apply the persisted preference in <head>, before first paint. The rest of the
// client waits for the document so the page still uses exactly one inline script.
let theme = sGet(localStore, 'fleet_theme');
if(theme !== 'light' && theme !== 'dark') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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
const validDiscoveryRecommendation = ${DISCOVERY_RECOMMENDATION_VALIDATOR_BROWSER_SOURCE};
const discoveryViewSections = ${DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE};
const operationPayload = ${INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE};
let inventoryQuery = '';
let discoveryQuery = '';

document.addEventListener('DOMContentLoaded', function(){
const views = ['overview','inventory','discover','drift','activity'];
const viewTitleKeys = { overview:'nav.overview', inventory:'nav.inventory', discover:'nav.discover', drift:'nav.drift', activity:'nav.activity' };
function applyStaticTranslations(){
  document.querySelectorAll('[data-i18n]').forEach(function(element){ element.textContent = t(element.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-aria]').forEach(function(element){ element.setAttribute('aria-label', t(element.getAttribute('data-i18n-aria'))); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(element){ element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder'))); });
}
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
  document.getElementById('current-view-title').textContent = t(viewTitleKeys[view]);
  document.title = t(viewTitleKeys[view]) + ' · Fleet';
  const search = document.getElementById('global-search');
  if(search){
    search.value = view === 'discover' ? discoveryQuery : inventoryQuery;
    const searchLabel = t(view === 'discover' ? 'search.discovery' : view === 'inventory' ? 'search.inventory' : 'search.fleet');
    search.placeholder = searchLabel;
    search.setAttribute('aria-label', searchLabel);
  }
}
window.addEventListener('hashchange', function(){ activateView(true); });
document.querySelectorAll('[data-nav-view]').forEach(function(link){
  link.addEventListener('click', function(){
    if(location.hash === link.getAttribute('href')) activateView(true);
  });
});
applyStaticTranslations();
activateView(false);

const themeButton = document.getElementById('theme');
function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme);
  const next = theme === 'dark' ? 'light' : 'dark';
  themeButton.textContent = t(next === 'light' ? 'theme.toLight' : 'theme.toDark');
  themeButton.setAttribute('aria-label', t(next === 'light' ? 'theme.switchLight' : 'theme.switchDark'));
}
applyTheme();
themeButton.addEventListener('click', function(){
  theme = theme === 'dark' ? 'light' : 'dark';
  sSet(localStore, 'fleet_theme', theme);
  applyTheme();
  if(cachedResults) renderResults(cachedResults);
});

const live = document.getElementById('err');
function announce(message, isError){
  live.className = 'live-region' + (isError ? ' error' : '');
  live.setAttribute('role', isError ? 'alert' : 'status');
  live.setAttribute('aria-live', isError ? 'assertive' : 'polite');
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
let rollbackPending = false;
let rollbackGeneration = 0;
let discoveryKind = 'all';
let discoveryTrust = 'all';
let discoveryExpanded = { 'mcp-server':false, skill:false, plugin:false };
let inventoryModel = null;
let feedModel = null;
let activityModel = null;
let cachedResults = null;
const refreshButton = document.getElementById('refresh');
const availabilityLabels = { installed:'state.installed', missing:'state.missing', disabled:'state.disabled', unavailable:'state.unavailable', unsupported:'state.unsupported', unverifiable:'state.unverifiable' };
const coverageLabels = { 'all-present':'coverage.all-present', gap:'coverage.gap', 'agent-only':'coverage.agent-only', unverifiable:'state.unverifiable' };
const kindLabels = { 'mcp-server':'MCP', skill:'kind.skill', rule:'kind.rule', plugin:'kind.plugin', permission:'kind.permission', subagent:'kind.subagent' };
const managementLabels = { writable:'management.writable', 'read-only':'management.read-only', delegated:'management.delegated', none:'management.none' };
const operationLabels = { install:'action.install', update:'action.update', sync:'action.sync', remove:'action.remove', rollback:'action.rollback' };
const trustLabels = { 'no-flags':'trust.no-flags', caution:'trust.caution', unknown:'trust.unknown' };
const driftStateLabels = { modified:'drift.modified', missing:'drift.missing', unverifiable:'drift.unverifiable', unmanaged:'drift.unmanaged' };
const activitySourceLabels = { 'core-audit':'source.core-audit', 'delegated-plugin':'source.delegated-plugin' };
const sourceLabelLabels = { 'agent-config':'source.agent-config', 'local-skill':'source.local-skill', 'managed-rule':'source.managed-rule', 'vendor-plugin':'source.vendor-plugin' };
const scopeLabels = { user:'scope.user', project:'scope.project', local:'scope.local' };
const outcomeLabels = { applied:'outcome.applied', failed:'outcome.failed', 'rolled-back':'outcome.rolled-back', unknown:'outcome.unknown' };
const delegatedStatusLabels = { available:'delegated.available', 'not-present':'delegated.not-present', unavailable:'delegated.unavailable', malformed:'delegated.malformed' };
const rollbackActionLabels = { restored:'rollback.restored', removed:'rollback.removed', skipped:'rollback.skipped' };
const skillUpdateLabels = { update:'skillUpdate.update', 'update+local-edits':'skillUpdate.update+local-edits', 'update+missing':'skillUpdate.update+missing', 'update+unverifiable':'skillUpdate.update+unverifiable' };
function enumLabel(map, value){ const key = map[value]; return key ? (key === 'MCP' ? key : t(key)) : unknownEnum(map, value); }
function recommendationReasonLabel(reason){
  if(reason === 'new' || reason === 'popular' || reason === 'marketplace') return t('reason.' + reason);
  const related = /^related to your setup \(([^)]+)\)$/.exec(reason);
  return related ? t('reason.related', { items:related[1] }) : reason;
}
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
  return !!value && Array.isArray(value.updates) && Array.isArray(value.skillUpdates)
    && Array.isArray(value.recommendations) && Array.isArray(value.failures) && typeof value.fromCache === 'boolean'
    && value.updates.every(function(update){ return isString(update.kind) && isString(update.name) && isString(update.agent)
      && (update.operation === null || update.operation === 'update') && (update.to === undefined || isString(update.to)); })
    && value.skillUpdates.every(function(update){ return isString(update.name) && isString(update.agent) && isString(update.state)
      && (update.operation === null || update.operation === 'update'); })
    && value.recommendations.every(validDiscoveryRecommendation)
    && value.failures.every(function(failure){ return isString(failure.source); });
}
function validConflicts(value){
  return !!value && Array.isArray(value.conflicts) && value.conflicts.every(function(conflict){
    return isString(conflict.name) && isStringArray(conflict.agents) && isString(conflict.reasonCode);
  });
}
function validActivity(value){
  const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  return !!value && Array.isArray(value.items) && value.items.length <= 20
    && value.delegatedActions && ['available','not-present','unavailable','malformed'].indexOf(value.delegatedActions.status) >= 0
    && value.items.every(function(item){
      return isString(item.id) && idPattern.test(item.id) && Number.isFinite(item.ts)
        && ['core-audit','delegated-plugin'].indexOf(item.source) >= 0
        && ['install','update','remove','rollback'].indexOf(item.op) >= 0
        && isString(item.agent) && isString(item.name)
        && (item.scope === undefined || ['user','project','local'].indexOf(item.scope) >= 0)
        && ['applied','failed','rolled-back','unknown'].indexOf(item.outcome) >= 0
        && typeof item.rollbackEligible === 'boolean' && typeof item.rolledBack === 'boolean'
        && (!item.rollbackEligible || (item.source === 'core-audit' && item.op !== 'rollback' && item.outcome === 'applied' && !item.rolledBack))
        && (!item.rolledBack || (item.source === 'core-audit' && item.outcome === 'rolled-back' && !item.rollbackEligible));
    });
}
function node(tag, className, text){
  const element = document.createElement(tag);
  if(className) element.className = className;
  if(text !== undefined) element.textContent = String(text);
  return element;
}
function replaceChildren(target, children){ target.replaceChildren.apply(target, children); }
function setMetric(id, value){ document.getElementById(id).textContent = value === null ? t('common.unavailable') : String(value); }
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
function planContent(plan, action){
  const content = node('div', 'plan-preview');
  content.append(node('p', 'plan-summary', t('preview.summary', { action:action, count:plan.changes.length })));
  const list = node('ul', 'plan-changes');
  plan.changes.forEach(function(change){ list.append(node('li', '', enumLabel(operationLabels, change.op) + ' · ' + enumLabel(kindLabels, change.kind) + ' · ' + change.name + ' · ' + change.agent)); });
  if(!list.childNodes.length) list.append(node('li', '', t('preview.none')));
  content.append(list);
  if(plan.warningCodes.length) content.append(node('p', 'plan-warnings', t('preview.warnings', { codes:plan.warningCodes.join(', ') })));
  content.append(node('p', 'preview-note', t('preview.note')));
  return content;
}
async function doPlan(action, body, trigger){
  if(planPending){
    if(overlay && !overlay.hidden){
      const notice = node('p', 'dialog-error', t('preview.pending'));
      notice.setAttribute('role', 'alert');
      dialogContent.append(notice);
    } else announce(t('preview.pending'));
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
    if(!validPlan(plan)) throw new Error(t('preview.planUnavailable'));
    openDialog(t('preview.title', { action:action }), planContent(plan, action), null);
  } catch {
    if(requestGeneration !== planGeneration || startingDialogGeneration !== dialogGeneration) return;
    if(startedInDialog && overlay && !overlay.hidden){
      const prior = dialogContent.querySelector('.dialog-error');
      if(prior) prior.remove();
      const error = node('p', 'dialog-error', t('preview.unavailable'));
      error.setAttribute('role', 'alert');
      dialogContent.append(error);
    } else announce(t('preview.unavailable'), true);
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
  const details = [enumLabel(kindLabels, capability.kind), capability.name, enumLabel(coverageLabels, capability.coverage)];
  if(instance) details.push(instance.agent, enumLabel(availabilityLabels, instance.availability), enumLabel(managementLabels, instance.management));
  return details.join(' · ');
}
function operationButton(operation, capability, instance){
  const payload = inventoryModel && operationPayload(operation, capability, instance, inventoryModel);
  if(!payload) return null;
  const operationLabel = t('action.' + operation);
  const button = node('button', 'cell-operation plan-trigger', operationLabel);
  button.type = 'button';
  button.setAttribute('aria-label', t('operation.on', { operation:operationLabel, name:capability.name, agent:instance.agent }));
  button.addEventListener('click', function(event){
    event.stopPropagation();
    void doPlan(operationLabel, payload, button);
  });
  return button;
}
function renderCapabilityMap(inventory){
  const target = document.getElementById('capability-map');
  target.className = '';
  const table = node('table', 'fleet-table');
  const head = node('thead');
  const headerRow = node('tr');
  headerRow.append(node('th', '', t('table.capability')));
  inventory.agents.forEach(function(agent){ headerRow.append(node('th', '', agent.displayName)); });
  headerRow.append(node('th', '', t('table.coverage')));
  head.append(headerRow); table.append(head);
  const body = node('tbody');
  inventory.capabilities.filter(matchesFilter).forEach(function(capability){
    const row = node('tr', 'capability-row');
    const nameCell = node('th'); nameCell.scope = 'row';
    nameCell.append(node('span', 'kind-label', enumLabel(kindLabels, capability.kind)), node('strong', '', capability.name));
    const detailsButton = node('button', 'details-button', t('action.details'));
    detailsButton.type = 'button';
    detailsButton.setAttribute('aria-label', t('details.for', { name:capability.name }));
    detailsButton.addEventListener('click', function(){ openDialog(capability.name, logicalDetails(capability), null); });
    nameCell.append(detailsButton);
    row.append(nameCell);
    inventory.agents.forEach(function(agent){
      const matches = capability.instances.filter(function(instance){ return instance.agent === agent.id; });
      const instance = matches.length === 1 ? matches[0] : { agent:agent.id, availability:'unverifiable', management:'none', operations:[] };
      const cell = node('td', 'state-cell state-' + instance.availability);
      cell.append(node('span', 'state-label', enumLabel(availabilityLabels, instance.availability)));
      if(instance.management === 'read-only') cell.append(node('small', 'management-label', t('management.read-only')));
      else if(instance.management === 'delegated') cell.append(node('small', 'management-label', t('management.delegated')));
      const actions = node('div', 'cell-actions');
      instance.operations.forEach(function(operation){ const button = operationButton(operation, capability, instance); if(button) actions.append(button); });
      if(actions.childNodes.length) cell.append(actions);
      row.append(cell);
    });
    const coverage = node('td');
    const badge = node('span', 'coverage coverage-' + capability.coverage, enumLabel(coverageLabels, capability.coverage));
    badge.setAttribute('data-coverage-label', capability.coverage);
    coverage.append(badge); row.append(coverage);
    body.append(row);
  });
  if(!body.childNodes.length){ const row = node('tr'); const cell = node('td', 'empty-state', t('empty.map')); cell.colSpan = inventory.agents.length + 2; row.append(cell); body.append(row); }
  table.append(body); replaceChildren(target, [table]);
}
function knownInstances(capability, inventory){
  return inventory.agents.map(function(agent){
    const matches = capability.instances.filter(function(instance){ return instance.agent === agent.id; });
    return matches.length === 1 ? matches[0] : { agent:agent.id, availability:'unverifiable', management:'none', operations:[] };
  });
}
function statusBadge(instance, inventory){
  const label = enumLabel(availabilityLabels, instance.availability);
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
  content.append(node('p', 'detail-kind', enumLabel(kindLabels, capability.kind)));
  if(capability.description) content.append(node('p', '', capability.description));
  if(capability.sourceLabel) content.append(node('p', 'detail-meta', t('source.label', { value:enumLabel(sourceLabelLabels, capability.sourceLabel) })));
  if(capability.coordinate) content.append(node('p', 'detail-meta', t('identifier.label', { value:capability.coordinate.identifier })
    + (capability.coordinate.version ? ' · ' + capability.coordinate.version : '')));
  const sourceUrl = safeHttpUrl(capability.sourceUrl);
  if(sourceUrl){ const link = node('a', 'detail-link', sourceUrl); link.href = sourceUrl; link.rel = 'noreferrer'; content.append(link); }
  if((capability.kind === 'skill' || capability.kind === 'rule') && capability.tokensEst !== undefined) content.append(node('p', 'detail-meta', t('tokens.label', { value:capability.tokensEst })));
  const list = node('ul', 'agent-states');
  knownInstances(capability, inventory).forEach(function(instance){
    const item = node('li', 'agent-state');
    const agent = inventory.agents.find(function(candidate){ return candidate.id === instance.agent; });
    item.append(node('strong', '', agent ? agent.displayName : instance.agent), statusBadge(instance, inventory));
    if(instance.management === 'read-only' || instance.management === 'delegated') item.append(node('span', 'management-label', t(instance.management === 'read-only' ? 'management.read-only' : 'management.delegated')));
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
  const chips = node('div', 'inventory-kind-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', t('inventory.title'));
  ['all'].concat(Object.keys(kindCounts).filter(function(kind){ return kind !== 'all'; }).sort()).forEach(function(kind){
    const button = node('button', '', (kind === 'all' ? t('filter.all') : enumLabel(kindLabels, kind)) + ' ' + kindCounts[kind]);
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
  const statusLabel = node('label', 'compact-control', t('filter.status'));
  const status = node('select'); status.id = 'inventory-status-filter';
  [['all','filter.all'],['all-present','coverage.all-present'],['gap','coverage.gap'],['disabled','state.disabled'],['unavailable','state.unavailable'],['unsupported','state.unsupported'],['read-only','management.read-only'],['delegated','management.delegated']].forEach(function(pair){ const option = node('option', '', t(pair[1])); option.value = pair[0]; option.selected = pair[0] === inventoryStatus; status.append(option); });
  status.addEventListener('change', function(){ inventoryStatus = status.value; renderInventory(inventoryModel); document.getElementById('inventory-status-filter').focus(); }); statusLabel.append(status);
  const sortLabel = node('label', 'compact-control', t('filter.sort')); const sort = node('select'); sort.id = 'inventory-sort';
  [['kind','filter.kindName'],['name','filter.name']].forEach(function(pair){ const option = node('option', '', t(pair[1])); option.value = pair[0]; option.selected = pair[0] === inventorySort; sort.append(option); });
  sort.addEventListener('change', function(){ inventorySort = sort.value; renderInventory(inventoryModel); document.getElementById('inventory-sort').focus(); }); sortLabel.append(sort);
  toolbar.append(chips, statusLabel, sortLabel);
  const filtered = inventoryViewItems(inventory, {
    kind:inventoryKind,
    status:inventoryStatus,
    sort:inventorySort,
    query:inventoryQuery
  });
  const count = node('p', 'inventory-result-count', t('results.count', { shown:filtered.length, total:inventory.capabilities.length })); count.id = 'inventory-result-count'; count.setAttribute('aria-live','polite');
  const list = node('div', 'inventory-list');
  filtered.forEach(function(capability){
    const item = node('article', 'inventory-item');
    const heading = node('div', 'inventory-item-heading'); heading.append(node('span', 'kind-label', enumLabel(kindLabels, capability.kind)), node('h3', '', capability.name));
    const states = node('div', 'inventory-statuses'); knownInstances(capability, inventory).forEach(function(instance){ states.append(statusBadge(instance, inventory)); });
    const details = node('button', 'details-button', t('action.details')); details.type = 'button'; details.setAttribute('aria-label', t('details.for', { name:capability.name }));
    details.addEventListener('click', function(){ openDialog(capability.name, detailContent(capability, inventory), null); });
    item.append(heading, states, details); list.append(item);
  });
  if(!inventory.capabilities.length) list.append(node('p', 'empty-state inventory-empty', t('empty.inventory')));
  else if(!filtered.length) list.append(node('p', 'empty-state inventory-no-results', t('empty.inventorySearch')));
  replaceChildren(target, [toolbar, count, list]);
}
function discoveryFilterButton(group, value, label, current, onSelect){
  const button = node('button', '', label); button.type = 'button';
  const groupLabel = group.getAttribute('aria-label');
  button.setAttribute('data-discovery-filter', value);
  button.setAttribute('aria-pressed', value === current ? 'true' : 'false');
  button.addEventListener('click', function(){
    onSelect(value);
    renderDiscovery(feedModel);
    const replacement = Array.from(document.querySelectorAll('[data-discovery-filter]')).find(function(candidate){
      return candidate.getAttribute('data-discovery-filter') === value
        && candidate.parentElement && candidate.parentElement.getAttribute('aria-label') === groupLabel;
    });
    if(replacement) replacement.focus();
  });
  group.append(button);
}
function discoveryAction(item){
  if(item.kind === 'mcp-server' && item.operation === 'install'
    && (item.ecosystem === 'npm' || item.ecosystem === 'pypi') && isString(item.identifier)){
    const button = node('button', 'plan-trigger', t('discover.previewInstall')); button.type = 'button';
    button.addEventListener('click', function(){ void doPlan(t('action.install'), {
      action:'install', kind:'mcp-server', name:item.name, to:'all',
      coordinate:{ ecosystem:item.ecosystem, identifier:item.identifier, version:item.version }
    }, button); });
    return button;
  }
  return null;
}
function discoveryItem(item){
  const article = node('article', 'discovery-item');
  const heading = node('div', 'discovery-item-heading');
  heading.append(node(item.kind === 'mcp-server' ? 'h3' : 'h4', '', item.name), node('span', 'trust trust-' + item.trust, t('discover.trustLabel', { value:enumLabel(trustLabels, item.trust) })));
  article.append(heading);
  if(item.description) article.append(node('p', 'discovery-description', item.description));
  const metadata = [];
  if(item.identifier) metadata.push(t('identifier.label', { value:item.identifier }));
  if(item.category) metadata.push(t('category.label', { value:item.category }));
  metadata.push(t('source.label', { value:item.source }));
  article.append(node('p', 'discovery-meta', metadata.join(' · ')));
  const reasons = node('div', 'reason-list'); reasons.setAttribute('role','group'); reasons.setAttribute('aria-label',t('discover.reasons', { name:item.name }));
  item.reasons.forEach(function(reason){ reasons.append(node('span', 'reason', recommendationReasonLabel(reason))); });
  if(reasons.childNodes.length) article.append(reasons);
  const actions = node('div', 'discovery-actions');
  const sourceUrl = safeHttpUrl(item.url);
  if(item.kind === 'skill'){
    if(sourceUrl){ const link = node('a', 'detail-link', t('discover.openSource')); link.href = sourceUrl; link.rel = 'noreferrer'; actions.append(link); }
    actions.append(node('span', 'guidance-note', t('discover.noCli')));
  } else if(item.kind === 'plugin') {
    if(sourceUrl){ const link = node('a', 'detail-link', t('discover.openMarketplace')); link.href = sourceUrl; link.rel = 'noreferrer'; actions.append(link); }
    actions.append(node('span', 'guidance-note', sourceUrl
      ? t('discover.useGuidance')
      : t('discover.noGuidance')));
  } else if(sourceUrl){
    const link = node('a', 'detail-link', t('discover.openSource')); link.href = sourceUrl; link.rel = 'noreferrer'; actions.append(link);
  }
  const action = discoveryAction(item); if(action) actions.append(action);
  if(actions.childNodes.length) article.append(actions);
  return article;
}
function renderDiscovery(feed){
  const view = document.querySelector('[data-view="discover"]');
  let toolbar = document.getElementById('discovery-toolbar');
  if(!toolbar){ toolbar = node('div', 'discovery-toolbar'); toolbar.id = 'discovery-toolbar'; view.querySelector('.placeholder-grid').before(toolbar); }
  const kindGroup = node('div', 'discovery-filter-group'); kindGroup.setAttribute('role','group'); kindGroup.setAttribute('aria-label',t('discover.kind'));
  [['all','filter.all'],['mcp-server',null],['skill','kind.skill'],['plugin','kind.plugin']].forEach(function(pair){
    discoveryFilterButton(kindGroup, pair[0], pair[1] ? t(pair[1]) : 'MCP', discoveryKind, function(value){ discoveryKind = value; });
  });
  const trustGroup = node('div', 'discovery-filter-group'); trustGroup.setAttribute('role','group'); trustGroup.setAttribute('aria-label',t('discover.trust'));
  [['all','filter.allTrust'],['no-flags','filter.noFlags'],['caution','filter.caution'],['unknown','filter.unknown']].forEach(function(pair){
    discoveryFilterButton(trustGroup, pair[0], t(pair[1]), discoveryTrust, function(value){ discoveryTrust = value; });
  });
  const failures = node('div', 'source-failures'); failures.id = 'discovery-failures';
  if(feed) feed.failures.forEach(function(failure){ failures.append(node('p', '', t('discover.sourceUnavailable', { source:failure.source }))); });
  replaceChildren(toolbar, [kindGroup, trustGroup, failures]);
  const targets = { 'mcp-server':document.getElementById('recommended'), skill:document.getElementById('recskills'), plugin:document.getElementById('recplugins') };
  if(!feed){
    Object.keys(targets).forEach(function(kind){ targets[kind].className = 'placeholder error'; targets[kind].textContent = t('discover.unavailable'); });
    return;
  }
  const sections = discoveryViewSections(feed, { query:discoveryQuery, kind:discoveryKind, trust:discoveryTrust }, discoveryExpanded);
  Object.keys(targets).forEach(function(kind){
    const target = targets[kind]; const section = sections.find(function(candidate){ return candidate.kind === kind; });
    target.className = 'discovery-list';
    if(!section){ replaceChildren(target, []); return; }
    const children = [];
    if(kind === 'skill' || kind === 'plugin') children.push(node('h3', 'discovery-section-title', t(kind === 'skill' ? 'kind.skills' : 'kind.plugins')));
    section.visible.forEach(function(item){ children.push(discoveryItem(item)); });
    if(!section.visible.length) children.push(node('p', 'empty-state', t('empty.discovery')));
    if(section.canExpand || section.canCollapse){
      const toggle = node('button', 'discovery-toggle', t(section.canExpand ? 'discover.showAll' : 'discover.collapse')); toggle.type = 'button';
      toggle.setAttribute('data-discovery-toggle', kind);
      toggle.setAttribute('aria-expanded', section.canCollapse ? 'true' : 'false');
      toggle.addEventListener('click', function(){
        discoveryExpanded[kind] = section.canExpand;
        renderDiscovery(feedModel);
        const replacement = document.querySelector('[data-discovery-toggle="' + kind + '"]');
        if(replacement) replacement.focus();
      });
      children.push(toggle);
    }
    replaceChildren(target, children);
  });
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
        action = node('button', 'plan-trigger', t('action.reviewUpdate')); action.type = 'button';
        action.setAttribute('aria-label', t('operation.on', { operation:t('action.reviewUpdate'), name:update.name, agent:update.agent }));
        action.addEventListener('click', function(){ void doPlan(t('action.update'), { action:'update', kind:update.kind, name:update.name, to:update.agent, coordinate:{ version:update.to } }, action); });
      }
      list.append(attentionItem(t('attention.mcpUpdate', { name:update.name }), update.agent + (update.to ? ' · ' + update.to : ''), action));
    });
    feed.skillUpdates.forEach(function(update){ list.append(attentionItem(t('attention.skillUpdate', { name:update.name }), update.agent + ' · ' + enumLabel(skillUpdateLabels, update.state), null)); });
    feed.failures.forEach(function(failure){ list.append(attentionItem(t('attention.sourceUnavailable'), failure.source, null)); });
  } else list.append(attentionItem(t('attention.feedUnavailable'), t('attention.feedDetail'), null));
  if(results.conflicts) results.conflicts.conflicts.forEach(function(conflict){ list.append(attentionItem(t('attention.ruleConflict', { name:conflict.name }), conflict.agents.join(', ') + ' · ' + conflict.reasonCode, null)); });
  else list.append(attentionItem(t('attention.conflictsUnavailable'), t('attention.conflictsDetail'), null));
  if(results.overview){
    results.overview.agents.filter(function(agent){ return agent.present && !agent.inventoryAvailable; }).forEach(function(agent){ list.append(attentionItem(t('agent.unavailable'), agent.displayName, null)); });
    results.overview.drift.findings.forEach(function(finding){ list.append(attentionItem(t('attention.drift', { state:enumLabel(driftStateLabels, finding.state), name:finding.name }), finding.agent + (finding.reasonCode ? ' · ' + finding.reasonCode : ''), null)); });
    results.overview.drift.unmanaged.forEach(function(finding){ list.append(attentionItem(t('attention.unmanaged', { name:finding.name }), finding.agent + ' · ' + finding.reasonCode, null)); });
  } else list.append(attentionItem(t('attention.overviewUnavailable'), t('attention.overviewDetail'), null));
  if(!results.inventory) list.append(attentionItem(t('attention.inventoryUnavailable'), t('attention.inventoryDetail'), null));
  if(!list.childNodes.length) list.append(attentionItem(t('empty.attention'), t('attention.noneDetail'), null));
  replaceChildren(target, [list]);
}
function renderDrift(overview, conflicts){
  const target = document.getElementById('conflicts');
  target.className = 'drift-panel';
  if(!overview){ replaceChildren(target, [node('p', 'empty-state', t('drift.unavailable'))]); return; }
  const drift = overview.drift;
  const summary = node('p', 'drift-summary', t('drift.summary', { checked:drift.checked, findings:drift.findings.length, unmanaged:drift.unmanagedCount }));
  const note = node('p', 'drift-note', t('drift.note'));
  const groups = node('div', 'drift-groups');
  [['modified','drift.modified'],['missing','drift.missing'],['unverifiable','drift.unverifiable'],['unmanaged','drift.unmanaged']].forEach(function(pair){
    const state = pair[0];
    const section = node('section', 'drift-group drift-' + state);
    const items = state === 'unmanaged' ? drift.unmanaged : drift.findings.filter(function(item){ return item.state === state; });
    section.append(node('h3', '', t(pair[1]) + ' (' + items.length + ')'));
    const list = node('ul', 'drift-list');
    items.forEach(function(item){
      list.append(node('li', '', item.name + ' · ' + enumLabel(kindLabels, item.kind) + ' · ' + item.agent + (item.reasonCode ? ' · ' + item.reasonCode : '')));
    });
    if(!items.length) list.append(node('li', 'empty-state', t('empty.none')));
    section.append(list); groups.append(section);
  });
  const conflictCount = conflicts ? conflicts.conflicts.length : 0;
  const conflictNote = node('p', 'drift-note', conflicts ? t('drift.conflicts', { count:conflictCount }) : t('drift.conflictsUnavailable'));
  replaceChildren(target, [summary, note, groups, conflictNote]);
}
function rollbackContent(item){
  const content = node('div', 'rollback-preview');
  content.append(node('p', 'plan-summary', enumLabel(operationLabels, item.op) + ' · ' + item.name + ' · ' + item.agent));
  if(item.scope) content.append(node('p', 'detail-meta', t('rollback.scope', { scope:enumLabel(scopeLabels, item.scope) })));
  content.append(node('p', 'rollback-warning', t('rollback.guard')));
  return content;
}
function setRollbackButtonsDisabled(disabled){
  document.querySelectorAll('button[data-audit-id]').forEach(function(button){ button.disabled = disabled; });
}
function beginRollback(item){
  if(rollbackPending) return;
  openDialog(t('rollback.title'), rollbackContent(item), async function(){
    if(rollbackPending) return;
    rollbackPending = true;
    const requestGeneration = ++rollbackGeneration;
    const startingDialogGeneration = dialogGeneration;
    dialogConfirm.disabled = true;
    setRollbackButtonsDisabled(true);
    try {
      const result = await postJson('/api/rollback', { auditId:item.id });
      const validResult = result && ['restored','removed','skipped'].indexOf(result.action) >= 0
        && (result.reasonCode === undefined || ['TARGET_DIVERGED','ALREADY_ABSENT','UNVERIFIABLE_TARGET','OPERATION_WARNING'].indexOf(result.reasonCode) >= 0);
      if(!validResult) throw new Error(t('rollback.responseUnavailable'));
      if(requestGeneration !== rollbackGeneration || startingDialogGeneration !== dialogGeneration){ await refresh(); return; }
      closeDialog();
      announce(t('rollback.result', { action:enumLabel(rollbackActionLabels, result.action), reason:result.reasonCode ? ': ' + result.reasonCode : '.' }), result.action === 'skipped');
      await refresh();
    } catch {
      if(requestGeneration === rollbackGeneration && startingDialogGeneration === dialogGeneration){
        closeDialog();
        announce(t('rollback.failed'), true);
      }
    } finally {
      if(requestGeneration === rollbackGeneration){
        rollbackPending = false;
        dialogConfirm.disabled = false;
        setRollbackButtonsDisabled(false);
      }
    }
  });
  dialogConfirm.textContent = t('rollback.confirm');
}
function renderActivity(activity){
  activityModel = activity;
  const target = document.querySelector('[data-view="activity"] .placeholder');
  target.className = 'activity-panel';
  if(!activity){ replaceChildren(target, [node('p', 'empty-state', t('activity.unavailable'))]); return; }
  const list = node('ul', 'activity-list');
  activity.items.forEach(function(item){
    const selectable = item.rollbackEligible && !item.rolledBack && item.source === 'core-audit';
    const record = node('li', 'activity-record');
    const entry = node(selectable ? 'button' : 'article', 'activity-item');
    const timestamp = new Date(item.ts);
    const timestampLabel = timestamp.toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US');
    if(selectable){
      entry.type = 'button';
      entry.setAttribute('data-audit-id', item.id);
      entry.setAttribute('aria-label', t('rollback.select', { op:enumLabel(operationLabels, item.op), name:item.name, agent:item.agent,
        scope:item.scope ? ', ' + t('rollback.scope', { scope:enumLabel(scopeLabels, item.scope) }) : '', source:enumLabel(activitySourceLabels, item.source), time:timestampLabel }));
      entry.addEventListener('click', function(){ beginRollback(item); });
    }
    const time = node('time', 'activity-time', timestampLabel);
    time.setAttribute('datetime', timestamp.toISOString());
    entry.append(time);
    entry.append(node('strong', '', enumLabel(operationLabels, item.op) + ' · ' + item.name));
    entry.append(node('span', 'activity-meta', enumLabel(activitySourceLabels, item.source) + ' · ' + item.agent + (item.scope ? ' · ' + enumLabel(scopeLabels, item.scope) : '')));
    entry.append(node('span', 'activity-outcome', item.rolledBack ? t('activity.rolledBack') : enumLabel(outcomeLabels, item.outcome)));
    record.append(entry); list.append(record);
  });
  if(!activity.items.length) list.append(node('li', 'empty-state', t('empty.activity')));
  const completeness = activity.delegatedActions.status === 'available' ? '' : t('activity.delegated', { status:enumLabel(delegatedStatusLabels, activity.delegatedActions.status) });
  replaceChildren(target, completeness ? [node('p', 'activity-note', completeness), list] : [list]);
}
function renderResults(results){
  cachedResults = results;
  inventoryModel = results.inventory;
  feedModel = results.feed;
  if(results.inventory){ renderCapabilityMap(results.inventory); renderInventory(results.inventory); }
  else {
    const target = document.getElementById('capability-map'); target.className = 'placeholder error'; target.textContent = t('common.unavailable');
    const inventoryTarget = document.getElementById('inventory'); inventoryTarget.className = 'placeholder error'; inventoryTarget.textContent = t('attention.inventoryUnavailable') + '.';
  }
  renderDiscovery(results.feed);
  renderDrift(results.overview, results.conflicts);
  renderActivity(results.activity);
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
  announce(t('refresh.progress'), false);
  try {
    const settled = await Promise.allSettled([get('/api/inventory'), get('/api/overview'), get('/api/feed?refresh=1'), get('/api/conflicts'), get('/api/activity')]);
    if(generation !== refreshGeneration) return;
    const results = {
      inventory:settled[0].status === 'fulfilled' && validInventory(settled[0].value) ? settled[0].value : null,
      overview:settled[1].status === 'fulfilled' && validOverview(settled[1].value) ? settled[1].value : null,
      feed:settled[2].status === 'fulfilled' && validFeed(settled[2].value) ? settled[2].value : null,
      conflicts:settled[3].status === 'fulfilled' && validConflicts(settled[3].value) ? settled[3].value : null,
      activity:settled[4].status === 'fulfilled' && validActivity(settled[4].value) ? settled[4].value : null
    };
    renderResults(results);
    const failures = Object.keys(results).filter(function(key){ return results[key] === null; }).length;
    const sourceFailures = results.feed ? results.feed.failures.length : 0;
    if(failures) announce(t('refresh.endpoints', { count:failures }), true);
    else if(sourceFailures) announce(t('refresh.sources', { count:sourceFailures }), true);
    else announce(t('refresh.done'), false);
  } catch(error){
    if(generation === refreshGeneration) announce(t('refresh.unavailable'), true);
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
const rollbackButton = document.getElementById('rollback');
rollbackButton.textContent = t('nav.activity');
rollbackButton.setAttribute('aria-label', t('rollback.openActivity'));
rollbackButton.addEventListener('click', function(){
  location.hash = '#activity';
  activateView(true);
});

const globalSearch = document.getElementById('global-search');
const searchNote = document.getElementById('search-note');
searchNote.textContent = t('search.note');
globalSearch.addEventListener('input', function(){
  if(requestedView() === 'discover'){
    discoveryQuery = globalSearch.value;
    if(feedModel) renderDiscovery(feedModel);
  } else {
    inventoryQuery = globalSearch.value;
    if(inventoryModel) renderInventory(inventoryModel);
  }
});
const languageSelect = document.getElementById('language');
languageSelect.value = language;
languageSelect.addEventListener('change', function(){
  const next = languageSelect.value;
  if(next !== 'en' && next !== 'ko') return;
  language = next;
  sSet(localStore, 'fleet_language', language);
  document.documentElement.lang = language;
  live.textContent = '';
  live.className = 'live-region';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  applyStaticTranslations();
  applyTheme();
  rollbackButton.setAttribute('aria-label', t('rollback.openActivity'));
  searchNote.textContent = t('search.note');
  activateView(false);
  if(cachedResults) renderResults(cachedResults);
});
void refresh();
});
`;
