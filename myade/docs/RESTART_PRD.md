# myade 재개 PRD 및 코드 분석

2026-09-14 · 기반 업데이트 검증 완료 / 완전 자동 인계 미완

## 결론

새 앱을 만들지 않고 이 저장소를 이어서 개발한다. Tauri 2 + React + xterm.js + portable-pty가
이미 사용되고 있어 대화에서 제안한 기술 구조와 일치한다. 별도 orchestrator 서버도 필요 없다.

목표는 **실제 대화형 CLI 두 개를 한 창에서 유지하면서 질문·맥락·답변을 서로 전달하는 개인
작업 공간**이다. 코딩 리뷰는 한 사례이며 문서·기획·조사에도 동일하게 적용한다.

이 문서는 새 방향의 요구사항이다. MULTI_PANE_ADE_PRD.md와 PERSONA_LAYER_PRD.md는 이전 구현
이력으로 보존한다. 이전 MVP 완료는 현재 요구의 자동 인계 완료를 의미하지 않는다.

## 1. 재사용 분석

| 부분 | 확인한 코드 | 판단 |
|---|---|---|
| 실제 터미널 | myade-gui/src/TerminalPane.tsx, src-tauri/src/pty.rs | 재사용. 직접 대화 가능한 PTY |
| 생성·종료 | src-tauri/src/commands.rs, state.rs | 재사용. 앱과 서버의 pane 식별 보강 |
| 세션 조회 | src/state.ts, tools.ts, server.ts | 재사용. 기존 MCP 서버를 전달에도 활용 |
| 캐릭터·컴패니언 | characters/persona/companion 모듈 | 사용자 데이터 보존. 핵심 workflow와 추후 분리 |
| 프로젝트 Explorer | 현재 App.tsx에 없음 | 후속 UI |
| 요청·답변 | 이전에는 pane_list/status/ping만 존재 | 이번에 명시적 수신 방식의 도구 추가 |
| 자동 wake-up | 구현 없음 | 기술 검증 필요 |
| Codex lifecycle | Claude 훅과 claudeSessionId 중심 | 실행 가능과 생명주기 연동은 별개 |
| 배포 | 이전 위치를 포함한 Rust 캐시 발견 | 새 target으로 컴파일 검증. 설치 파일은 별도 |

## 2. 이번 변경

1. GUI pane ID를 서버에 등록하고 실제 등록 ID를 MYADE_PANE_ID로 셸에 전달한다. 같은 폴더의
   두 터미널과 같은 터미널의 Claude 재시작을 cwd 추측만으로 연결하지 않는다.
2. 등록은 셸 실행 전에 수행하며 셸 실행 실패 시 해당 등록을 종료한다.
3. SessionStart wrapper가 ID를 전달한다. 알 수 없는 명시적 ID는 다른 pane으로 추측하지 않는다.
   ID 없는 기존 훅은 호환 경로를 유지한다.
4. 요청·답변 MCP 도구 6개와 JSON 저장소를 추가한다. 다른 프로젝트 전송은 명시적 설정이 필요하다.
5. 감지 가능한 Claude 세션 교체 후 이전 요청을 잘못 처리하지 않도록 session ID를 기록한다.
6. 질문·맥락·답변 크기와 상태 전이를 제한한다. 답변 덮어쓰기와 저장 실패의 성공 처리를 막는다.
7. 캐릭터 없는 세션에 불필요한 persona 읽기/요약 호출을 하지 않는다.
8. 터미널 backlog 전에 이벤트 구독 등록을 기다려 초기 출력 유실 가능성을 줄인다.
9. 폴더 선택 취소가 아닌 pane 생성 오류를 UI에 표시한다.
10. 독립 테스트 경로 MYADE_DATA_DIR와 Node 자동 테스트를 추가한다.

## 3. 제품 요구사항

- 두 패널 모두 실제 Claude/Codex CLI로 직접 대화할 수 있어야 한다.
- 어느 쪽이 주 작업인지 고정하지 않는다. 화면 위치·모델·역할은 별개다.
- 발신 agent가 현재 대화에서 필요한 목표·사실·시도 내역·추측·제약을 요약한다.
- 상세 상담은 상대 세션에 남기고 원래 세션에는 결론·근거·불확실성·다음 행동을 반환한다.
- 별개 도메인의 요청은 새 세션 또는 명시적 맥락 전환으로 분리한다.
- Git 없는 폴더의 문서·기획에도 동일한 전달 모델을 사용한다.
- 사용자 입력·권한 프롬프트를 자동 입력으로 침범하지 않는다.

기본값: 상담은 읽기·분석, 결과 수신 후 권고안 제시까지. 자동 수정 정책은 사용자 선택이 남아 있다.
전달 서버 자체는 CLI 도구 권한이나 sandbox를 변경하지 않는다. 실제 읽기 전용 제약은 각 CLI에서
별도로 적용해야 한다. 캐릭터 수가 pane 수를 제한하는 기존 동작은 이번에 유지한다.

