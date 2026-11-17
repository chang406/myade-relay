# Relay

> **보관: 2026-09-15 일시 중단(사용자 결정), 2026-09-23 재개 보류.** 코드가 작동하지 않아서 멈춘 것이 아니다([docs/HANDOFF.md](docs/HANDOFF.md)). 아래 문서는 당시 기준이다. 무엇을 했고 왜 멈췄는지는 [RETROSPECTIVE.md](RETROSPECTIVE.md)에 있다.

Relay는 열려 있는 Claude Code와 Codex 대화형 세션 사이에서 짧은 작업을 전달하고 답을 회수하는 로컬 CLI 도구다. 각 에이전트는 평소처럼 자기 터미널에서 실행되며, 사용자 입력과 권한 확인도 해당 터미널이 계속 담당한다.

현재 P0 범위는 실제 세션 간 왕복의 기술 검증과 신뢰성 보강이다. 알려진 Codex thread 재개뿐 아니라 새 Codex 세션의 공식 lifecycle 자동 등록 경로에서도 Claude → Codex 요청, 명시적 수신과 답변, Claude의 답변 회수까지 실제로 검증했다.

## 문서 읽는 순서

새 작업 세션은 다음 순서로 읽으면 된다.

1. [`AGENTS.md`](AGENTS.md) — 작업 원칙, 현재 상태, 필수 규칙
2. [`docs/WORKFLOW_RULES.md`](docs/WORKFLOW_RULES.md) — 마일스톤, 시간, 테스트와 통합 검증 효율 규약
3. [`docs/PRD.md`](docs/PRD.md) — 제품 의도, P0 요구사항과 완료 기준
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 구조, 상태 전이, 신뢰 경계
5. [`docs/TECHNICAL_VALIDATION.md`](docs/TECHNICAL_VALIDATION.md) — 실제 CLI 검증 증거와 미검증 항목
6. [`docs/HANDOFF.md`](docs/HANDOFF.md) — 바로 이어서 할 작업
7. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — 설치, 실행, 테스트, 수동 검증 절차

이 저장소 안의 문서와 코드만으로 개발을 이어갈 수 있다.

## 핵심 의미

- `queued`: Relay에 요청이 저장됨
- `delivery_attempted`: Channel 알림 전송 또는 `codex queue` 명령 성공. 상대 에이전트의 수신은 아직 확인되지 않음
- `accepted`: 상대 에이전트가 `relay_receive`를 호출함
- `replied`: 상대 에이전트가 `relay_reply`를 호출함
- `delivered`: 요청한 에이전트가 `relay_collect`를 호출함
- `cancelled`: 요청한 에이전트가 요청을 취소함

Relay는 터미널에 키를 주입하지 않으며 권한 확인을 자동 승인하지 않는다.

## 빠른 시작

요구 사항은 Node.js 20 이상과 사용할 Claude Code/Codex CLI다.

```powershell
npm install
npm test
npm start -- --data-dir .relay/dev
```

기본 주소는 `http://127.0.0.1:4318`이고, 기본 데이터 경로는 `~/.myade-relay`다. 개발과 검증에는 항상 별도 `--data-dir`을 사용한다.

다른 터미널에서 이미 알고 있는 Codex thread와 Claude 세션을 실행한다.

```powershell
node dist/src/cli.js launch --provider codex --id codex-main --thread CODEX_THREAD_ID --binary C:\path\to\codex.exe --cwd C:\work\project
node dist/src/cli.js launch --provider claude --id claude-main --binary C:\path\to\claude.exe --cwd C:\work\project
```

등록 상태와 요청 상태는 다음 명령으로 확인한다.

```powershell
node dist/src/cli.js sessions
node dist/src/cli.js requests --session claude-main
node dist/src/cli.js retry --session claude-main --request REQUEST_ID --direction request
node dist/src/cli.js doctor --claude C:\path\to\claude.exe --codex C:\path\to\codex.exe --session next-session
```

`retry`는 request 방향에서는 source session, answer 방향에서는 target session만 요청할 수 있다. 기존 attempt는 보존되고 다음 실제 전송에는 `trigger: explicit`가 기록된다.

`doctor`는 Relay 연결, CLI 버전과 필요한 기능, 쓰기 가능한 경로, session ID 중복과 Codex thread 누락을 읽기 전용으로 점검한다.

기본 제품 범위에는 GUI, 캐릭터, 페르소나 메모리, 컴패니언, 터미널 에뮬레이터, 대화 로그 파싱이 포함되지 않는다.
