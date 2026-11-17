# AGENTS.md

이 파일은 Relay 저장소의 작업 기준 문서다. 새 코딩 세션은 먼저 이 파일을 읽고, 문서와 현재 Git 변경을 확인한 뒤 작업한다.

**현재 상태: 사용자 결정으로 개발 일시 중단 (2026-09-15). 2026-09-23 편의성 비교 후 중단 유지, 재개 판단 보류.** 중단 이유와 재개 조건은 `docs/HANDOFF.md` 첫 부분과 `docs/PRD.md`의 제품 판단 기록 두 건을 따른다. 명시적인 재개 요청 전에는 아래 우선 작업을 자동으로 시작하지 않는다.

## 세션 시작 순서

1. `AGENTS.md`를 읽는다.
2. `docs/WORKFLOW_RULES.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/TECHNICAL_VALIDATION.md`, `docs/HANDOFF.md`를 읽는다.
3. `git status --short`와 `git diff`를 확인한다. 커밋되지 않은 변경과 새 파일을 보존한다.
4. `npm test`로 현재 기준선을 확인한다.
5. 개발 재개가 명시적으로 요청된 경우에만 `docs/HANDOFF.md`의 재개 절차를 먼저 확인하고, 그 뒤 첫 미완료 작업부터 작은 단위로 진행한다.

이 저장소 밖의 프로젝트 문서는 작업 전제 조건이 아니다. 제품 의도, 구현 상태, 검증 결과와 다음 작업은 이 저장소 안에 유지한다.

## 제품 방향

Relay의 목적은 사용자가 열어 둔 Claude Code와 Codex 대화형 세션 사이에 짧은 요청을 전달하고 답을 원래 세션으로 돌려주는 것이다.

다음 원칙을 우선한다.

- 기존 CLI 대화를 유지한다.
- 사용자 입력, workspace trust, 권한 확인은 각 CLI의 원래 화면에 남긴다.
- 요청 저장, 전송 시도, 상대 에이전트의 명시적 수신, 답변, 최종 회수를 서로 다른 상태로 기록한다.
- 모델이 자신의 Relay 세션 ID를 입력하게 하지 않는다. MCP adapter 실행 설정이 identity를 고정한다.
- 가능한 기능만 작은 로컬 프로세스와 CLI로 구현한다.

## 범위

현재 범위는 CLI 기반 P0 기술 검증과 신뢰성 보강이다.

포함한다.

- 로컬 session registry와 exchange 저장소
- 세션별 identity가 고정된 MCP 도구 6개
- Claude Code 개발 Channel을 통한 알림
- 알려진 thread를 대상으로 한 `codex queue`
- 실제 수신과 답변 회수를 증명하는 상태 전이
- 얇은 CLI launcher와 후속 진단 도구 작업

현재 포함하지 않는다.

- GUI, Explorer, 터미널 emulator 또는 PTY 제어
- 캐릭터, 페르소나, 컴패니언 기능
- 터미널 출력이나 비공식 transcript 파싱
- 사용자 키 입력 주입과 권한 자동 승인
- 일반 목적 workflow engine, 다중 사용자 서버, 원격 네트워크 서비스

범위를 넓히기 전에 `docs/PRD.md`에 필요성과 완료 기준을 먼저 기록한다.

## 절대 지켜야 할 의미

- `queued`는 저장 완료일 뿐이다.
- `delivery_attempted`는 transport가 성공을 반환했다는 뜻이다. 상대 모델이 읽었거나 일을 시작했다는 뜻이 아니다.
- 상대 세션의 `relay_receive` 호출만 `accepted`를 만든다.
- 상대 세션의 `relay_reply` 호출만 `replied`를 만든다.
- 원래 세션의 `relay_collect` 호출만 `delivered`를 만든다.
- MCP client 단위 테스트 통과를 실제 Claude/Codex 자동 인계 성공으로 보고하지 않는다.

## 안전과 변경 규칙

