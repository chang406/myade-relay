# 작업 인계

기준일: 2026-09-15

## 개발 일시 중단 결정 (2026-09-15)

사용자가 편의성을 목적으로 시작한 Relay 개발을 잠시 중단하기로 결정했다. 기존 에이전트의 fork/하위 에이전트 기능으로 충분한 경우가 있을 수 있다는 사실을 확인했고, Relay의 서버 실행과 세션 연결 부담을 감수하면서까지 별도의 제품을 사용할 이유가 아직 실제 사용에서 입증되지 않았다. Relay는 이미 열려 있는 Claude Code와 Codex 대화 사이를 연결한다는 차이가 있지만, 그 차이가 사용자에게 반복적인 편의를 주는지는 검증하지 않았다.

중단은 코드가 작동하지 않아서가 아니다. 실제 interactive 왕복의 `delivered`, 복구된 Codex queue retry의 `accepted`, server restart 상태 복구와 자동 테스트 16개 통과까지 확인했다. 다만 **기술 동작 검증과 제품 편의성 검증은 별개**다. 아래 기술 백로그를 명시적인 개발 재개 요청 없이 진행하지 않는다.

2026-09-23에 그 편의성 비교를 수행했고, 결론은 **일시 중단 유지, 재개 판단 보류**다. 전체 기록은 `docs/PRD.md`의 「제품 판단 기록: 편의성 비교 (2026-09-23)」에 있다. 요점만 옮기면, Relay는 정상 상태에서 조작 0회로 fork와 동등하지만 양쪽 CLI를 Relay가 새로 띄워야 하고, 교차 벤더 호출 자체는 `codex exec resume`이 설정 없이 대체하며, session registry와 app-server 수명 관리는 벤더 기능(`claude agents --json`, `codex remote-control`)과 중복된다. 고유하게 남는 것은 수신 증명 상태머신과 Claude 인바운드 Channel이다. 다음 단계는 코드 변경이 아니라 교차 모델 검토 품질 측정이며, 그 결과 전까지 아래 기술 백로그는 진행하지 않는다.

재개 요청이 오면 먼저 실제 교차-provider 작업에서 fork/하위 에이전트만 쓸 때와 Relay를 쓸 때의 입력·창 전환·설정 부담을 비교하고, Relay가 줄여 주는 반복적인 불편과 완료 기준을 `docs/PRD.md`에 기록한다. 그 판단에서 계속할 이유가 확인되면 현재 Git 변경과 테스트 기준선을 확인한 뒤 아래 기술 백로그를 진행한다. 이유가 확인되지 않으면 일시 중단을 유지한다. 기존 `.relay/` 검증 데이터는 보존한다(이 보관본에는 들어 있지 않다).

## 현재 위치

P0의 핵심 왕복은 알려진 Codex thread를 재개하는 경로에서 실제 검증됐다. 서버, session/exchange 저장, bound MCP 도구 6개, Claude Channel, Codex queue coordinator와 interactive launcher가 구현돼 있다.

새 Codex conversation은 loopback WebSocket App Server에 TUI를 `--remote`로 연결하고, TUI가 내보낸 공식 `thread/started` notification으로 자동 등록한다. Codex CLI 0.154.0에서 실제 TUI와 thread `<id-1>` 등록을 확인했다. `codex queue --remote`로 request를 깨우고 target의 `relay_receive`와 `relay_reply`, source Claude의 `relay_collect`까지 확인했다. 검증 exchange `<id-2>`의 최종 상태는 `delivered`다.

## 다음 작업 1: 새 Codex thread ID 등록 가능성 검증

목표: Codex CLI 0.154.0 이상이 제공하는 공식 lifecycle/hook/event/config 기능만으로 새 interactive conversation의 thread ID를 얻을 수 있는지 확정한다.

진행 순서:

1. [x] 공식 문서에서 App Server `thread/start` 응답과 `thread/started` lifecycle 지원을 확인한다.
2. [x] `launch --provider codex`에서 `--thread` 없이 시작하고 응답 ID로 기존 Relay session을 PATCH하도록 최소 수정한다.
3. [x] 터미널 parsing 없이 JSON-RPC로 ID를 얻는 보조 프로세스 테스트를 추가한다.
4. [x] 현재 설치된 Codex CLI 0.154.0에서 loopback WebSocket App Server와 TUI를 연결한다.
5. [x] TUI의 `thread/started`로 새 thread를 자동 등록하고 `codex queue --remote`로 깨운다.
6. [x] source Claude의 `relay_collect`를 확인하고 최종 `delivered`를 기록한다.

