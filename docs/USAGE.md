# fleet 사용법

내 모든 AI 에이전트(현재 **Claude Code · Codex**)의 capability를 한 곳에서 보고·설치·동기화하는 도구. **MCP 서버 · 스킬 · 룰(행동지침)** 을 다룬다.
쓰는 방법은 셋이다. **① 터미널(CLI)** 로 직접 실행하거나, **② AI에게 시켜서(MCP)** 대화 중에 실행하거나, **③ 로컬 웹 대시보드**에서 상태와 작업 미리보기를 확인할 수 있다.

> 핵심 안전 규칙: **모든 쓰기는 기본이 dry-run(미리보기).** 실제로 적용하려면 `--commit`(CLI) / `commit: true`(MCP)가 있어야 한다. 웹 대시보드의 capability 작업은 현재 미리보기까지만 진행한다. Activity의 대상 지정 롤백만 별도 확인 후 실행된다.

---

## 0. 준비 (한 번만)

```bash
cd /home/baek/workspace/projects/fleet
npm install
npm run build          # dist/ 생성

# 권장: 전역 명령으로 등록 → 어디서나 `fleet` / `fleet-mcp` 사용
npm link
fleet help
```

전역 등록이 싫으면 그냥 풀경로로 실행해도 된다:

```bash
node /home/baek/workspace/projects/fleet/dist/cli/index.js help
# (개발 모드, 빌드 없이) npm run dev -- help
```

아래 예시는 `npm link` 했다고 보고 `fleet ...`로 쓴다.

**에이전트 ID**: `claude-code`, `codex`. `--to`/`--from`에는 ID를 콤마로 나열하거나 `all`(현재 감지된 에이전트 전부).

---

## 1. 인벤토리 — 뭐가 깔려있나 한눈에

```bash
fleet inventory          # capability × agent 매트릭스 (MCP / Skills / Rules)
fleet inventory --json   # 기계가 읽을 JSON
```

표 기호: `✓`=설치됨, `✗`=비활성, `–`=없음, `U/P/L`=user/project/local 스코프.

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

디렉토리는 통째로 안전 복사된다(심볼릭링크·빈 폴더·실행권한 보존, 원자적 교체, 롤백 가능).

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

## 5. 충돌 점검

```bash
fleet conflicts
```

같은 에이전트에 **상시 적용되는 룰끼리 지향이 반대**인 경우(예: "간단히" vs "자세히")를 후보로 알려준다.
⚠️ 휴리스틱(저신뢰) — fleet이 관리하는 룰 블록만 보며, 못 찾았다고 충돌이 없다는 보장은 아니다. 직접 확인할 것.

---

## 6. 되돌리기

```bash
fleet rollback            # 마지막 적용 변경을 되돌림
fleet rollback <auditId>  # 특정 변경 (감사 ID는 ~/.fleet/audit.jsonl)
```

적용 기록·백업은 `~/.fleet/`(audit.jsonl, backups/)에 남는다. 이건 fleet의 상태 디렉토리. 이 CLI 동작과 달리 웹 대시보드는 Activity에서 선택한 audit ID만 롤백한다.

---

## 7. AI에게 시켜서 쓰기 (fleet-mcp)

fleet 자신을 MCP 서버로 에이전트에 꽂으면, **대화 중에 말로** 시킬 수 있다.

### Claude Code에 연결

```bash
# npm link 했다면:
claude mcp add fleet -- fleet-mcp
# 안 했다면 풀경로:
claude mcp add fleet -- node /home/baek/workspace/projects/fleet/dist/mcp/server.js
```

빼려면: `claude mcp remove fleet`

### Codex에 연결 (`~/.codex/config.toml`)

```toml
[mcp_servers.fleet]
command = "node"
args = ["/home/baek/workspace/projects/fleet/dist/mcp/server.js"]
```

### 연결 후 — 이렇게 말하면 된다

- "fleet inventory 보여줘"
- "playwright를 claude랑 codex에 깔아줘" → (기본 dry-run 계획을 보여줌; "적용해" 하면 commit)
- "claude에 있는 github MCP를 codex에도 맞춰줘"
- "내 룰 중에 서로 충돌하는 거 있는지 봐줘"
- "방금 한 거 되돌려"

노출되는 MCP 도구: `inventory · install · sync · remove · skill_install/sync/remove · rule_install/sync/remove · conflicts · rollback`. 변경 도구는 전부 **`commit: true`** 없이는 dry-run이고, 시크릿(env/headers/토큰)은 AI에게 노출되지 않게 가려진다.

---

## 8. 통합 웹 대시보드

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

- MCP 서버는 권한 있는 어댑터에서 설치·업데이트, 그리고 특정 source agent에서 target agent로의 정확한 동기화·제거 미리보기를 지원한다.
- 스킬과 룰은 어댑터별 writer 지원 여부에 따라 동기화·제거 버튼이 없거나 읽기 전용일 수 있다. Discover의 스킬 업데이트는 자동 적용 작업으로 노출하지 않는다.
- 플러그인은 공급자가 관리한다. 지원되는 설치·제거는 `delegated`로 표시되고 공급자 CLI 동작에 의존한다. 피드에 authoritative marketplace/CLI 정보가 없으면 링크나 안내만 표시한다.