## 4. 현재 가능한 전달 흐름

업데이트한 서버를 재시작하고 두 CLI에서 같은 MCP 서버에 연결한다. 도구 목록 갱신에는 클라이언트
재연결이 필요할 수 있다. 이번 업데이트는 기존 서버 종료나 사용자 전역 설정 변경을 수행하지 않았다.

1. 각 GUI 터미널에서 MYADE_PANE_ID 값을 확인한다. Claude는 SessionStart 응답에서도 ID를 받는다.
2. 발신 agent가 pane_list로 대상을 확인하고 exchange_send를 호출한다.
3. 사용자가 상대 세션에서 “대기 요청을 확인하고 처리해”라고 지시한다.
4. 상대 agent가 exchange_list → exchange_receive → 분석 → exchange_reply를 수행한다.
5. 원래 세션에서 “답변을 확인해”라고 지시하면 exchange_list → exchange_collect로 회수한다.

**내용 복사·붙여넣기는 없지만, 수신·회수 시작 지시는 아직 필요하다.** 큐 저장과 CLI 자동 실행을
동일시하지 않는다. 양쪽에 신뢰하는 MCP 연결을 설정해야 한다.

| 도구 | 의미 |
|---|---|
| exchange_send | sourcePaneId, targetPaneId, question, context 저장. 호출마다 새 요청 |
| exchange_list | pane별 최근 50개 요약. 전체 맥락·답변은 제외 |
| exchange_receive | 대상 pane이 requestId를 명시적으로 수신 |
| exchange_reply | 수신된 요청에 최종 answer 제출. 동일 답변 재시도 허용 |
| exchange_collect | 발신 pane이 완료 답변 회수. 재조회 가능 |
| exchange_cancel | 발신 pane이 취소. 상대 프로세스를 종료하지 않음 |

상태: queued → received → answered → collected / cancelled.
working은 실제 AI 작업 시작을 확인할 이벤트가 없으므로 현재 생성하지 않는다.
저장은 data/exchanges.json, 최대 1,000개. 자동 삭제 없이 한도에서 새 전송을 거절한다.

## 5. 구조와 확장성

```
Tauri UI → PTY → 실제 CLI A
                     ↓ 도구 호출
기존 로컬 MCP 서버 → ExchangeStore → 요청/결과 JSON
                     ↑ 도구 호출
                실제 CLI B
```

- 터미널 출력은 화면 표시용이다. 대화 파싱이나 완료 추정에 사용하지 않는다.
- ExchangeStore는 모델을 호출하거나 셸에 키 입력을 주입하지 않는다.
- question/context는 범용이며 Git diff나 reviewer 역할을 필수로 하지 않는다.
- 다음 adapter에서는 terminal ID와 provider session ID를 분리한다. 현재 claudeSessionId는
  기존 호환 필드다. Codex 재시작/세션 교체 감지는 미구현이므로 아직 같은 보호를 보장하지 않는다.
- MCP 지원과 자동 wake-up 지원은 별도 능력이다.
- Explorer는 기존 상태를 읽는 화면으로 추가하고 별도 AI나 상태 원본을 만들지 않는다.
- 현재 서버는 신뢰하는 개인 로컬 환경용이다. paneId는 routing ID이지 인증 토큰이 아니다.
  같은 MCP 서버에 접근하는 클라이언트 간 강한 격리는 보장하지 않는다. 원격/팀 사용 전 인증과
  workspace별 접근 제어를 설계한다.

## 6. 남은 작업 우선순위

### P0: 같은 대화형 CLI의 자동 수신 (기술 검증 완료)

2026-09-14 격리 실험에서 Claude Code Channels와 Codex `queue`가 각각 기존 대화형 세션을 안전하게
깨우는 것을 확인했다. [`experiments/p0/README.md`](../experiments/p0/README.md)에 재현 방법과 제약을
기록했다. 두 경로 모두 PTY 출력 파싱이나 키 입력을 쓰지 않으며 기존 대화 맥락을 유지한다.

- Claude Code 2.1.218: MCP Channel 알림이 열린 세션에 도착해 모델 실행을 시작했다. 모델의
  `exchange_receive`와 `exchange_reply` 성공을 별도 감사 이벤트로 확인했다. 커스텀 Channel은
  research preview라 개발 플래그와 시작 시 사용자 확인이 필요하다.
- Codex CLI 0.154.0: `codex queue --thread <id> --message <text>`가 열린 유휴 TUI를 즉시 깨웠다.
  닫힌 TUI에 저장한 메시지는 같은 thread를 resume할 때 처리됐다. `exchange_collect` 성공과 화면의
  최종 답변을 확인했다.
- 알림 전송은 수신이 아니다. 감사 로그는 `notification_sent_not_received`로 기록하고,
  `exchange_receive` 도구 성공 후에만 요청 상태가 `received`가 된다.