완료 조건:

- 새 conversation 자동 등록 성공 로그와 최종 `delivered` 증거가 있거나,
- 공식 지원 부재를 뒷받침하는 CLI/문서 근거와 최소 수동 대안이 문서화돼 있다.

## 다음 작업 2: 명시적 retry

목표: `delivery_attempted`에서 peer가 수신하지 않거나 자동 실패가 2회에 도달했을 때 사용자가 상태를 보고 특정 방향을 다시 시도할 수 있게 한다.

요구 사항:

- [x] request retry는 source, answer retry는 target ownership을 검사한다.
- [x] 기존 attempt 기록을 지우지 않는다.
- [x] 명시적 retry와 자동 retry를 attempt의 `trigger`로 구분한다.
- [x] request가 accepted 이후이거나 answer가 delivered/cancelled인 방향을 다시 보내지 않는다.
- [x] 최소 CLI/API 표면을 선택하고 자동 테스트한다.

명령은 `retry --session ID --request REQUEST_ID --direction request|answer`다. 방향별 `retryRequested`는 JSON에 보존되고 다음 실제 전송 attempt가 소비한다. 기존 exchange에는 호환 기본값이 적용된다. 자동 테스트로 CLI/API를 검증했다. 닫힌 App Server의 실제 Codex queue 실패 후 연결을 복구하고 CLI request retry를 실행했을 때, 다음 실제 queue attempt가 `explicit: sent`를 기록했고 Codex가 `relay_receive`로 `accepted`까지 진행했다. 이 retry exchange의 답변과 회수, 실제 Claude Channel 중단은 아직 검증하지 않았다. 상세 증거는 `docs/TECHNICAL_VALIDATION.md`에 있다.

## 다음 작업 3: doctor

목표: 실제 세션을 열기 전에 흔한 설정 오류를 한 번에 찾는다.

최소 검사:

- [x] Relay `/health`
- [x] Claude/Codex 실행 파일 존재와 `--version`
- [x] Codex queue subcommand 존재
- [x] Claude development Channel/MCP 플래그 존재
- [x] writable data/runtime directory
- [x] session ID 중복과 Codex thread 누락

`doctor`는 설정을 자동 수정하거나 permission을 승인하지 않는다. 실제 Claude Code 2.1.218, Codex CLI 0.154.0, `.relay/verification3` 서버를 대상으로 전 항목 `pass`를 확인했다.

## 완료 검증: server restart 상태 복구

- [x] 별도 Relay 서버 프로세스를 종료하고 같은 격리 데이터로 새 프로세스를 시작했을 때 `queued`, `delivery_attempted`, `replied`가 복원된다.
- [x] 재시작 전에 저장한 명시적 request retry가 남고, 다음 attempt가 `explicit`로 기록된다. 저장된 답은 재시작 뒤 source가 회수해 `delivered`로 전이한다.
- [x] 자동 테스트에서 `delivery_attempted`와 이미 알림을 보낸 `replied`를 자동 재전송하지 않으며, 보내지 않은 답과 명시적 request/answer retry만 후보가 됨을 확인한다. 실패 2회 제한도 재시작 뒤 유지된다.

별도 프로세스 실험은 `.relay/verification7/`에 보존했다. provider transport가 성공한 직후 attempt 기록 전에 프로세스가 죽는 창은 아직 검증하지 않았다. 그 창에서는 중복 알림 가능성을 배제할 수 없다. 상세 규칙과 증거는 `docs/ARCHITECTURE.md`, `docs/TECHNICAL_VALIDATION.md`에 있다.

## 개발 재개 후 기술 백로그

- 동시 Claude/Codex session과 요청 경합
- 성공한 transport와 attempt 기록 사이의 갑작스러운 프로세스 종료
- macOS/Linux 실행 인자와 경로
- Claude의 중복 MCP startup 경고 최소 재현
- audit 경고의 실제 영향과 안전한 dependency update

## 현재 증거

- 실제 성공 request: `<id-3>`
- 검증 데이터: `.relay/verification2/` (Git 제외)
- 새 thread 실제 성공 request: `<id-2>`
- 새 thread 검증 데이터: `.relay/verification3/` (Git 제외)
- 복구 후 실제 retry request: `<id-4>`
- 복구 retry 검증 데이터: `.relay/verification5/` (Git 제외)
- 자동 테스트 기준선: 16 pass, 0 fail
- 상세: `docs/TECHNICAL_VALIDATION.md`

검증 데이터를 정리하거나 덮어쓰기 전에 사용자에게 확인한다.
