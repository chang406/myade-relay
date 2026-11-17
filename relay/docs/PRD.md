# Relay 제품 요구사항

상태: 기술 MVP 동작 검증 후 개발 일시 중단 (사용자 결정, 2026-09-15). 2026-09-23 편의성 비교를 수행했고 중단을 유지한다.

기준일: 2026-09-15 (편의성 비교 기록 추가: 2026-09-23)

## 제품 판단 기록: 일시 중단

Relay의 핵심 왕복은 실제 Claude Code·Codex 대화에서 작동했다. 그러나 시작 목적은 에이전트 간 인계 기술 자체보다 사용자의 편의였다. 기존 에이전트의 fork/하위 에이전트 기능이 일반적인 작업 분배에는 충분할 수 있고, Relay는 별도 서버와 두 CLI 세션을 연결해야 한다. 이미 열린 서로 다른 provider 대화를 유지하며 짧은 요청과 답을 주고받는 점은 Relay의 차별점이지만, 이 차이가 설정 부담보다 큰 실사용 이익을 준다는 근거는 아직 없다.

따라서 사용자의 2026-09-15 결정으로 추가 개발을 일시 중단한다. 기술 검증 성공을 제품 편의성 검증 성공으로 해석하지 않는다. 재개 여부는 실제 교차-provider 작업에서 기존 fork/하위 에이전트와 Relay의 사용 단계를 비교하고, 반복되는 불편과 Relay의 완료 기준을 이 문서에 기록한 뒤 판단한다. 재개 전 기술 백로그는 `docs/HANDOFF.md`에 보존한다.

## 제품 판단 기록: 편의성 비교 (2026-09-23)

위 문단이 요구한 편의성 비교를 수행했다. 결론은 **일시 중단 유지, 재개 판단 보류**다. 사용자는 이 시점에서 재개도 폐기도 결정하지 않았다.

### 조작 단계 비교

시나리오는 "Claude로 작업하던 중 Codex에게 리뷰를 요청하고 답을 받는다"이다.

| 방식 | 사전 설정 | 건당 사용자 조작 | 교차 벤더 | 맥락 누적 |
|---|---|---|---|---|
| 수동 복붙 | 없음 | 창 전환 2 + 복붙 2 | 가능 | 가능 |
| fork/하위 에이전트 | 없음 | 0 | 불가 | 가능 |
| `codex exec resume` | 없음 | 승인 1회 | 가능 | 가능 |
| Relay | 서버 1 + 양쪽 CLI 재시작 + MCP 승인 2 | 0 | 가능 | 가능 |

정상 상태에서 Relay의 조작 비용은 fork와 같은 0이다. 차이는 진입 비용에서 발생한다.

### 확인한 제약: Relay는 이미 열린 세션에 붙지 못한다

MCP adapter는 provider 시작 인자로만 주입된다(`src/launch.ts`의 `providerArgs`와 `spawn`). `register`는 레코드만 만들고 adapter를 연결하지 않는다(`src/cli.ts`). 따라서 "이미 열려 있는 두 대화를 연결한다"는 위 문서 표현은 실제로는 **Relay launcher로 시작한 세션에만** 해당한다. 맥락이 쌓인 기존 창은 버리고 다시 시작해야 한다. 이는 코드를 읽어 확인한 사실이며, 실사용 실험으로 측정한 빈도는 아직 없다.

### 실질 경쟁자는 fork가 아니다

`codex exec resume <thread> "질문"`은 설정 없이 교차 벤더 호출과 같은 스레드 맥락 누적을 제공한다. 호출 측의 background 실행을 쓰면 비동기도 된다. 역방향은 `claude -p`로 대칭이 된다. Relay가 제공하는 것 중 이 경로로 대체되지 않는 부분은 다음 넷으로 좁혀진다.

1. 상대 세션에 사람의 개입이나 권한 판단이 필요한 작업
2. 상대 세션에 이미 쌓여 재현 비용이 큰 맥락이 있는 경우
3. 각 CLI의 권한·sandbox 경계를 분리해 유지해야 하는 경우
4. Codex에서 Claude로의 인바운드. 실행 중인 interactive Claude 세션에 메시지를 넣는 공식 경로는 `claude --help` 전체에서 확인되지 않았고, Relay의 development Channel이 현재 유일한 길이다

4번은 가장 단단한 차별점이면서 동시에 `--dangerously-load-development-channels`라는 비공식 플래그에 의존하는 지속성 위험이다.

이 비교는 문서와 CLI help를 근거로 한 분석이다. `codex exec resume` 경로를 실제 교차 작업에서 사용해 본 측정은 아직 없다.

