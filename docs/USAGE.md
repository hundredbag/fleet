# fleet 사용법

내 AI 코딩 에이전트의 capability, configuration, constraint를 한 곳에서 보는 도구다. MCP 서버, 스킬, Fleet 관리 룰, 권한, vendor plugin, subagent 정의를 inventory한다. MCP·스킬·룰은 adapter가 지원하는 범위에서 변경하고, 권한·subagent는 읽기 전용이며 plugin 변경은 vendor CLI에 위임한다. Command와 hook inventory는 아직 지원하지 않는다.
쓰는 방법은 셋이다. **① 터미널(CLI)** 로 직접 실행하거나, **② AI에게 시켜서(MCP)** 대화 중에 실행하거나, **③ 로컬 웹 대시보드**에서 상태와 작업 미리보기를 확인할 수 있다.

> MCP·skill·rule·plugin 설치/동기화/제거, profile import, pack install은 기본 dry-run이다. CLI에서는 `--commit`, MCP에서는 `commit: true`가 있어야 적용된다. `fleet export`는 대상 디렉터리를 즉시 쓰고 CLI/MCP rollback도 별도 commit 없이 즉시 실행된다. Web의 capability 버튼은 먼저 dry-run을 표시하고 별도 확인 뒤 짧은 수명의 single-use plan만 적용한다. Activity rollback도 선택한 audit ID를 다시 확인한 뒤 실행한다.

---

## 0. 준비 (한 번만)

```bash
cd <fleet-repo>
npm install
npm run build          # dist/ 생성

# 권장: 전역 명령으로 등록 → 어디서나 `fleet` / `fleet-mcp` 사용
npm link
fleet help
```

전역 등록이 싫으면 그냥 풀경로로 실행해도 된다:

```bash
node /absolute/path/to/fleet/dist/cli/index.js help
# (개발 모드, 빌드 없이) npm run dev -- help
```

아래 예시는 `npm link` 했다고 보고 `fleet ...`로 쓴다.

**기본 에이전트 ID**: `claude-code`, `codex`. `all`은 요청한 capability 종류를 쓸 수 있고 알려진 설정 경로에서 현재 감지된 adapter만 대상으로 한다. 명시적인 ID는 해당 writer가 있으면 미감지 상태에서도 새 설정 생성 계획을 만들 수 있다.

---

## 1. 인벤토리 — 뭐가 깔려있나 한눈에

```bash
fleet inventory          # 지원되는 capability 종류 × agent 매트릭스
fleet inventory --json   # raw 설정·env·headers·prompt를 제외한 redacted summary JSON
```

표 기호: `✓`=설치됨, `✗`=비활성, `–`=없음, `U/P/L`=user/project/local 스코프.
같은 agent·이름·scope가 여러 비공개 project context에 있으면 `L×2`처럼 개수를
표시한다. Fleet은 IDE나 실행기가 아니어서 “현재 프로젝트”가 없으므로 vendor의
runtime precedence를 임의로 적용해 하나를 effective 설정이라고 주장하지 않는다.

---

## 2. MCP 서버 관리

### 설치 (stdio: 명령 기반)

```bash
# 1) 먼저 dry-run으로 계획 확인 (아무것도 안 씀)
fleet install github --to all --command npx --arg -y --arg @modelcontextprotocol/server-github

# 2) 좋으면 --commit으로 실제 적용
fleet install github --to all --command npx --arg -y --arg @modelcontextprotocol/server-github --commit
```

- `--arg`는 인자마다 하나씩 반복.
- 원격(remote) 서버: `--url <url>` (+ SSE면 `--sse`, 토큰 환경변수면 `--bearer-env MY_TOKEN`).
- `--command`와 `--url`은 **둘 중 하나만**.
- 현재 변경 대상은 user scope뿐이다. project/local 항목은 inventory에서 보이지만
  정확한 scope writer가 구현될 때까지 read-only이며, core도 해당 scope 변경을
  파일을 열기 전에 거부한다.

동일 agent에 같은 이름의 MCP 서버가 여러 scope로 존재하면 source 선택은
명시적이어야 한다.

```bash
fleet sync shared --from claude-code --from-scope project --to codex
fleet remove shared --from claude-code --scope user
```

scope를 생략해도 후보가 하나뿐이면 sync할 수 있다. 후보가 둘 이상이면 배열
순서나 추정 precedence로 선택하지 않고 다시 요청하도록 거부한다.

