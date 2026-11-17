# AGENTS.md

## 2026-09-14 재개 업데이트 (아래 이전 구현 설명보다 우선)

- 새 요구사항/분석: `docs/RESTART_PRD.md`. 기존 실제 PTY와 캐릭터/컴패니언을 보존하고
  코딩·문서·기획 공통 요청 전달을 확장한다.
- `src/exchanges.ts`, `src/exchange-tools.ts`: 명시적 수신 방식의 MCP 도구 6개.
  자동 wake-up/자동 작업 실행은 미구현이다. queued를 작업 시작으로 설명하지 말 것.
- GUI는 셸 시작 전에 pane ID를 등록하고 MYADE_PANE_ID와 포트를 전달한다. SessionStart
  wrapper가 ID를 전송해 같은 cwd의 pane과 Claude 재시작을 연결한다. ID 없는 이전 훅은
  기존 추측 경로를 사용한다. Codex lifecycle은 별도 작업이다.
- `npm test`: 빌드+Node 테스트. 임시 폴더/독립 포트에서 실제 MCP 왕복도 검증한다.
  MYADE_DATA_DIR로 검증 데이터를 실사용 data에서 분리할 수 있다.
- 현재 저장소는 Git으로 초기화되어 있다. 아래 Git 미초기화 설명은 이전 상태다.
- 이전 Rust 캐시가 옛 절대 경로를 참조하면 데이터를 삭제하지 말고 새 --target-dir로 검증한다.

이 파일은 이 리포지토리의 **원본(source of truth)** 프로젝트 문서다. 어떤 코딩 에이전트/CLI로
작업하든 여기 내용을 먼저 참고할 것. Claude Code 전용 세부사항(훅 이름, CLI 플래그, 훅 등록
방식 등)만 `CLAUDE.md`에 보충되어 있으니, Claude Code로 작업 중이라면 그쪽도 함께 확인한다.

## 작업 실패 시 규칙 (Failure Handling)
- 같은 오류가 **2회 연속** 발생하면 같은 방식으로 3번째 시도하지 말 것.
  대신 즉시 멈추고, 다음 3가지를 사용자에게 보고할 것:
  1) 무엇을 시도했는지
  2) 왜 실패했다고 추정하는지 (에러 로그 근거)
  3) 가능한 대안 2가지 이상 (장단점 포함)
- "아마 될 것 같다", "이번엔 다를 것 같다" 같은 근거 없는 재시도 금지.
  이전 시도와 다른 접근인지 스스로 확인 후에만 재시도.
- 원인 파악이 안 된 채로 코드를 대량으로 고치지 말 것.
  먼저 원인을 1~2문장으로 설명하고 승인받은 뒤 수정.

## 판단 범위 제한 (Scope Guardrail)
- 요청받지 않은 파일/모듈은 건드리지 말 것. 수정이 필요해 보이면 먼저 물어볼 것.
- 라이브러리/패키지를 새로 설치하기 전에 반드시 사용자에게 알릴 것.
- 데이터베이스 스키마 변경, 파일 삭제, git force-push 등 되돌리기 어려운 작업은
  반드시 실행 전 확인받을 것.

## 완료 보고 기준 (Evidence-based Completion)
- "됐다", "작동할 것이다"라는 표현 대신, 실제 실행 결과(테스트 통과/빌드 성공 로그)를
  보여준 뒤에만 완료로 간주할 것.
- 스스로 "일단 이 정도면 됐다"고 범위를 축소해서 넘어가지 말 것. 안 되면 안 된다고 말할 것.

## 토큰/시간 절약
- 탐색(파일 읽기)이 예상보다 많이 필요하면, 전체를 다 읽지 말고 관련 디렉토리만 좁혀서 탐색.
- 큰 작업은 한 번에 다 하지 말고, 단계별로 나눠 각 단계마다 결과를 보고 후 다음 단계 진행.


## Project

myade (개인 ADE, Agentic Development Environment) — 여러 터미널에서 각각 코딩 에이전트 CLI를
띄워도, 한 세션이 "다른 세션은 지금 뭐 하고 있어?"를 도구 호출로 물어볼 수 있게 해주는 개인용
프로젝트.