- MCP 도구 권한 확인은 각 CLI의 정상 화면에 남는다. 실험은 권한 프롬프트에 자동 키 입력을 하지
  않았다.

남은 P0 제품 작업은 검증된 adapter를 GUI pane 생명주기에 연결하고 provider session/thread ID를
상태에 저장하는 것이다. Claude의 preview 동의와 Codex thread 선택을 사용자에게 명시적으로 보여야
한다. Codex app-server 기반 새 UI로 교체하는 것은 기존 PTY 유지 목표와 별도 범위다.

### P1: 상태 모델

- terminal lifetime과 agent session lifetime을 분리하고 Codex adapter를 추가한다.
- ID 없는 기존 HTTP 훅의 늦은 이벤트와 cwd 추측 경로를 줄인다.
- 기존 6시간 무활동 GC는 장시간 작업을 오판할 수 있다. 실제 프로세스 생존과 agent 상태를 분리한다.
- 기존 SessionStore의 로드 실패가 빈 상태로 처리되는 동작을 명시적 복구 방식으로 개선한다.
- persona의 cwd 단위 in-flight guard가 같은 폴더 다른 agent 이벤트를 가릴 수 있는지 검증한다.
- 요청 기록의 안전한 보관/아카이브 UX를 추가한다.

### P2: 작업용 UI

- 캐릭터 모드를 선택 사항으로 하고 pane 한도를 롤스터와 분리한다.
- 두 pane 크기 조절, 프로젝트 이름, 요청 도착·오류 표시를 추가한다.
- 그 후 프로젝트 Explorer·파일 미리보기를 구현한다.
- PTY backlog의 UTF-8 경계, 프로세스 트리 종료, 한글 입력은 실제 Windows 앱에서 검증한다.

## 7. 로드맵과 완료 조건

| 단계 | 범위 | 통과 조건 |
|---|---|---|
| 이번 업데이트 | 분석, pane ID, 명시적 요청 왕복 | 서버/GUI 컴파일 및 MCP 두 클라이언트 테스트 |
| P0 기술 검증 | Claude Channel + Codex queue | 입력 침범 없이 같은 세션에서 수신·회수 완료 |
| 작업용 MVP | 작업 모드, 분할 조절, 요청 표시 | 코딩/문서 작업에서 내용 복사 0회, 오류 명확 |
| 확장 | Explorer, workflow 템플릿 | 실제 다중 프로젝트 탐색 불편이 확인될 때 |

## 8. 검증 결과

2026-09-14:
- 루트 npm test: TypeScript 빌드 및 7개 테스트 통과.
- 실제 HTTP 서버 + 독립 MCP 클라이언트 2개: 요청·수신·답변·회수 통과.
- GUI TypeScript + Vite production build 통과. 기존 bundle 500kB 경고는 남음.
- 별도 target 경로 cargo test --lib --offline: 컴파일 및 기존 9개 테스트 통과.
- 이 시점의 기반 검증에서는 실제 모델 호출, GUI 클릭/한글 입력, 자동 wake-up, 설치 파일이 미검증이었다.

P0 추가 검증(2026-09-14):
- 설치 버전: Claude Code 2.1.218, Codex CLI 0.154.0.
- 격리된 실제 myade 서버에서 Codex가 요청을 전송하고 Claude의 열린 대화형 세션이 Channel 알림으로
  자동 수신했다. Claude가 `exchange_receive`와 `exchange_reply`를 호출했다.
- 공식 `codex queue`가 열린 Codex TUI를 자동으로 깨웠고, 같은 대화에서 `exchange_list`와
  `exchange_collect`를 호출해 Claude의 답변을 표시했다.
- 최종 저장 상태 `collected`, 답변 `17 + 25 = 42`, 양쪽 실제 모델 호출과 도구 감사 로그를 확인했다.
- 초기 검증 목록의 “실제 모델 호출/자동 wake-up 미검증”은 이 격리 P0 경로에 대해서는 해소됐다.
  기존 myade-gui pane 생명주기 통합, GUI 클릭/한글 입력, 설치 파일은 여전히 미검증이다.

재현 명령:
```
npm test
cd myade-gui
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline
```

이 검증 환경에서는 Vite 기본 config bundler가 상위 폴더 접근 거절로 실패했으므로 코드 변경 없이
다음 방식으로 검증했다.
```
node node_modules/typescript/bin/tsc
node node_modules/vite/bin/vite.js build --configLoader runner
```

기존 Rust target에 로컬 절대 경로가 남아 있었다. 캐시를 삭제하지 않고 별도 폴더를 사용했다.
```
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline --target-dir <새 검증 폴더>
```

기반은 재사용 가능하며 이번 변경은 검증되었다. 완전 자동 인계와 새 작업 UI는 후속 완료 조건을
통과하기 전까지 완료로 표기하지 않는다.