### 동기화 — 한 에이전트 것을 다른 데로 복사

```bash
fleet sync github --from claude-code --to codex            # dry-run
fleet sync github --from claude-code --to all --commit     # 적용
```

### 제거

```bash
fleet remove github --from codex --commit
```

---

## 3. 스킬 관리 (SKILL.md 디렉토리)

```bash
# 로컬 스킬 폴더를 에이전트들에 설치
fleet skill install my-skill --from-dir ./skills/my-skill --to all --commit

# 한 에이전트의 스킬을 다른 데로 복사
fleet skill sync my-skill --from claude-code --to codex --commit

# 제거
fleet skill remove my-skill --from codex --commit
```

로컬 디렉터리를 소스로 지정하는 `--from-dir`는 CLI에 계속 있다. Web
Discover는 사용자가 임의의 URL이나 로컬 경로를 직접 입력하여 스킬을
설치하는 통로가 아니다.

디렉토리는 검증된 stage로 통째로 안전 복사된다(심볼릭링크·빈 폴더·실행권한 보존, 기존 pathname 분리·재검증, 새 pathname 선점 방지, 롤백 가능). 교체는 복구 가능한 다단계 commit이며 전체 트리를 단일 syscall transaction으로 바꾸는 것은 아니다.

---

## 4. 룰(행동지침) 관리 — CLAUDE.md / AGENTS.md 안의 관리 블록

```bash
# 지침 블록 설치 (사람이 쓴 내용은 절대 안 건드림)
fleet rule install style --text "Always answer concisely." --to all --commit

# 한 에이전트의 룰을 다른 데로 복사
fleet rule sync style --from claude-code --to codex --commit

# 제거 (그 블록만 빠지고 나머지 파일은 그대로)
fleet rule remove style --from all --commit
```

- 룰은 `<!-- fleet:rule:NAME -->…<!-- /fleet:rule:NAME -->` 블록으로만 관리된다.
- **사람이 직접 쓴 부분이 바뀔 변경은 자동으로 거부된다**(안전장치). 포맷 자동 번역은 안 함.
- Codex의 `~/.codex/rules/*.rules`(명령 권한)는 행동지침이 아니라 손대지 않는다.

---

## 5. Vendor plugin 관리

```bash
fleet plugin install figma@official --to claude-code          # vendor CLI preview
fleet plugin install figma@official --to claude-code --commit # vendor CLI 실행
fleet plugin remove figma@official --from claude-code --commit
```

Plugin 작업은 검증 가능한 inventory를 제공하는 adapter에서 vendor CLI에 위임한다. Fleet의 파일 백업, hash guard,
file rollback은 적용되지 않는다. Fleet은 실행 전후 plugin inventory를 다시 읽어 실제
상태 변화가 확인된 경우만 적용 성공과 가능한 반대 작업을 안내한다. 이미 설치됐거나
제거된 상태, vendor no-op, legacy 기록, 검증 불가 결과에는 파괴적 undo 명령을 제시하지
않고 vendor 상태 확인을 요구한다. `fleet rollback`은 vendor 명령을 대신 실행하지 않는다.
Claude Code는 설정의 논리 plugin 이름과 marketplace 식별자를 분리해 표시한다. Codex는
`plugin list --json`과 `.codex-plugin/plugin.json`을 제공하지만 Fleet이 그 JSON schema를
아직 fixture로 검증하지 않았으므로 plugin inventory를 `unverifiable`로 표시하고 변경
작업을 노출하지 않는다. 디렉터리 이름을 설치 상태로 추정하지 않는다.

Web Discover의 plugin 설치는 로컬에 등록된 Claude marketplace의 미러링된
카탈로그에서 `plugin@marketplace`를 확인할 수 있을 때만 나타난다. 계획
요청에서는 논리 plugin `name`과 `marketplace`를 별도 필드로 유지하고,
권위 있는 inventory·위임 계약과 사용 가능한 vendor runtime이 있는 Claude Code
한 대를 정확히 선택해 CLI에 위임한다. 현재 Codex는 이 권위 inventory가
검증 불가능하므로 Web 설치 대상이 아니다.

---

## 6. 진단·provenance·profile·pack