### 환경 변화: 벤더 기능과의 중복

2026-09-23 기준 설치 버전은 Codex CLI 0.155.1, Claude Code 2.1.219다. 검증 기준선이었던 0.154.0, 2.1.218에서 올라갔다. `--help`와 실제 실행으로 확인한 항목은 다음과 같다.

- `codex remote-control start`가 공유 app-server 데몬을 제공한다. Relay가 세션마다 직접 띄우고 수명을 관리하는 loopback app-server와 역할이 겹친다.
- `codex agents`가 공유 데몬의 에이전트 세션을 조회한다.
- `codex queue --thread`가 세션 UUID뿐 아니라 세션 이름도 받는다. P0 최대 난제였던 새 대화 주소 획득의 대안이 된다.
- `claude agents --json`이 background뿐 아니라 **interactive 세션까지** `sessionId`, `cwd`, `name`, `status`로 반환한다. 실제 실행으로 확인했다. Relay의 session registry 및 `doctor`의 session 점검과 겹친다.
- `codex exec --worktree`가 Git worktree 격리를 제공한다.

따라서 Relay 구현 중 app-server 수명 관리, session registry, doctor의 상당 부분은 벤더 기능과 중복되는 유지보수 비용이다. 고유하게 남는 것은 **수신 증명 상태머신**과 **Claude 인바운드 Channel**이다. 재개할 경우 이 둘만 남기고 나머지는 벤더 기능에 얹는 축소 스코프를 우선 검토한다.

### 멀티에이전트 오케스트레이션 제안에 대한 판단

외부 평가로 Orchestrator / Planner / Builder / Reviewer / Shared State 구조와 아홉 개의 설계 질문(역할 결정, 공유 context 범위, token 비용, 리뷰 시점, 피드백 반환, 충돌 조정, 동일 파일 동시 수정, 검토 품질 평가, 모델 배치)이 제시됐다. 질문 자체는 타당하지만 채택하지 않는다.

- 해당 구조는 `8. 비목표`의 "여러 에이전트의 자동 계획 분배"와 `AGENTS.md`의 "일반 목적 workflow engine" 제외에 정면으로 해당한다. 채택은 재개가 아니라 다른 제품으로의 전환이다.
- Shared State는 `3. 제품 원칙`의 최소 context 원칙과 충돌한다. 전체 맥락 공유는 token 비용을 키우고, 줄이면 공유의 의미가 사라진다. 현재의 최소 교환 설계가 이 트레이드오프에서 더 낫다고 본다.
- 동일 파일 동시 수정은 각 provider의 worktree 격리가 이미 실용적 해법을 제공한다.
- 충돌 조정의 답은 사람이며, 이는 확장되지 않는다. 사람 승인이 병목이면 병렬화의 이득도 줄어든다.
- 아홉 질문 중 Relay가 이미 답한 것은 리뷰 시점 하나뿐이다. 상태 모델의 `accepted`, `replied`, `delivered`가 "상대가 실제로 읽고 답했는가"에 대한 증거 기반 답이다.

### 다음 결정의 근거: 교차 모델 검토 품질 측정

위 아홉 질문 중 유일하게 이 프로젝트의 결정을 바꾸는 것은 **검토 결과가 실제로 더 좋은지 어떻게 평가하는가**이다. 지금까지 "다른 벤더는 학습 분포가 달라 실패 모드가 독립적이므로 같은 모델의 fork보다 나은 검토자다"라는 논증을 써 왔으나, 이는 **이론적 주장이며 측정된 사실이 아니다**. 교차 모델 배치 전략도 이 측정 없이는 정할 수 없다.

따라서 다음 단계는 Relay 코드 변경이 아니라 별도의 측정이다. 알려진 결함이 있는 실제 diff 집합에 대해 (A) 단일 모델 단독, (B) 같은 벤더 fork 검토, (C) 교차 벤더 검토의 결함 적발 수, 오탐 수, token 비용을 비교한다. 이 측정에는 Relay가 필요하지 않으며 기존 `src/`를 변경하지 않는다.

- C가 B보다 유의하게 낫다면 교차 벤더 연결의 가치가 데이터로 성립하고, 축소 스코프 재개의 근거가 된다.
- C와 B가 비슷하다면 이 방향 전체의 근거가 사라지며, 폐기 판단의 근거가 된다.

이 측정을 위한 하네스를 `eval/`에 만들었다. 절차와 검증 상태는 `eval/README.md`에 있다. 2026-09-23 기준으로 합성 케이스 1개에 대해 실제 CLI 3회 호출 경로와 집계까지 동작을 확인했고, 실제 결함이 라벨링된 케이스로는 아직 실행하지 않았다. 합성 1케이스 결과는 신호가 아니다.