- 배경/원 요청 스펙: [`ADE PROJECT.md`](./ADE%20PROJECT.md)
- 설치/사용법: [`README.md`](./README.md)
- 페르소나 레이어 PRD (완료): [`PERSONA_LAYER_PRD.md`](./PERSONA_LAYER_PRD.md)
- 멀티 pane 터미널 + 컴패니언 PRD (MVP 완료, 2026-08-23): [`MULTI_PANE_ADE_PRD.md`](./MULTI_PANE_ADE_PRD.md)
- 개발 중 시행착오/알려진 함정: [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)


멀티 pane + 컴패니언 라운드에서 옛 `myade-gui`(좌: 터미널 / 우: 작업계획 채팅, 승인 큐 구조)는
완전히 폐기되고 아래 "2단계" 구조가 대체했다.

두 단계로 구성되며 각각 독립된 Node 프로젝트다:

- **1단계 (repo 루트)** — 세션 상태 조회 MCP 서버. 완료.
- **2단계 (`myade-gui/`)** — 멀티 pane 터미널 + 캐릭터 자동배정 + 컴패니언 잡담 팝업 (Tauri v2 +
  React). MVP 완료 (개발 모드로 구현/검증됨, 배포 빌드는 아직 미완).

## Commands

### 1단계 (repo 루트)

```
npm install
npm run build     # tsc -p tsconfig.json -> dist/
npm start          # node dist/server.js (포트 기본 4317, MYADE_PORT로 변경)
npm run dev         # build + start
```

자동화된 테스트는 없다. 수동 검증은 `curl http://127.0.0.1:4317/health`와
`curl http://127.0.0.1:4317/debug/panes`로 서버 상태를 직접 확인하는 방식이다 (README.md의
"검증" 절 참고).

### 2단계 (`myade-gui/`)

```
cd myade-gui
npm install
npm run dev         # vite 개발 서버만 (Tauri 없이 프론트만 확인할 때)
npm run build       # tsc && vite build
npm run tauri dev   # 전체 앱 실행 (Rust 컴파일 포함, 최초 실행은 수 분 소요)
npm run tauri build # 배포 번들 (아직 시도 안 함)
```

Rust 쪽은 `src-tauri/`에 있고 `npm run tauri dev`가 `cargo`를 내부적으로 호출한다. Windows에서는
Rust + "Desktop development with C++" 워크로드(Visual Studio Build Tools) + WebView2가 사전
설치되어 있어야 한다 (`myade-gui/README.md` 참고). 자동화된 테스트는 `cargo test --lib`
(`src-tauri/`에서 실행, 캐릭터 배정/롤스터 로직 유닛테스트)가 전부다 — 프론트엔드/실제 GUI
동작은 사람이 직접 클릭해서 확인해야 한다 (스크린샷/키보드 자동화 도구가 없다).

## Architecture

### 1단계: 상태 조회 MCP 서버

한 프로세스(`src/server.ts`, Express)가 세 종류의 엔드포인트를 동시에 서빙한다:

- `/mcp` — MCP 서버 (`@modelcontextprotocol/sdk`, stateless Streamable HTTP). 요청마다 새
  `McpServer`+`transport` 쌍을 만들지만 전부 같은 `SessionStore` 인스턴스를 공유하므로, 여러
  에이전트 CLI 프로세스가 각자 이 엔드포인트에 연결해도 상태는 하나로 합쳐진다.
- `/hooks/*` — 각 세션(pane)에서 실행 중인 에이전트 CLI가 세션 시작/종료/알림 시점에 직접 POST
  하는 수신처. 별도 훅 스크립트나 화면 파싱 없이 CLI 자체의 라이프사이클 훅 기능만 사용한다.
  (Claude Code 기준 정확한 훅 이벤트 이름과 등록 방식은 `CLAUDE.md` 참고 — 다른 CLI를 붙일
  때는 그 CLI의 훅/이벤트 문서를 대입하면 된다.)