```bash
fleet doctor
fleet lock --json
fleet drift --json
fleet config
fleet whats-new --refresh
fleet skill find browser

fleet pack install --from-dir ./pack --to all --variant full       # dry-run
fleet pack install --from-dir ./pack --to all --variant full --commit

fleet export --to ./fleet-profile                                  # 즉시 기록
fleet import --from ./fleet-profile --to all                       # dry-run
fleet import --from ./fleet-profile --to all --commit
```

`fleet export --to`에는 dotfiles Git 저장소의 루트가 아니라 그 안의 전용 profile
하위 디렉터리를 지정한다. Fleet은 `.git`이 직접 들어 있는 export target을 교체하지
않는다.

`fleet lock --json`은 로컬 운영자용 원본 provenance 출력이다. 설치 경로, content
hash, audit ID 같은 로컬 메타데이터를 포함할 수 있으므로 그대로 AI 도구나 외부
로그에 전달하지 않는다. MCP의 `lock_status`는 별도의 allowlist 요약만 반환한다.

- `doctor`: adapter, Fleet state, config를 점검한다. 각 finding은 안정적인
  `code`를 가지며 경로·파싱 오류 문구를 다시 해석하지 않는다. 적용 가능한 경우
  로컬에서 수행할 안전한 다음 단계가 `next`로 표시된다. 종료 코드는 정상 0,
  경고 1, 오류 2다.
- agent 진단은 실행 파일을 실제로 실행하지 않고 로컬 executable 경로만 확인한다.
  `installed-unconfigured`, `configured-runtime-missing`, 설정 경로의
  `configuration-unavailable`, 파싱 실패의 `inventory-unavailable`, 정상적인 빈
  inventory를 서로 구분한다. 실행 파일만 발견된 agent는 `present`가 아니므로
  `--to all` 변경 대상에 자동으로 추가되지 않는다.
- `lock`/`drift`: Fleet이 기록한 provenance와 현재 상태의 차이를 확인한다.
- trust gate는 package pin/source 형태와 skill tree의 script·실행권한·symlink·숨은
  Unicode 같은 로컬 정적 사실만 판정한다. 안전성 인증이나 품질 점수가 아니다.
  plan에는 사람이 읽는 설명을, `fleet.lock`에는 현재 설치의 verdict를, core audit에는
  변경 당시의 고정 trust level/reason code snapshot을 기록한다. MCP `lock_status`와
  Web Activity는 allowlist된 code만 공개한다.
- 이미 존재하는 `fleet.lock`이 손상되었거나 읽을 수 없으면 core 및 vendor 변경은
  대상 수정 전에 중단된다. 대상 변경 뒤에 새로 발생한 lock 기록 실패는 실제 적용
  결과를 숨기지 않고 CLI 경고 및 공개 API의 `PROVENANCE_WARNING` code로 보고된다.
- `config`: 사용자 설정, 로컬 team policy의 상태와 실제 경로, 최종 effective
  config를 보여준다. `agents`는 이 프로세스에서
  등록할 adapter ID allowlist이고, `feedSources`는 기본 discovery source ID
  allowlist다. 두 필드 모두 `null`/생략은 사용 가능한 전체, `[]`는 없음이다.
  명시적인 `--to`도 `agents`에서 제외한 adapter를 다시 활성화하지 않는다.
  `hub`는 `hubUrl`, `pulsemcp`는 `PULSEMCP_API_KEY`가 함께 있어야 실제 source가
  된다. 알 수 없거나 필요한 설정이 빠진 ID는 `doctor`가 안정적인 config finding으로
  보고한다.

팀이 로컬 상한을 배포해야 하면 `$FLEET_HOME/team-policy.json`에 version 1 문서를
둔다. Fleet은 외부 정책 서버나 제3자 계정에 접속하지 않으며 이 파일을 수정하지도
않는다.

```json
{
  "version": 1,
  "agents": ["claude-code", "codex"],
  "feedSources": ["mcp-registry", "skills.sh"],
  "trustPolicy": "block",
  "allowAdapterModules": false
}
```

`agents`와 `feedSources`는 사용자 config와 교집합이 되고, team의 `block`은 사용자나
plan별 `warn` override로 약화할 수 없다. 정책 파일이 존재하면 BYO module 실행은
`allowAdapterModules: true`로 명시적으로 허용해야 한다. 알 수 없는 version/필드,
중복·잘못된 목록, JSON 손상, symlink/wrong-type/unreadable leaf는 policy 오류다.
읽기 전용 시작은 adapter/feed/module을 빈 집합과 `block`으로 제한하고, 모든 mutation은
수리 전 중단한다. `doctor`와 `fleet config`가 이를 stable status/code로 보고한다.

