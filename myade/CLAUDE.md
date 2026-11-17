# CLAUDE.md

전체 프로젝트 개요/아키텍처/명령어/안전 원칙은 **[`AGENTS.md`](./AGENTS.md)가 원본(source of
truth)** 이니 그쪽을 먼저 참고할 것. 이 파일에는 Claude Code에서 작업할 때만 필요한 보충
사항(정확한 훅 이벤트 이름, 등록 방식, CLI 플래그, Windows 관련 CLI 특이사항)만 남아 있다.

## 훅 등록: SessionStart만 비대칭

훅 등록은 **`SessionStart`만 `type: "command"`, 나머지(`Stop`/`Notification`/`SessionEnd`)는
전부 `type: "http"`인 비대칭 구조**다 — 새 훅을 추가할 때 이 비대칭을 놓치기 쉬우니 유의할 것.
`SessionStart`는 `type: "http"` 훅을 지원하지 않는다 — Claude Code 클라이언트가 이 이벤트에
한해 조용히 스킵한다(디버그 로그: `Skipping HTTP hook ... HTTP hooks are not supported for
SessionStart`; `Stop`/`Notification`/`SessionEnd`는 HTTP 훅이 정상 동작함을 같은 로그로
확인함). 그래서 `SessionStart`만 `scripts/session-start-hook.js`를 `type: "command"`로 등록해
(`claude-config/settings.snippet.json`) stdin의 훅 JSON을 그대로 `/hooks/session-start`에
POST하고 응답을 stdout으로 릴레이하는 얇은 래퍼를 쓴다 — 실제 로직(페르소나 조회, pane 등록,
`isSummaryInFlight` 재귀 방지)은 여전히 `server.ts`에만 있다. 이 래퍼는 실패해도 항상 exit 0 +
빈 stdout으로 넘어가 세션 시작을 절대 막지 않지만(서버 다운 시 컨텍스트 없이 조용히
진행), PATH에 `node`가 없거나 서버가 안 떠 있는 등의 실패는 흔적 없이 사라지지 않도록 매 실패
경로마다 `[myade:session-start-hook]` 접두사로 stderr에 한 줄을 남긴다 — SessionEnd 요약
서브프로세스가 Windows PATH/인코딩 문제로 조용히 죽었던 것과 같은 종류의 실패가 이번엔 흔적
없이 사라지지 않게 하기 위함.

훅 스니펫은 `claude-config/settings.snippet.json`에 있고, 사용자의
`%USERPROFILE%\.claude\settings.json`에 수동 병합해야 한다 (자동 적용 안 됨).

## 페르소나 레이어: `--resume --fork-session`

세션 시작 시점의 말투 선호 주입은 `SessionStart` 훅 응답의
`hookSpecificOutput.additionalContext`에 실어 보낸다. 세션 종료 시점 요약은 `SessionEnd` 훅이
오면(Stop과 달리 이 훅이 왜 세션당 정확히 1회만 fire-and-forget으로 발동하는지는 `AGENTS.md`
페르소나 레이어 절 참고) 백그라운드로 `claude -p --resume <session_id> --fork-session`을 호출해
그 세션 자신을 이어서 실행한다. `transcript_path`가 가리키는 JSONL은 버전마다 바뀌는 비공식
포맷이라 직접 파싱하지 않고 `--resume`으로 우회한다.

`--resume`은 프로젝트 디렉터리(cwd) 기준으로 세션을 찾으므로 서브프로세스는 반드시 훅이 보낸
`input.cwd`(원래 세션의 실제 프로젝트 디렉터리)에서 실행해야 한다 — 처음엔 이걸 무시하고
cwd를 `~/.myade`로 고정했다가, 엉뚱한 프로젝트 폴더가 생기고 매번 "No conversation found"로
실패하는 실사고를 냈다. `--fork-session`은 그 실패/강제종료 시나리오에서도 원본 세션 파일을
절대 건드리지 않게 해주는 핵심 안전장치다(resume 결과를 새 session_id/파일로 분기하고,
SIGKILL로 죽여도 원본 해시가 그대로임을 직접 검증함) — 이게 없으면 이 서브프로세스가 원본
트랜스크립트에 직접 쓰다가 죽어서 그 프로젝트에서 `claude` 자체가 안 켜지는 손상으로 이어질 수
있다.

cwd가 이제 원래 세션과 같은 실제 프로젝트 디렉터리이므로 더 이상 고정 경로로 "내부 프로세스"를
구분할 수 없다. 대신 `isSummaryInFlight()`가 "지금 이 디렉터리에서 우리 자신의 요약
서브프로세스가 실행 중"인 동안만(ref-counted) true를 반환하고, 모든 훅 핸들러가 그 창 동안
들어오는 이벤트를 무시해 무한 재귀(포크된 세션도 `claude` 프로세스라 자기 훅을 다시 이
서버로 쏨)와 `pane_list` 오염을 막는다.

## 캐릭터 정체성 주입 (2단계, `myade-gui/`)

`MYADE_CHARACTER_ID` 환경변수가 셸 → CLI → 훅 서브프로세스로 상속되는 전체 메커니즘과 왜
이렇게 됐는지는 `AGENTS.md`의 "2단계" 절 참고. Claude Code에서 구체적으로는
`scripts/session-start-hook.js`가 자기 `process.env.MYADE_CHARACTER_ID`를 읽어 훅 JSON에 얹어
`/hooks/session-start`로 보내고, `server.ts`가 그 id로 캐릭터 파일을 읽어 `additionalContext`에
넣는다.

## Windows: 프롬프트는 stdin으로만

`companion.rs`가 띄우는 헤드리스 `claude -p` 및 `persona.ts`의 요약 서브프로세스 모두
**프롬프트를 절대 CLI 인자로 넘기지 않고 stdin으로 쓴다** — 인자로 넘기면 Windows에서
`claude.cmd`(배치파일 셰임) 호출 시 "batch file arguments are invalid"로 깨진다
(`TROUBLESHOOTING.md` 8번 항목).

## 원 스펙 문서

배경/원 요청 스펙은 [`ADE PROJECT.md`](./ADE%20PROJECT.md) 참고.