- 터미널에 무조건 키 입력을 보내지 않는다.
- provider의 권한, trust, preview 기능 확인을 우회하거나 자동 승인하지 않는다.
- CLI 실행은 shell 없이 인자 배열로 전달한다.
- HTTP 서버의 기본 bind는 loopback으로 유지한다.
- 다른 cwd로 요청을 보낼 때는 명시적인 `allowCrossWorkspace=true`가 필요하다.
- delivery 자동 실패 재시도는 현재 방향당 최대 2회다. 무한 재시도를 만들지 않는다.
- 테스트는 `.relay/<name>` 또는 임시 폴더와 독립 포트를 사용한다.
- `~/.myade-relay`와 `.relay/`의 검증 데이터를 사용자 확인 없이 삭제하지 않는다.
- 새 패키지를 설치하기 전에 사용자에게 알린다.
- 요청받지 않은 저장소 밖 파일을 수정하지 않는다.
- 데이터 형식 변경, 파일 삭제, 강제 Git 작업처럼 되돌리기 어려운 작업은 실행 전에 확인받는다.

같은 오류가 두 번 연속 발생하면 같은 방식으로 세 번째 실행을 하지 않는다. 시도한 내용, 로그에 근거한 원인 추정, 장단점이 있는 대안 둘 이상을 보고한다. 원인을 모른 채 큰 폭으로 코드를 바꾸지 않는다.

## 현재 구현

- `src/server.ts`: loopback HTTP API와 delivery coordinator를 시작한다.
- `src/sessions.ts`: provider session, cwd, delivery 방식과 실행 경로를 JSON에 보존한다.
- `src/exchanges.ts`: ownership 검사, exchange 상태 전이와 명시적 retry 요청을 담당한다.
- `src/tools.ts`: bound MCP 도구 6개를 등록한다.
- `src/adapter.ts`: stdio MCP adapter와 Claude Channel 알림 polling을 담당한다.
- `src/delivery.ts`, `src/codex-queue.ts`: Codex queue 전달과 제한된 재시도를 담당한다.
- `src/launch.ts`: provider CLI를 원래 interactive stdio로 실행하고 adapter를 연결한다.
- `src/cli.ts`: `serve`, `launch`, `register`, `sessions`, `requests`, `retry`, `doctor`, `adapter` 진입점이다.
- `src/doctor.ts`: Relay, provider CLI 기능, 경로와 session 등록 상태를 읽기 전용으로 점검한다.
- `scripts/session-start.cjs`: 사전 등록 세션에 provider session/thread ID를 연결하기 위한 선택적 hook이다.

기본 서버는 `127.0.0.1:4318`, 기본 데이터 디렉터리는 `~/.myade-relay`다. 검증 시에는 실사용 데이터와 분리한다.

## 검증된 기준선

2026-09-15 기준:

- Claude Code 2.1.218과 Codex CLI 0.154.0을 사용했다.
- 알려진 Codex thread를 재개한 실제 interactive 세션에서 Claude → Codex → Claude 왕복을 완료했다.
- 새 Codex thread를 공식 `thread/started`로 자동 등록한 실제 interactive 세션에서도 왕복을 완료했다.
- 최종 exchange 상태 `delivered`와 각 명시적 도구 호출을 확인했다.
- 명시적 retry는 자동 테스트와 실제 Codex queue 중단·복구 실험으로 검증했다. 복구 후 CLI retry가 `explicit: sent`를 기록하고 대상 Codex의 `relay_receive`로 `accepted`까지 진행했다.
- 실제 환경에서 `doctor`의 모든 최소 검사가 통과했다.
- `npm test`는 build와 Node 테스트 16개를 통과했다.

정확한 증거와 제한은 `docs/TECHNICAL_VALIDATION.md`에만 갱신한다. 실제 실행 없이 검증 완료라고 쓰지 않는다.

## 우선 작업

아래는 개발 재개가 결정된 뒤의 기술 백로그이며, 일시 중단 중 자동 실행 대상이 아니다.

1. 동시 세션과 요청 경합을 검증한다.
2. 성공한 transport와 attempt 기록 사이의 갑작스러운 프로세스 종료를 검증한다.
3. 실제 Claude Channel 중단 후 명시적 retry를 검증한다.

세부 작업 순서와 완료 조건은 `docs/HANDOFF.md`를 따른다.

## 완료 보고

마지막 보고는 다음 세 범주를 분리한다.

- 실제로 검증한 것: 실행한 명령과 관찰한 상태 또는 테스트 결과
- 아직 검증하지 못한 것: 추정하지 말고 경계를 명시
- 다음 단계: 가장 작은 후속 작업과 완료 조건

코드 변경은 관련 테스트를 실행한 결과가 있을 때만 완료로 표현한다. 실제 provider 세션 동작은 단위 테스트와 별도로 기록한다.