설정 우선순위는 다음처럼 고정한다.

1. version 1 team policy가 있으면 그 `agents`/`feedSources`가 최상위 상한이고,
   사용자 config의 같은 필드는 그 안에서만 더 줄일 수 있다. team policy의
   `allowAdapterModules`는 import 이전에 적용된다.
2. 사용자 `agents`/`feedSources` allowlist는 team policy 안에서 프로세스가 사용할
   수 있는 집합의 상한이다.
   개별 명령의 `--to`, `--from`이나 discovery 요청이 이 경계를 넓히지 못한다.
   `agents`는 adapter를 로드할 때 고정되므로 장시간 실행하는 MCP/Web 프로세스는
   설정 변경 뒤 재시작한다. `feedSources`는 discovery 요청 때 다시 읽고, 선택한
   source ID 집합이 바뀌면 기존 15분 cache와 다른 key를 사용한다. 직접 registry를
   조회하는 CLI `skill find`와 MCP `skill_search`도 `skills.sh`가 allowlist에 없으면
   요청을 거부한다.
3. `serve --port`와 `serve --allow-host`처럼 명시한 실행 옵션은 대응하는 `port`,
   `allowHosts` 설정을 그 실행에서 대체한다. 옵션이 없을 때만 config 값을 쓴다.
4. 지원되는 planner의 명시적 trust override(예: skill install의 `--trust`)는 그
   plan에 고정되고, override가 없으면 commit 시점의 `trustPolicy`를 다시 검사한다.
   단, team policy의 `block`은 언제나 우선한다.
5. 같은 이름의 user/project/local capability에는 암묵적 precedence가 없다.
   명시한 `fromScope`가 우선하고, 생략 시 후보가 정확히 하나일 때만 선택한다.
   같은 scope 안에 비공개 context가 여러 개인 `L×2` 상태는 scope만으로 특정할 수
   없으므로 계속 read-only다. `agents`와 `feedSources` 배열 순서도 precedence를
   바꾸지 않으며, registry의 결정적 내장 순서를 유지한다.

- `export`: MCP의 `env`와 `header` 값만 secret reference로 바꾼다. URL,
  command argument, rule body, skill 파일의 credential은 자동 탐지하지 않으므로
  Git에 commit하기 전에 결과를 검토해야 한다. 기존 export 디렉터리를 즉석에서
  항목별 수정하지 않고, sibling staging에 완전한 `profile.json`과 `skills/`
  generation을 만들고 검증한 뒤 교체한다. export 디렉터리의 그 밖의 파일은
  보존하며, 동시에 시작한 다른 Fleet export는 거부한다.
- profile v1 manifest는 필드, MCP transport별 spec, capability 이름, 중복,
  secret 선언과 reference 대응을 엄격히 검사한다. 하나라도 손상되면 target을
  계획하거나 변경하지 않는다. `group/skill` 형태의 grouped skill identity도 안전한
  상대 경로 segment로 검증해 그대로 export/import한다.
- `import`는 profile에 적힌 capability가 선택한 target에 존재해야 한다는
  **additive desired state**다. 생략된 capability를 삭제하거나 prune하지 않는다.
  모든 secret을 먼저 해석하고 모든 항목을 예비 계획한 뒤에만 commit을 시작한다.
  여러 항목이 같은 native 설정 파일을 공유할 수 있으므로 각 항목은 실제 적용
  직전에 현재 상태에서 다시 계획된다.
- `import`와 `pack install`은 기본 dry-run이며 항목별로 적용되므로 전체가 하나의
  원자적 transaction은 아니다. 초기 검증 뒤에도 runtime·동시 변경 오류가 나면
  앞서 성공한 항목은 audit/결과에 그대로 보고되고 뒤 항목은 적용되지 않는다.

---

## 7. 충돌 점검

```bash
fleet conflicts
```

같은 에이전트에 **상시 적용되는 룰끼리 지향이 반대**인 경우(예: "간단히" vs "자세히")를 후보로 알려준다.
⚠️ 휴리스틱(저신뢰) — fleet이 관리하는 룰 블록만 보며, 못 찾았다고 충돌이 없다는 보장은 아니다. 직접 확인할 것.

---

## 8. 되돌리기

