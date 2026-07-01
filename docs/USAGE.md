# fleet 사용법

내 모든 AI 에이전트(현재 **Claude Code · Codex**)의 capability를 한 곳에서 보고·설치·동기화하는 도구. **MCP 서버 · 스킬 · 룰(행동지침)** 을 다룬다.
쓰는 방법은 둘 — **① 터미널(CLI)** 로 직접, **② AI에게 시켜서(MCP)** 대화 중에.

> 핵심 안전 규칙: **모든 쓰기는 기본이 dry-run(미리보기).** 실제로 적용하려면 `--commit`(CLI) / `commit: true`(MCP)가 있어야 한다. 적용된 변경은 백업되고 `fleet rollback`으로 되돌릴 수 있다.

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
적용 기록·백업은 `~/.fleet/`(audit.jsonl, backups/)에 남는다. 이건 fleet의 상태 디렉토리.

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

## 8. 트러블슈팅 / 참고

- 변경했는데 인벤토리가 안 바뀌면: dist가 오래됐을 수 있음 → `npm run build`.
- `--to all`은 **감지된** 에이전트만 대상(설정 파일이 있는 것). 없는 에이전트에 명시 설치하면 그 설정 파일을 새로 만든다(dry-run 경고로 알려줌).
- 실제 적용 전에는 항상 dry-run으로 계획을 먼저 확인하는 습관을 권장.

## 9. 현재 범위 / 한계

- 대상 에이전트: **Claude Code · Codex** (Gemini은 제외 — 개인용이 Antigravity로 이전됨. Antigravity/Hermes 어댑터는 추후).
- **신기술 발견 피드 / 중앙 hub는 아직 미구현** (피드 코어/경계만 완료). `whats-new`는 곧.
- 충돌 분석은 휴리스틱(향후 중앙 hub의 LLM 판정으로 대체 예정).