모든 에이전트와 capability에 통하는 범용 원클릭 설치는 없다. Inventory와 Discover의 install/update/sync/remove 버튼은 인증된 `POST /api/plan`으로 **dry-run 계획만** 만들며, 현재 웹 UI에서는 그 계획을 적용하지 않는다. 변경 목록과 경고를 확인한 뒤 실제 적용은 CLI의 `--commit` 또는 MCP의 `commit: true`를 사용한다.

### Activity에서 특정 변경 롤백

1. **Activity**를 연다. 상단의 Activity 버튼도 이 뷰로 이동만 하며 최근 변경을 자동 롤백하지 않는다.
2. `core-audit` 출처이고 rollback eligible로 표시된 기록을 선택한다. 요청은 선택한 audit ID만 대상으로 한다.
3. 대상, scope, 시간, 출처를 다시 확인한 뒤 두 번째 명시적 확인을 누른다.

`delegated-plugin` 기록은 이 화면에서 롤백할 수 없다. 공급자 CLI를 통해 처리된 작업이므로 해당 공급자의 제거/복구 절차를 사용해야 한다. 이미 롤백했거나 실패한 기록도 선택할 수 없다. Fleet 기록 뒤 대상 파일이 달라졌다면 divergence 보호가 작동해 롤백 결과가 `skipped`가 되고 현재 파일을 덮어쓰지 않는다.

### 테마와 언어

- 저장된 테마가 없으면 브라우저가 보고한 OS의 light/dark 선호로 시작한다.
- 화면의 테마 버튼으로 명시적으로 바꾸면 선택값이 로컬 저장소에 유지된다.
- 언어는 English(`en`)와 한국어(`ko`)를 선택할 수 있고, 명시한 선택이 로컬 저장소에 유지된다. 저장값이 없으면 영어로 시작한다.

### 로컬/Tailscale 보안 모델

대시보드는 기본적으로 loopback에만 바인딩되고 실행마다 생성된 bearer token이 있어야 API를 호출할 수 있다. 시작 URL의 `?token=`은 첫 로드 때 브라우저 session storage로 옮긴 뒤 주소 표시줄과 브라우저 기록에서 제거된다. 이후 요청은 bearer 인증 헤더를 사용한다. 모든 요청은 정확한 Host allowlist/anti-DNS-rebinding 검사를 통과해야 한다. plan, apply, rollback을 포함한 JSON POST는 일치하는 Origin, `application/json`, Authorization 헤더의 bearer token도 요구하며 query token으로는 POST를 인증할 수 없다.

브라우저 UI는 capability 계획을 적용하지 않지만 daemon 자체에는 인증된 클라이언트가 사용하는 mutation-capable `POST /api/apply`가 있다. 따라서 bearer token과 token이 포함된 시작 URL을 가진 사용자는 변경 권한을 가진다. 둘 다 비밀번호처럼 비공개로 취급한다. 대시보드 HTML에는 외부 스크립트·연결을 막는 CSP가 적용되며, HTML과 JSON 응답에는 모두 `no-store` 정책이 적용된다.

다른 Tailscale 기기에서 접근하려면 loopback 바인딩을 유지한 채 Tailscale Serve를 앞에 둔다.

```bash
fleet serve --allow-host <machine>.<tailnet>.ts.net
tailscale serve --bg 7777
```

`0.0.0.0`에 바인딩하거나 Tailscale Funnel을 사용하지 않는다. 이 대시보드는 public internet에 노출하는 서비스가 아니다. 원격 접근은 신뢰할 수 있는, 가능하면 단일 사용자 tailnet으로 제한한다.

---

## 9. 트러블슈팅 / 참고

- 변경했는데 인벤토리가 안 바뀌면: dist가 오래됐을 수 있음 → `npm run build`.
- `--to all`은 **감지된** 에이전트만 대상(설정 파일이 있는 것). 없는 에이전트에 명시 설치하면 그 설정 파일을 새로 만든다(dry-run 경고로 알려줌).
- 실제 적용 전에는 항상 dry-run으로 계획을 먼저 확인하는 습관을 권장.

## 10. 현재 범위 / 한계

- 대상 에이전트: **Claude Code · Codex** (Gemini은 제외 — 개인용이 Antigravity로 이전됨. Antigravity/Hermes 어댑터는 추후).
- Discover와 `whats-new`는 공개 레지스트리 피드를 사용한다. 결과는 출처·trust·이유 메타데이터이며 capability의 품질이나 적합성을 보증하지 않는다.
- 충돌 분석은 휴리스틱 후보 탐지다. 충돌이 없다고 보증하지 않으므로 원문을 직접 확인한다.