```bash
fleet rollback            # 최신 rollback 가능 core 변경만 되돌림; 더 최신 plugin 위임 작업이 있으면 거부
fleet rollback <auditId>  # 특정 변경 (감사 ID는 ~/.fleet/audit.jsonl)
```

적용 기록·백업은 `~/.fleet/`(audit.jsonl, backups/)에 남는다. 이건 fleet의 상태 디렉토리. core audit 기록이 손상·미완료 상태이거나 ID가 중복되면 명시적 ID 요청을 포함한 모든 core rollback을 중단한다. 인자 없는 롤백은 더 최신인 실제 변경 또는 검증 불가 delegated plugin 기록이 있으면 오래된 core 변경을 건드리지 않는다. 실행 전후 inventory로 변화가 확인된 성공 기록만 반대 plugin 작업을 안내하고, no-op은 변경 경계에서 제외하며, legacy·실패·검증 불가 기록은 vendor 상태 확인을 요구한다. 이 CLI 동작과 달리 웹 대시보드는 Activity에서 선택한 audit ID만 롤백한다.

---

## 9. AI에게 시켜서 쓰기 (fleet-mcp)

fleet 자신을 MCP 서버로 에이전트에 꽂으면, **대화 중에 말로** 시킬 수 있다.

### Claude Code에 연결

```bash
# npm link 했다면:
claude mcp add fleet -- fleet-mcp
# 안 했다면 풀경로:
claude mcp add fleet -- node /absolute/path/to/fleet/dist/mcp/server.js
```

빼려면: `claude mcp remove fleet`

### Codex에 연결 (`~/.codex/config.toml`)

```toml
[mcp_servers.fleet]
command = "node"
args = ["/absolute/path/to/fleet/dist/mcp/server.js"]
```

### 연결 후 — 이렇게 말하면 된다

- "fleet inventory 보여줘"
- "playwright를 claude랑 codex에 깔아줘" → (기본 dry-run 계획을 보여줌; "적용해" 하면 commit)
- "claude에 있는 github MCP를 codex에도 맞춰줘"
- "내 룰 중에 서로 충돌하는 거 있는지 봐줘"
- "방금 한 core 변경을 되돌려" (더 최신인 plugin 위임 작업이 있으면 rollback은
  core 변경을 건드리지 않는다. 실행 전후 inventory로 변화가 입증된 성공 작업만 반대
  작업을, legacy·실패·검증 불가 결과에는 일반 vendor recovery 확인을 안내한다.)

노출되는 MCP 도구: `inventory · install · sync · remove · skill_install/sync/remove · rule_install/sync/remove · doctor · drift_check · lock_status · whats_new · plugin_install/remove · skill_search · conflicts · rollback`. Install/sync/remove 계열은 `commit: true`가 없으면 preview만 반환한다. `rollback`은 예외로 commit 인자가 없는 즉시 실행 도구이므로 가능한 경우 `auditId`를 명시한다. core audit 기록이 손상·미완료 상태이거나 ID가 중복되면 명시적 ID 요청도 거부한다. audit ID가 없고 더 최신인 delegated plugin 변경 또는 검증 불가 기록이 있으면 오래된 core 변경을 건드리지 않는다. 실행 전후 inventory로 `changed`가 입증된 성공 install/remove만 반대 plugin 작업을 안내하고, no-op은 변경 경계에서 제외하며, legacy·실패·손상·읽기 불가 기록에는 일반 vendor recovery 확인을 고정 code로 안내한다. AI 응답은 도구별 allowlist DTO를 사용하며 허용된 문자열에는 알려진 secret 형태를 추가로 scrub한다.

여러 대상에 적용하다 일부가 실패하면 MCP는 `status: "partial"`, Web API는
`outcome: "partial"`을 반환한다. 두 응답의 `records`는 실제로 변경된 각 대상과
`auditRecorded`를 따로 싣고, 기록에 성공한 항목만 rollback에 사용할 수 있는
`auditId`를 포함한다. 플러그인 응답은 논리 이름 `name`과 공급자 좌표
`marketplace`를 별도 필드로 유지한다. 위임 작업의 `records`는
`delegatedRecorded`와 `delegatedId`를 사용하며, 이 ID는 Activity의 vendor 작업과
연결하기 위한 값이지 core file rollback ID가 아니다.