어느 쪽이든 결과가 나오기 전까지 기술 백로그는 진행하지 않는다.

## 1. 문제

개발자는 여러 터미널에서 Claude Code와 Codex를 동시에 사용한다. 한 세션이 다른 세션의 분석이나 검토를 필요로 할 때 사용자가 질문을 복사하고, 대상 창을 찾고, 답을 다시 원래 창으로 옮겨야 한다. 기존 대화와 권한 흐름을 유지하면서 이 왕복만 줄여주는 작은 연결 계층이 필요하다.

단순 queue는 이 문제를 해결하지 못한다. 요청이 파일에 저장되었거나 CLI 명령이 성공한 상태와 상대 에이전트가 실제로 읽은 상태를 구분해야 한다.

## 2. 목표 경험

1. 사용자는 평소처럼 Claude Code와 Codex를 각각 자기 터미널에서 연다.
2. 한 에이전트가 등록된 다른 세션에 간결한 요청을 보낸다.
3. Relay는 해당 provider가 공식적으로 제공하는 경로로 열린 대화에 알린다.
4. 대상 에이전트가 요청을 명시적으로 수신하고 답한다.
5. 원래 에이전트가 답을 명시적으로 회수하고 사용자에게 근거와 함께 보여준다.
6. 권한 확인이 필요하면 provider의 원래 UI에서 사용자가 결정한다.

## 3. 제품 원칙

- 기존 대화 보존: 새 headless 작업으로 대체하지 않고 열린 interactive conversation을 대상으로 한다.
- 명시적 인계: transport 성공과 agent receipt를 별도 상태로 기록한다.
- 작은 표면적: 서버, adapter, launcher와 JSON 저장소만 둔다.
- provider 존중: 공개 CLI 명령, MCP, lifecycle/Channel 기능을 사용한다.
- 사용자 통제: 키 입력, trust, permission을 Relay가 대신 결정하지 않는다.
- 최소 context: 전체 대화 대신 질문, 필요한 context, 답변과 근거만 교환한다.

## 4. P0 범위

### 4.1 세션 등록

- provider는 `claude` 또는 `codex`다.
- Relay session ID, provider session/thread ID, cwd, label, delivery 방식, 필요한 실행 파일 경로를 보존한다.
- 실행 중인 동일 provider session/thread의 중복 등록을 거부한다.
- launcher 종료 시 세션을 `ended`로 표시한다.

### 4.2 요청과 답변

- source는 자기 identity로 target session에 질문과 제한된 context를 보낸다.
- 기본값으로 source와 target의 정규화된 cwd가 같아야 한다.
- 다른 cwd는 `allowCrossWorkspace=true`로 명시해야 한다.
- target만 수신하고 답할 수 있다.
- source만 회수, 취소할 수 있다.
- 답변은 evidence, uncertainty, 다음 행동을 담을 수 있는 간결한 텍스트다.

### 4.3 실제 세션 알림

- Claude Code: 세션에 연결된 development Channel adapter가 후보 exchange를 polling하고 Channel notification을 보낸다.
- Codex: 등록된 정확한 실행 파일과 thread ID로 `codex queue --thread ... --message ...`를 호출한다.
- 알림이나 queue 성공은 `delivery_attempted`로만 기록한다.
- target의 `relay_receive` 호출 전에는 수신 성공으로 간주하지 않는다.

### 4.4 상태 모델

| 상태 | 증거 | 의미 |
|---|---|---|
| `queued` | exchange JSON 기록 | Relay에만 저장됨 |
| `delivery_attempted` | provider transport 성공 | 열린 대화에 전달을 시도했으나 agent receipt 미확인 |
| `accepted` | target의 `relay_receive` | target agent가 요청을 명시적으로 읽음 |
| `replied` | target의 `relay_reply` | 답변이 Relay에 저장됨 |
| `delivered` | source의 `relay_collect` | 원래 agent가 답변을 회수함 |
| `cancelled` | source의 `relay_cancel` | 요청이 취소됨. 상대 프로세스 종료 의미는 아님 |

정상 전이는 `queued → delivery_attempted → accepted → replied → delivered`다. transport보다 먼저 target이 polling/수신한 경우 `queued → accepted`도 유효하다.

## 5. MCP 도구

각 adapter는 시작할 때 하나의 Relay session ID에 고정된다. 모델 입력에는 source/target ownership을 바꾸는 필드를 제공하지 않는다.