- `/sessions/*` — `scripts/myade.bat`/`myade.sh` → `scripts/register.js`가 세션 시작/종료를
  등록하는 곳.

핵심 상태 로직은 `src/state.ts`의 `SessionStore` 하나에 몰려 있고, MCP/HTTP를 전혀 모른다
(파일 상단 주석에 "2단계가 그대로 재사용" 의도가 명시돼 있음). 세션(pane) 식별의 까다로운
부분은 `resolvePaneForHook`: launcher가 등록한 pane과 나중에 오는 훅 이벤트를 연결할 공유 ID가
없으므로 세션 ID 일치 → 같은 cwd의 최근 "starting" pane → 없으면 즉석 생성, 순서로
상관관계를 추론한다. 상태는 `data/state.json`에 매 변경마다 동기 저장되어 서버 재시작에도
살아남는다.

pane을 죽은 것으로 마킹하는 경로는 `markEnded()` 하나로 모여 있고(런처 종료, `SessionEnd` 훅,
GC가 전부 같은 모양의 레코드를 남긴다), 그 위에 시간 기준 GC(`sweep()`)가 있다 —
`updatedAt`이 `MYADE_STALE_PANE_HOURS`(기본 6시간)보다 오래된 살아있는 pane은 `gc:stale`로
종료 처리하고, 종료된 지 `MYADE_PANE_RETENTION_DAYS`(기본 7일)가 지난 레코드는 삭제한다.
서버 기동 직후 1회 + `list()`마다 lazy하게 돈다. **이 GC는 있으면 좋은 게 아니라 필수다** —
비정상 종료(`tauri dev` 파일 감시 재시작, 크래시, cmd 창 X 버튼, taskkill)는 어떤 훅도 안
보내고, pid 기반 생존 확인은 쓸 수 없다(누적된 레코드 대부분이 `pid: null`이다). 이 두 가지가
없던 시절 `pane_list`가 유령 109개를 반환해 1단계 핵심 기능이 사실상 마비된 적이 있다
(`TROUBLESHOOTING.md` 10·12번).

`src/tools.ts`는 `pane_ping`/`pane_list`/`pane_status` 세 MCP 도구를 등록하며 `SessionStore`만
참조 — 새 도구 추가 시 이 파일만 건드리면 된다.

### 페르소나 레이어 (`src/persona.ts`)

리포와 무관한 전역 파일 `~/.myade/persona-<characterId>.md`(캐릭터별로 하나씩,
`persona.ts::personaPath`)에 세션 간 말투/커뮤니케이션 선호를 누적한다. 세션 시작 시점에 그
내용을 새 세션의 컨텍스트로 주입하고, 세션 종료 시점에는(턴마다가 아니라 세션당 정확히 1회
발동하지만 컨텍스트 주입/차단은 불가한 fire-and-forget 방식으로) 백그라운드에서 그 세션 자신을
이어서 실행해 "말투 선호가 새로 드러났으면 한 줄, 아니면 SKIP"을 묻고 결과를 append한다.
대화 기록 원본은 버전마다 바뀌는 비공식 포맷이라 직접 파싱하지 않고, CLI가 제공하는 "세션
이어서 실행" 기능으로 우회한다. 세션 시작 핸들러가 `myadeCharacterId`를
`persona.ts::recordSessionCharacter(session_id, characterId)`로 기록해두고, 세션 종료 이벤트
페이로드 자체엔 캐릭터 정보가 없으므로(아래 참고) 그 세션이 끝날 때
`takeSessionCharacter(session_id)`로 꺼내 어느 파일에 append할지 정한다.

(정확한 훅 이벤트 이름, CLI 플래그, 재귀 방지 로직 등 구현 디테일은 `CLAUDE.md` 참고.)