커밋 도중 원본이 recovery 경로에 보존됐지만 공개 target을 확정하거나 복원하지
못한 경우에는 일반 실패나 변경 없음으로 축약하지 않는다. MCP는
`status: "outcome-unknown"`, `errorCode: "RECOVERY_PENDING"`와
`recoveryClass: "manual-config-recovery"`를, Web apply는
`outcome: "outcome-unknown"`과 같은 recovery class를 반환한다. 이 상태에서는 같은
변경을 재시도하지 말고 `fleet doctor`, target, Fleet recovery 경로를 먼저 확인한다.

### 0.1 machine payload migration

MCP와 Web JSON 응답은 최상위 `schemaVersion: 2`를 포함한다. 0.0.1의 raw
diagnostic/path 중심 필드는 고정 code와 allowlist DTO로 교체되었으므로, 소비자는
필드 존재를 가정하지 말고 `schemaVersion`을 확인해야 한다. `fleet inventory --json`
역시 version 2 redacted summary를 출력한다. BYO writer adapter는 이제 writer method와
`supportsWrite: true`뿐 아니라 해당 kind의 명시적
`capabilitySupport: { inventory: 'supported', management: 'writable' }`가 필요하다.

---

## 10. 통합 웹 대시보드

```bash
fleet serve
# 터미널에 출력된 http://127.0.0.1:7777/?token=… 주소를 브라우저에서 연다.
```

대시보드는 다음 다섯 뷰로 구성된다.

- **Overview**: 감지된 에이전트 수, capability 인스턴스와 고유 키 수, 업데이트와 드리프트 수를 요약한다. capability × agent 맵과 확인이 필요한 신호도 함께 보여준다.
- **Inventory**: MCP 서버, 스킬, 룰, 플러그인을 검색·필터·정렬하고 에이전트별 상세 상태를 확인한다. 각 셀에는 서버가 명시한 정확한 작업만 표시된다.
- **Discover**: MCP 서버, 스킬, 플러그인을 종류별로 제한된 개수만 먼저 보여준다. 검색하거나 펼쳐 더 볼 수 있으며, 공개 피드의 출처, 신뢰 표시(`No flags`/`Caution`/`Unknown`), 추천 이유(`New`/`Popular`/`Marketplace`/현재 설치 항목과 관련됨)를 그대로 표시한다. 이 정보는 품질 점수나 추천 등급이 아니다.
- **Drift**: lock 기준과 다른 `modified`, `missing`, `unverifiable`, `unmanaged` 항목과 룰 충돌 후보를 묶어서 보여준다.
- **Activity**: 최근 `core-audit`와 `delegated-plugin` 기록을 함께 보여준다. 적용 결과와 롤백 가능 여부는 기록마다 따로 표시된다.

### 상태 용어 읽기

- `missing`: 해당 에이전트에서 capability가 발견되지 않았다.
- `unavailable`: 에이전트가 없거나 인벤토리를 읽지 못했다.
- `unsupported`: 그 어댑터가 해당 capability 종류의 인벤토리를 지원하지 않는다.
- `all present`: 지원 대상 에이전트 모두에서 발견됐다. 설정 내용이 동일하거나 정상이라는 뜻은 아니다.
- `gap`: 지원 대상 중 일부에만 존재한다.
- `read-only`: 볼 수 있지만 Fleet이 그 셀을 변경하지 않는다.
- `delegated`: Fleet이 파일을 직접 쓰지 않고 공급자 CLI에 작업을 위임한다.

따라서 화면은 근거 없이 `Healthy`나 `aligned`라고 판정하지 않는다. 읽기 실패와 미지원도 누락과 구분한다.

### 가능한 작업과 한계

버튼은 capability 종류와 에이전트 어댑터가 광고한 작업을 그대로 따른다.

- MCP 서버는 권한 있는 어댑터에서 설치·업데이트, 그리고 특정 source agent에서
  target agent로의 정확한 동기화·제거 미리보기를 지원한다. Discover 설치는 피드가
  제공한 정확한 `npm`/`pypi` package identifier와 선택적 version만 사용한다.
  서버가 현재 inventory를 읽을 수 있고 writer를 제공하며 동일한 논리 capability가
  아직 없는 agent만 대상으로 내놓는다. 그중 하나 또는 표시된 전부를 선택해 미리본다.
  피드의 coordinate를 대신할 임의 URL·Git spec·로컬 경로는 Web에서 받지 않는다.