| 도구 | 호출 주체 | 효과 |
|---|---|---|
| `relay_send` | source | target에 새 request 생성 |
| `relay_list` | 양쪽 | 자기 관련 request 요약 조회 |
| `relay_receive` | target | 요청 수신을 명시하고 본문 읽기 |
| `relay_reply` | target | accepted 요청에 답 저장 |
| `relay_collect` | source | 답을 읽고 delivered 처리 |
| `relay_cancel` | source | 자기 요청 취소 |

## 6. 안전 요구사항

- 서버는 기본적으로 `127.0.0.1`에만 bind한다.
- CLI 프로세스는 shell 없이 실행한다.
- Relay는 터미널 입력을 생성하거나 승인 버튼을 누르지 않는다.
- peer가 보낸 내용은 task data다. 사용자/시스템 지시나 권한 정책을 덮어쓰지 않는다.
- 자동 delivery 실패는 방향별 최대 2회까지만 시도한다.
- 실제 사용자 데이터와 테스트 데이터를 분리한다.
- 로그와 API 응답에서 queue 상태를 작업 시작처럼 표현하지 않는다.

## 7. P0 완료 기준

### 완료된 항목

- [x] session과 exchange를 로컬 JSON에 보존한다.
- [x] MCP 도구 identity를 launcher/adapter 설정에 고정한다.
- [x] ownership, cwd 경계, 상태 전이를 자동 테스트한다.
- [x] Claude Channel과 알려진 Codex thread의 실제 interactive 왕복을 검증한다.
- [x] target의 receive/reply와 source의 collect로 최종 `delivered`를 확인한다.
- [x] permission 확인이 provider 터미널에 남는 것을 확인한다.

### 추가로 확인한 항목

- [x] 새 Codex 대화를 만들고 thread ID를 공식 lifecycle 정보로 자동 등록한다.
- [x] 위 경로로 새 대화의 실제 왕복을 다시 검증한다.
- 자동 등록이 가능함을 확인했으므로 수동 등록 대안의 완료 조건은 적용되지 않는다.
- [x] 중단된 transport를 사용자가 명시적으로 재시도할 수 있게 한다.
- [x] 실행 전 provider와 Relay 연결을 점검하는 `doctor`를 제공한다.

P0의 핵심 기술 질문이었던 새 Codex conversation의 안정적인 주소 획득은 공식 `thread/started`와 loopback WebSocket App Server 경로로 가능함을 실제 왕복으로 확인했다. 명시적 Codex retry는 중단 후 복구된 실제 queue와 target receipt까지 확인했고, `doctor`도 실제 설치 환경에서 통과했다. `queued`, `delivery_attempted`, `replied`의 server restart 복구 규칙도 격리 실험으로 검증했다. 다음 작업은 동시 세션과 요청 경합 검증이다.

## 8. 비목표

- IDE 또는 터미널 UI 제작
- 캐릭터와 장기 persona memory
- 전체 transcript 동기화나 화면 scraping
- 여러 에이전트의 자동 계획 분배
- permission 자동 승인
- 원격 팀 협업, 계정, cloud storage

## 9. 이후 단계

- P0.1: 새 Codex thread 자동 등록 또는 최소 수동 연결 확정
- P0.2: retry/doctor와 restart recovery 규칙
- P1: 동시 세션과 요청이 늘었을 때의 관측성 및 부하 검증
- P2: 실제 반복 사용에서 필요가 증명될 때만 작은 상태 조회 UI 검토

## 10. 의사결정 기록

- GUI보다 실제 provider delivery를 먼저 검증한다.
- session identity는 모델 입력이 아니라 adapter 구성에 둔다.
- transport success와 receipt를 분리한다.
- Codex 실행 파일 경로를 session에 저장한다. 서버 PATH가 launcher PATH와 다를 수 있기 때문이다.
- 새 thread ID를 모르는 상태에서 성공을 가장하지 않고, 알려진 thread 재개를 현재 지원 경로로 둔다.
- 2026-09-15: TUI를 loopback WebSocket App Server에 연결하고 공식 `thread/started`로 ID를 자동 등록하며 `codex queue --remote`로 전달하는 경로를 구현했다. 실제 target `receive/reply`와 source `collect`를 거쳐 최종 `delivered`까지 확인했다.
- 2026-09-15: `retry --session ID --request REQUEST_ID --direction request|answer`를 추가했다. 방향별 소유권과 상태를 검사하며, 실제 attempt에 `automatic` 또는 `explicit` trigger를 보존한다.
- 2026-09-15: 읽기 전용 `doctor`를 추가하고 실제 설치된 Claude Code 2.1.218, Codex CLI 0.154.0과 격리 Relay 서버에서 모든 최소 검사를 통과했다.