이제 myade는 myade-gui 안에서만 쓴다는 전제라 **모든 세션이 캐릭터를 갖는다** — 그래서
캐릭터별 파일만 있고, 캐릭터 없는 세션을 위한 공용 `persona.md`는 없다(`personaPath()`는
`characterId`가 없거나 비정상이면 그 자리에서 throw하고, `readPersona`/`appendPersonaLine`이
그걸 잡아 `console.error`로 로그만 남기고 조용히 아무것도 안 한다 — 파일이 없으면 정상, 이
에러는 "characterId가 애초에 안 왔다"는 배선 이상 신호이므로 조용히 삼키면 안 됨). 원래는
파일이 하나뿐이었는데, 세션 종료 요약 프롬프트가 "말투/톤 선호"만 물어봐서 캐릭터 테스트 중
그 세션 한정 롤플레이 지시("너는 이제 (롤스터의 다른 캐릭터)야")를 전역 선호로 오판해
기록해버렸고, 그 오염된 한 줄이 세션 시작 시점 컨텍스트 주입을 통해 **다른 모든 캐릭터**에게
까지 새어 들어가 컴패니언에서 캐릭터 A를 골랐는데 (이전에 기록된) 캐릭터 B로 응답하는 실제
버그로 이어졌다 (실사용 중 발견) — 캐릭터별 파일 분리로 그 누수를 구조적으로 막았고, 이후
공용 파일 자체를 완전히 없앴다(더 이상 그걸 상정할 이유가 없는 사용 방식으로 확정됐으므로).

**이 문서(및 `CLAUDE.md` 등 자동으로 프로젝트 컨텍스트에 로드되는 파일들)는 그 자체가 모든
pane/세션의 컨텍스트로 자동 주입된다는 걸 잊기 쉽다** — 실제로 롤스터 캐릭터의 실명을 "예전에
잘못 새어 들어간 identity"로 여기 못박아뒀더니, 정확히 그 이름으로 배정된 pane이 "내 정체성이
이 문서에 버그 사례로 적혀 있으니 실제로 이 캐릭터로 응답할 근거는 없어 보인다"고
자기참조적으로 판단해 그냥 평범한 어시스턴트로 답해버리는 새로운 문제가 실사용 중 재현됐다
(위 문단이 원래 롤스터 실명을 그대로 썼다가 겪은 사고). 그래서 롤스터 실명은 이런 자동 로드
문서에서 일부러 안 쓴다 — 캐릭터/버그 사례를 구체적으로 설명해야 할 때도 "캐릭터 A/B"처럼
익명화할 것.

### 2단계: 멀티 pane 터미널 + 캐릭터 + 컴패니언 (`myade-gui/`)

옛 구조(왼쪽 실제 터미널 / 오른쪽 채팅이 승인 카드를 거쳐 그 터미널을 원격 조종)는 완전히
폐기됐다 — `bridge.rs`/`poller.rs`/`claude.rs`와 `myade-gui/bridge/` Node 서브프로젝트를 전부
삭제했다. 지금은 [`MULTI_PANE_ADE_PRD.md`](./MULTI_PANE_ADE_PRD.md)의 3단계 구조다:

1. **멀티 pane 터미널** — `state.rs`의 `AppState`가 pane 레지스트리(`HashMap<paneId, PaneEntry>`)를
   들고 있고, `commands.rs`의 `init_app`/`create_pane`/`close_pane`/`list_panes`가 이를 조작한다.
   각 pane은 `pty.rs::spawn_shell`이 띄운 독립 PTY(portable-pty)이고, 에이전트 CLI는 사용자가 그
   셸 안에서 직접 실행하는 평범한 인터랙티브 프로세스다 — Rust는 그 대화 내용을 전혀 들여다보지
   않는다 (옛 구조의 "명령을 대신 주입하고 출력을 가로채는" `run_captured` 방식과 근본적으로
   다르다). `init_app`은 항상 pane 0개로 시작한다 — 이전엔 `workspace.rs`가 pane들의 cwd 목록을
   로컬에 저장해 재시작 시 자동 복원했지만, 그 기능은 제거됐다. pane이 0개면(최초 실행이든
   마지막 pane을 닫은 뒤든 동일하게) 프론트가 grid 대신 웰컴 화면(`WelcomeScreen.tsx`, "+ 새
   pane" 버튼 하나)을 보여주고, 사용자가 직접 폴더를 골라 `create_pane`을 호출해야 pane이 열린다.
2. **캐릭터 자동배정 + 실제 정체성 주입** — 롤스터는 `~/.myade/characters/*.md`(리포 바깥,
   `characters.rs`가 비어있으면 기본 4명 placeholder를 생성)에 있다. 배정은 `commands::spawn_pane`이
   **pane 생성 시점에 즉시** 하고(예전엔 `pty.rs`의 리더 스레드가 PTY 출력에서 CLI 배너를 찾을
   때까지 기다렸다가 사후에 배정했는데, 그러면 그 pane에서 처음 실행되는 에이전트 CLI는 이미
   세션 시작 이벤트가 끝난 뒤라 정체성을 주입할 방법이 없어서 배지는 항상 UI에만 있고 실제 CLI는
   자기가 무슨 캐릭터인지 전혀 몰랐다 — 실사용 중 배지와 실제 응답 정체성이 어긋나는 버그로
   발견됨), 그 character_id를 `pty::spawn_shell`이 그 pane 셸 프로세스의 `MYADE_CHARACTER_ID`
   환경변수로 심는다. 이 env var는 셸 → 에이전트 CLI → CLI가 띄우는 훅 서브프로세스까지 그대로
   상속되므로, 훅 스크립트가 자기 `process.env.MYADE_CHARACTER_ID`를 읽어 훅 요청에 얹어 보내고,
   `server.ts`의 세션 시작 핸들러가 그 id로 `characters.ts::readCharacter`(Rust
   `characters::character_content`의 Node판, 같은 `~/.myade/characters/`를 읽기 전용으로 공유)를
   읽어 주입 컨텍스트에 "이 캐릭터의 톤 선호보다 우선"이라고 명시한 뒤 넣는다 (톤 선호 자체가
   캐릭터별로 어떻게 분리되는지, 왜 분리가 필요했는지는 위 페르소나 레이어 문단 참고 — 이 우선순위
   문구는 그 분리 위에 얹힌 defense-in-depth일 뿐 주된 수정이 아니다). `companion.rs`도 헤드리스
   프로세스 spawn 시 같은 env var를 심어 동일 경로를 함께 탄다 (아래 3번 항목의 첫턴 blurb 주입과
   belt-and-suspenders 관계). pane 개수는 롤스터 크기로 제한된다 (`commands::max_pane_count`,
   롤스터 파일이 늘어나면 자동으로 같이 늘어남) — pane 생성 자체가 캐릭터 슬롯을 하나 즉시
   소비하므로 이 cap과 배정 시점이 정확히 맞아떨어진다.
3. **컴패니언 잡담 팝업** — `commands::open_companion_window`가 별도 Tauri 창(label `"companion"`)을
   연다. 어느 화면(App vs CompanionApp)을 그릴지는 URL이 아니라 **`getCurrentWindow().label`**로
   판단한다(`main.tsx`) — URL 해시(`#companion`)로 먼저 시도했다가 dev 서버 URL 리졸빙 과정에서 그
   프래그먼트가 안 실려서 완전히 빈 창이 뜨는 문제를 겪었다. 창 생성 자체도 원래 sync 커맨드에서
   `.build()`를 직접 불렀다가 메인 스레드가 자기 자신을 기다리며 데드락났던 걸 `async fn` +
   `run_on_main_thread` + `oneshot` 채널로 고쳤다 (`TROUBLESHOOTING.md` 8·9번 항목이 이 둘).
   `companion.rs`가 헤드리스 에이전트 프로세스를 캐릭터당 독립 세션으로 돌리는데, cwd를 실제
   프로젝트가 아니라 `~/.myade/companion`으로 고정해서 진짜 작업 세션과 절대 안 섞이게 하고, 모든
   도구(Bash/Read/Write/...)를 비활성화한다. 캐릭터 성격(롤스터 파일 내용)은 그 캐릭터의 첫 턴에만
   프롬프트 앞에 붙이고, 그 캐릭터의 `persona-<characterId>.md` 말투 선호는 이 헤드리스 프로세스에도
   세션 시작 이벤트가 똑같이 발동하기 때문에 별도 배선 없이 자동으로 실린다. **프롬프트는 절대
   CLI 인자로 넘기지 않고 stdin으로 쓴다** — Windows 배치파일 인자 전달 문제 때문(정확한
   메커니즘·근거는 `CLAUDE.md`의 "Windows: 프롬프트는 stdin으로만" 절과 `TROUBLESHOOTING.md`
   8번 항목 참고). `persona.ts`가 이미 이 문제를 stdin 방식으로 풀어놨었는데 `companion.rs`를
   처음 쓸 때 이걸 놓쳤다가 실사용 중 재현됐다.

세 부분 다 1단계 `myade` 데몬(포트 4317)에 그대로 의존한다: 각 pane은 열릴 때
`pane::register_start`로 데몬에 등록되고, 에이전트 CLI가 그 안에서 실행되면 (다른 터미널과
똑같이) 세션 시작/종료/알림 훅이 데몬에 직접 꽂힌다. **pane별 캐릭터 배정 자체는 데몬의
`pane_list`를 안 읽는다** — 같은 pane에서 CLI를 재실행하면 위 1단계 설명의 `resolvePaneForHook`이
"starting" 상태가 아닌 pane을 못 찾아 새 ad-hoc pane을 만들어버리는 알려진 상관관계 문제가
있어서, 캐릭터 배정은 Tauri 앱 자신의 `state.rs`만 본다. 개발 모드(`tauri dev`)로 반복
재시작하면 이 데몬 쪽에 `gui:*` 좀비 pane이 쌓이는 별개 문제도 있다 (`TROUBLESHOOTING.md`
10번 항목).

## Safety principles

- **사용자 데이터와 코드는 구분한다.** `~/.myade`, `~/.claude` 등 리포 바깥의 사용자 데이터
  디렉터리는 테스트 정리 목적이라도 사용자에게 먼저 확인받지 않고 삭제(`rm -rf` 등)하지 않는다.
  디버깅 중 직접 만든 테스트 데이터라 해도 예외 없음 — 실제로 페르소나 레이어 디버깅 중 검증용
  으로 append한 persona.md를 "테스트 흔적이니 정리하자"며 `rm -rf ~/.myade`로 곧바로 지운 적이
  있고, 그 폴더가 이후 실사용 로그에 남은 성공 기록과 뒤섞여 사용자가 데이터 유실을 의심하는
  혼란으로 이어졌다. 지워야 할 것 같으면 먼저 뭘 지우려는지 보여주고 확인을 받을 것.
- **자동 로드되는 프로젝트 컨텍스트 문서(이 파일, `CLAUDE.md` 등)에는 롤스터 캐릭터 실명을
  버그 사례로 못박지 않는다.** 위 "페르소나 레이어" 절 마지막 문단 참고 — 자기참조적 판단
  오류로 이어진 적이 있다.
- `data/`(1단계)와 `dist/`(양쪽)는 git에 커밋되지 않는다 (`.gitignore` 참고). 이 repo는 아직
  git으로 초기화되어 있지 않다.
- 서버는 1단계 루트의 것 하나뿐이다 (포트 4317). `myade-gui/bridge/`라는 별도 Node 서버가
  예전엔 있었지만 승인 큐/브릿지 구조와 함께 삭제됐다 — 지금 `myade-gui`는 이 1단계 서버에
  pane을 등록하는 것 말고는 별도 백엔드 프로세스를 안 띄운다.

## Known pitfalls / troubleshooting

전체 목록과 상세 재현/원인/해결 과정은 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 참고. 특히:

- 8·9번 항목 — 컴패니언 창 생성 데드락, Windows 배치파일 인자 전달 문제.
- 10번 항목 — 개발 모드 반복 재시작 시 데몬에 쌓이는 좀비 pane.

Claude Code로 작업할 때 마주치는 훅 배선/CLI 플래그 관련 세부 함정은 `CLAUDE.md`에 보충되어
있다.