- Discover의 스킬 설치는 `skills.sh`가 준 `owner/repository/skill` 형식의 GitHub
  카탈로그 coordinate만 받는다. 예를 들면
  `mattpocock/skills/code-review`는 repository가 `mattpocock/skills`,
  선택한 스킬이 `code-review`인 하나의 coordinate다. 미리보기 단계에서
  repository의 현재 default branch를 commit으로 고정한다. 그 snapshot에 공식 skills CLI와
  같은 root·known container·ancestor 우선 탐색을 적용한 뒤, 카탈로그 slug를 정규화한
  스킬 디렉터리명과 먼저 비교한다. 일치하지 않으면 `SKILL.md` frontmatter의 정규화한
  `name`으로 다시 찾으며, 후보가 여러 개면 안전하게 거부한다. 저장소 루트의
  `SKILL.md`는 제한 안의 `scripts/`, `references/`, `assets/`와 일반적인 root metadata를
  함께 물리화한다. 그 밖의 repository content 때문에 완전한 payload를 확정할 수 없으면
  일부 파일만 설치하고 성공으로 기록하지 않고 source unavailable로 중단한다. 중첩 스킬 디렉터리 전체를
  가져올 때 각 파일을 pinned tree의 Git blob ID와 대조하고, 디렉터리 전체를
  스캔한 뒤 dry-run 변경을 보여 주고, 사용자가 별도로 적용할 때만 그 stage된 bytes를
  설치한다. `fleet.lock`에는 GitHub repository·고정 commit·스킬 path를 불변 origin으로
  남긴다. 15분 discovery 디스크 cache에서 읽은 항목은 표시 전용이며 install/update
  권한을 만들지 않는다. Web 대시보드는 변경 버튼을 노출하기 전에 live source를
  새로고침한다. commit 고정과 정적 스캔은 publisher 신원이나 signature를 검증하지
  않으므로 원격 GitHub 소스는 미리보기에서 caution으로 표시된다. 스킬 업데이트는
  자동 적용 작업으로 노출하지 않는다. GitHub 공개 API에 연결할 수 없거나 인증 없는
  요청의 rate limit이 소진되면 소스 확인 불가로 안전하게 중단한다.
- 플러그인은 로컬에 등록된 Claude marketplace 카탈로그에서 논리 `name`과
  `marketplace`를 각각 검증할 수 있고, 사용 가능한 Claude vendor CLI와 권위 있는
  inventory가 있는 한 대를 선택한 경우만 설치를 미리본다. 적용은 공급자 CLI에
  `delegated`된다. Codex plugin inventory는 현재 `unverifiable`이므로 위임 설치·제거를
  노출하지 않는다.
- vendor plugin이 같은 저장소의 스킬을 이미 포함할 수 있다. 예를 들어
  `mattpocock/skills`와 관련된 Claude plugin과 `mattpocock/skills/<skill>` 형식의
  개별 `skills.sh` 항목을 모두 설치하면 스킬 정의가 중복될 수 있으니 plugin 내용과
  Inventory를 먼저 확인한다. `setup-matt-pocock-skills`도 다른 스킬처럼 파일만
  설치하며, Fleet은 설치 과정에서 그 스킬을 자동 실행하지 않는다.

모든 에이전트와 capability에 통하는 범용 원클릭 설치는 없다. Inventory와 Discover의 install/update/sync/remove 버튼은 인증된 `POST /api/plan`으로 **dry-run 계획을 먼저** 만든다. 변경 목록과 고정 warning code를 검토하고 별도 적용 확인을 누른 경우에만 짧은 수명의 single-use plan ID가 `POST /api/apply`로 전달된다. 결과 화면은 대상별 audit/delegated 기록 여부, 일부 적용, 실패, 결과 확인 불가와 안전한 다음 확인 절차를 표시하고 Inventory와 Activity를 새로고침한다. 응답을 확인하지 못한 경우 같은 계획을 다시 실행하지 말고 두 화면에서 실제 상태를 먼저 확인한다.

### Activity에서 특정 변경 롤백

1. **Activity**를 연다. 상단의 Activity 버튼도 이 뷰로 이동만 하며 최근 변경을 자동 롤백하지 않는다.
2. `core-audit` 출처이고 rollback eligible로 표시된 기록을 선택한다. 요청은 선택한 audit ID만 대상으로 한다.
3. capability 종류, 대상, scope, 기록 시각, audit ID를 확인 화면에서 다시 확인한 뒤 두 번째 명시적 확인을 누른다.

`delegated-plugin` 기록은 이 화면에서 롤백할 수 없다. 공급자 CLI를 통해 처리된 작업이므로 해당 공급자의 제거/복구 절차를 사용해야 한다. 이미 롤백했거나 실패한 기록도 선택할 수 없다. Fleet 기록 뒤 대상 파일이 달라졌다면 divergence 보호가 작동해 롤백 결과가 `skipped`가 되고 현재 파일을 덮어쓰지 않는다. 롤백 응답을 검증하지 못하면 완료·실패를 추측하지 않고 결과 확인 불가로 표시하며 Inventory와 Activity를 새로고침한다. 두 화면에서 실제 상태를 확인하기 전에는 같은 audit ID를 다시 실행하지 않는다.

### 테마와 언어

- 저장된 테마가 없으면 브라우저가 보고한 OS의 light/dark 선호로 시작한다.
- 화면의 테마 버튼으로 명시적으로 바꾸면 선택값이 로컬 저장소에 유지된다.
- 언어는 English(`en`)와 한국어(`ko`)를 선택할 수 있고, 명시한 선택이 로컬 저장소에 유지된다. 저장값이 없으면 영어로 시작한다.

### 로컬/Tailscale 보안 모델

대시보드는 기본적으로 loopback에만 바인딩되고 실행마다 생성된 bearer token이 있어야 API를 호출할 수 있다. 시작 URL의 `?token=`은 첫 로드 때 브라우저 session storage로 옮긴 뒤 주소 표시줄과 브라우저 기록에서 제거된다. 이후 요청은 bearer 인증 헤더를 사용한다. 모든 요청은 정확한 Host allowlist/anti-DNS-rebinding 검사를 통과해야 한다. plan, apply, rollback을 포함한 JSON POST는 일치하는 Origin, `application/json`, Authorization 헤더의 bearer token도 요구하며 query token으로는 POST를 인증할 수 없다.

브라우저 UI는 dry-run 계획을 별도로 확인한 뒤 mutation-capable `POST /api/apply`를 사용한다. 따라서 bearer token과 token이 포함된 시작 URL을 가진 사용자는 변경 권한을 가진다. 둘 다 비밀번호처럼 비공개로 취급한다. 대시보드 HTML에는 외부 스크립트·연결을 막는 CSP가 적용되며, HTML과 JSON 응답에는 모두 `no-store` 정책이 적용된다.

다른 Tailscale 기기에서 접근하려면 loopback 바인딩을 유지한 채 Tailscale Serve를 앞에 둔다.

```bash
fleet serve --allow-host <machine>.<tailnet>.ts.net
tailscale serve --bg 7777
```

`0.0.0.0`에 바인딩하거나 Tailscale Funnel을 사용하지 않는다. 이 대시보드는 public internet에 노출하는 서비스가 아니다. 원격 접근은 신뢰할 수 있는, 가능하면 단일 사용자 tailnet으로 제한한다.

---

## 11. 트러블슈팅 / 참고

- 변경했는데 인벤토리가 안 바뀌면: dist가 오래됐을 수 있음 → `npm run build`.
- `--to all`은 요청한 capability writer를 지원하면서 알려진 설정 경로에서 감지된 adapter만 대상으로 한다. 아직 설정이 없는 adapter를 명시적인 ID로 지정하면 writer가 새 설정 생성 계획을 만들 수 있다.
- 실제 적용 전에는 항상 dry-run으로 계획을 먼저 확인하는 습관을 권장.

## 12. 현재 범위 / 한계

- 기본 adapter는 **Claude Code · Codex**다. 둘 다 user-scope MCP·skill·Fleet-rule 변경을 지원한다. Project/local MCP는 scope를 보존해 inventory하지만 현재는 read-only다. Permission과 subagent는 inventory-only이다. Claude plugin 변경은 검증된 inventory를 전제로 vendor CLI에 위임되며, Codex plugin은 현재 inventory가 `unverifiable`이므로 변경 작업이 없다. GeminiAdapter source와 테스트는 남아 있지만 기본 registry에는 로드되지 않는다. 외부 adapter는 `adapterModules`로 추가할 수 있다.
- Discover와 `whats-new`는 공개 레지스트리 피드를 사용한다. 결과는 출처·trust·이유 메타데이터이며 capability의 품질이나 적합성을 보증하지 않는다.
- 충돌 분석은 휴리스틱 후보 탐지다. 충돌이 없다고 보증하지 않으므로 원문을 직접 확인한다.
