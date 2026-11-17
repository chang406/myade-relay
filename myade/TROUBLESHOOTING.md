# 알려진 함정 (Known Pitfalls)

페르소나 레이어(`src/persona.ts`) 개발 중 실제로 겪었던 시행착오들. 코드에는 대부분 이미 대응이
들어가 있지만("해결" 항목), 같은 종류의 실수를 반복하지 않기 위해 증상/원인/해결을 남겨둔다.
설치·설정 관련 트러블슈팅은 [`README.md`의 트러블슈팅 섹션](./README.md#트러블슈팅) 참고 — 이
문서는 그보다 근본적인, 설계/구현 단계에서 걸렸던 함정들이다.

## 일반 원칙

개별 사고 사례보다 먼저 지켜야 할, 같은 종류의 실수가 반복해서 나왔던 부분에 대한 규칙.

- **새로 `claude` 프로세스를 spawn하는 코드를 짤 때는 항상 `src/persona.ts`(Node, cross-spawn 기반)와
  `myade-gui/src-tauri/src/companion.rs`(Rust, stdin 기반)의 기존 패턴부터 참고할 것.** 특히 Windows에서
  자유 텍스트(프롬프트)는 절대 CLI 인자로 넘기지 말고 stdin으로 흘려보낼 것 - 8번 항목이 이걸 건너뛰어서
  실제로 터진 사고다. `myade-gui/src-tauri/src/claude.rs`(옛 GUI의 헤드리스 채팅 기능, 지금은 삭제됨)의
  `.cmd` fallback 패턴만 베끼고 이 부분을 놓치기 쉬우니 주의.

## 1. SessionEnd 서브프로세스 cwd 고정 문제

- **증상**: 세션이 끝날 때마다 `[persona] summary subprocess failed` 로그와 함께 매번 실패.
- **원인**: 요약 서브프로세스(`claude -p --resume`)의 cwd를 `~/.myade`로 고정했었다. `--resume`은
  **프로젝트 디렉터리 기준**으로 세션을 찾기 때문에, 원래 세션과 다른 cwd에서 실행하면 무조건
  "No conversation found"로 실패한다.
- **해결**: 서브프로세스는 반드시 훅이 보낸 `input.cwd`(원래 세션의 실제 프로젝트 디렉터리)에서
  실행한다 (`src/persona.ts`의 `onSessionEnd`).

## 2. `~/.myade` 삭제 사고

- **증상**: 디버깅 중 검증용으로 append한 `persona.md`를 "테스트 흔적이니 정리하자"며
  `rm -rf ~/.myade`로 곧바로 지웠고, 그 폴더에 같이 쌓여 있던 실사용 로그(성공 기록)까지 함께
  사라져 사용자가 데이터 유실을 의심하는 혼란으로 이어졌다.
- **원인**: 테스트 중 만든 데이터와 실사용 데이터가 같은 파일(`persona.md`)에 시간순으로 섞여
  누적되는 구조라, 지우려는 대상만 골라내지 않고 디렉터리째 삭제해버렸다.
- **해결**: "리포 바깥의 사용자 데이터 디렉터리(`~/.myade`, `~/.claude` 등)는 테스트 정리
  목적이라도 사용자에게 먼저 확인받지 않고 삭제하지 않는다"는 원칙을 `CLAUDE.md`의 Notes에
  명문화했다. 지워야 할 것 같으면 먼저 뭘 지우려는지 보여주고 확인을 받는다.

## 3. LLM 요약 출력 미검증 append

- **증상**: 요약 서브프로세스가 "한 줄만, 마크다운/설명 없이"라는 프롬프트 지시를 항상 지키지는
  않는다 — 여러 줄짜리 설명을 붙이거나, 문단 끝에 "...SKIP"처럼 애매하게 끝내는 경우가 있었다.
  이걸 검증 없이 그대로 `persona.md`에 append하면, 그 파일은 매 세션 `SessionStart`마다 다시
  컨텍스트로 주입되므로 한 번 잘못 쌓인 지저분한 항목이 이후 모든 세션에 계속 영향을 준다.
- **원인**: `SKIP` 여부를 정확 일치(`/^skip\.?$/i`)로만 체크하고, 그 외 응답은 형식 검증 없이
  바로 append하는 구조였다.
- **해결**: 개행이 포함되어 있거나 `MAX_SUMMARY_LINE_LENGTH`(150자)를 넘으면 형식을 안 지킨
  것으로 보고 append 대신 폐기하고 로그만 남긴다 (`src/persona.ts` `onSessionEnd` 후반부).

## 4. `SessionStart`는 HTTP 훅을 지원하지 않음

- **증상**: `Stop`/`Notification`/`SessionEnd`는 `type: "http"` 훅으로 잘 동작하는데,
  `SessionStart`만 서버에 아무 요청도 안 들어온다 (에러도 없이 조용히 스킵됨).
- **원인**: Claude Code 클라이언트가 `SessionStart` 이벤트에 한해 `type: "http"` 훅을
  지원하지 않고 조용히 건너뛴다 (`--debug hooks` 로그: `Skipping HTTP hook ... HTTP hooks are
  not supported for SessionStart`).
- **해결**: `scripts/session-start-hook.js`를 `type: "command"`로 등록해, stdin으로 받은 훅
  JSON을 그대로 `/hooks/session-start`에 POST하고 응답을 stdout으로 릴레이하는 얇은 래퍼로
  우회한다. 실제 로직(페르소나 조회, pane 등록)은 여전히 `server.ts`에만 있다. 이 결과로 훅
  구조가 비대칭이 됐다: `SessionStart`만 command 훅, 나머지(`Stop`/`Notification`/`SessionEnd`)는
  HTTP 훅.

## 5. 콘솔에서 직접 실행하면 `server.log`에 아무것도 안 남음

- **증상**: `npm start`(`node dist/server.js`)로 서버를 터미널에서 직접 띄워 디버깅할 때,
  `data/server.log`를 열어봐도 비어있거나 오래된 내용뿐이라 지금 무슨 일이 일어나는지 안 보임.
- **원인**: `data/server.log`에 로그가 쌓이는 경로는 `scripts/register.js`의
  `startServerDetached()`가 **백그라운드로** 서버를 기동할 때 그 자식 프로세스의 stdio를 로그
  파일로 리다이렉트하는 경우뿐이다. 터미널에서 `npm start`/`node dist/server.js`를 직접 실행하면
  출력이 그 콘솔 화면으로만 나가고 파일에는 기록되지 않는다.
- **해결**: 수동으로 포그라운드 실행해서 디버깅할 때는 그 콘솔 창의 출력을 직접 읽는다.
  `data/server.log`를 확인하는 트러블슈팅 방법은 `myade` 런처가 서버를 자동 기동한 경우에만
  유효하다는 걸 구분해서 알고 있어야 한다.

## 6. UTC vs KST 타임스탬프 착시

- **증상**: `pane_list`/`data/state.json`의 최신 `updatedAt`이 "어제 날짜"로 보여서, 방금 한
  테스트가 서버에 반영이 안 된 것처럼 보였다.
- **원인**: 저장되는 모든 타임스탬프는 UTC(ISO 8601, `Z` suffix)인데, 로컬(KST, UTC+9) 기준
  "오늘"과 그냥 문자열로 비교했다. 한국 시간 00시~09시 사이에는 UTC 날짜가 하루 전날짜로 찍히므로
  이 시간대에 착시가 발생하기 쉽다.
- **해결**: 날짜를 비교할 때는 로컬 타임존 오프셋(KST는 UTC+9)을 감안해서 판단한다. 서버/시스템
  시계 자체는 정상이었고 고칠 필요 없었다 — `date` 명령으로 UTC/로컬 시간을 나란히 확인해서
  착시임을 검증했다.

## 7. 손상된 세션(.jsonl)이 `claude` 실행을 조용히 막을 수 있음

- **증상**: (가상 시나리오로 검증됨) 특정 프로젝트 디렉터리에서 `claude`가 안 켜지거나
  `--resume`이 계속 실패하는 손상.
- **원인**: 요약 서브프로세스가 만약 원본 세션의 트랜스크립트 파일(`.jsonl`)에 직접 쓰다가
  타임아웃/강제 종료(`SIGKILL`)로 죽으면, 그 파일이 손상되어 이후 그 프로젝트에서 `claude`가
  트랜스크립트를 읽으려다 실패할 수 있다. 손상은 흔적 없이 일어나서 원인 추적이 어렵다.
- **해결**: `--fork-session`을 사용해 요약 세션이 항상 **새 session_id/파일로 분기**되게 한다.
  서브프로세스가 도중에 어떻게 죽어도 원본 `.jsonl`은 절대 건드리지 않는다 — 직접 검증: 요약
  서브프로세스를 생성 중간에 `SIGKILL`로 죽여도 원본 `.jsonl`의 해시가 그대로임을 확인했다.

## 8. Windows에서 `claude.cmd`에 프롬프트를 인자로 넘기면 깨짐

- **증상**: 컴패니언 잡담창(`myade-gui`)에서 메시지를 보내면
  `오류: claude 실행 실패 (PATH에 claude가 있는지 확인하세요): batch file arguments are invalid`.
- **원인**: `companion.rs`가 `claude` 바이너리를 못 찾을 때(ENOENT) `claude.cmd`로 재시도하는
  fallback을 옛 `claude.rs`(지금은 삭제됨)에서 그대로 가져왔는데, 그 fallback은 "실행파일을 못
  찾는" 문제만 해결하지 "자유 텍스트를 인자로 넘기는" 문제는 해결하지 못한다. `claude.cmd`는 npm
  글로벌 설치가 만드는 배치파일 셰임이라, Rust의 `Command`가 이를 직접 `CreateProcess`로 실행하면
  Windows가 내부적으로 인자를 배치파일 문법으로 다시 해석하는데, 자유 텍스트(특히 한글 등
  비-ASCII)가 인자에 섞이면 이 재해석이 깨진다. `persona.ts`는 애초에 이 문제를 피하려고 프롬프트를
  인자가 아니라 stdin으로 넘기는데, `companion.rs`를 처음 작성할 때 이 부분을 놓치고
  `.arg(prompt)`로 넘겼다.
- **해결**: 프롬프트는 CLI 인자로 절대 넘기지 않는다. `-p` 플래그만 넣고(뒤에 값 없이) 프롬프트
  텍스트는 자식 프로세스의 stdin에 써서 닫는다 — `claude -p`는 인자 없이 호출되면 stdin에서
  프롬프트를 읽는다. `persona.ts`의 `spawnOnce`와 `companion.rs`의 `run_turn`이 둘 다 이 방식이다
  (일반 원칙 참고).

## 9. `open_companion_window`가 sync 커맨드라 `.build()`가 메인 스레드를 기다리며 자기 자신과 데드락

- **증상**: "컴패니언 열기" 버튼을 누르면 새 창은 뜨지만 안이 완전히 빈 화면이고, 창 자체(타이틀바/
  닫기 버튼 포함)가 "응답 없음" 상태로 멈춘다.
- **원인**: `open_companion_window`가 일반 sync `fn`이었고, 그 안에서
  `WebviewWindowBuilder::build()`를 직접 호출했다. `.build()`는 실제 창/웹뷰 생성을 메인(GUI)
  스레드로 넘기고 블로킹 대기하는데, 이 커맨드 자체의 IPC 응답도 같은 메인 스레드의 이벤트 루프를
  거쳐야 해서, `.build()`가 그 큐를 막고 있는 채로 자기 자신의 응답을 기다리는 데드락이 났다.
- **해결**: 커맨드를 `async fn`으로 바꾸고, 실제 창 생성은 `app.run_on_main_thread(...)`로 명시적으로
  넘기되 `tokio::sync::oneshot` 채널로 결과만 비동기로 받는다 (`.build()`의 내부 블로킹 대기에
  의존하지 않음). Windows GUI 스레드 제약이 있는 작업(창 생성/조작)을 sync 커맨드에서 직접 호출하면
  이 문제가 재발할 수 있다 — 새 창을 만들거나 조작하는 커맨드는 항상 이 패턴을 쓸 것.

## 10. `tauri dev`의 파일 감시 재시작은 `ExitRequested`를 안 태워서 pane이 정리 안 됨 (개발 모드 한정)

- **증상**: `myade-gui` 개발 중(`npm run tauri dev`) Rust 파일을 수정할 때마다 앱이 재시작되는데,
  그때마다 `gui:*` 라벨 pane이 stage-1 서버에 새로 등록되고 이전 것들은 `status: "starting"`인
  채로 영원히 안 지워진다. 한 세션 동안 파일을 수십 번 고치면 `data/state.json`에 좀비 pane이
  수백 개까지 쌓인다 (2026-08-23, 멀티 pane 라운드에서 132개까지 쌓인 걸 실제로 확인).
- **원인**: pane 정리(`register_end_blocking`)는 `myade-gui/src-tauri/src/lib.rs`의
  `RunEvent::ExitRequested` 핸들러에서만 일어나는데, `tauri dev`의 파일 감시자가 재시작할 때는 이
  이벤트 없이 프로세스를 강제 종료(kill)한다.
- **해결 (2026-08-24 갱신)**: 서버 쪽에 시간 기준 GC를 넣어서 해결했다 (`src/state.ts`의
  `sweep()`). `updatedAt`이 `MYADE_STALE_PANE_HOURS`(기본 6시간)보다 오래된 `ended: false` pane은
  `gc:stale`로 종료 처리하고, 종료된 지 `MYADE_PANE_RETENTION_DAYS`(기본 7일)가 지난 레코드는
  아예 삭제한다. 서버 기동 직후 1회 + `list()` 호출마다 lazy하게 돌고, 뭔가 정리했으면
  `[state] gc: marked N stale, dropped M` 한 줄을 남긴다.
- **위 "원인"은 반쪽짜리였다 (같은 날 발견)**: 이 항목은 좀비 pane을 `tauri dev` 한정 문제로
  단정했지만 실제로는 그게 더 작은 쪽이었다. 진짜 큰 출처는 **`/hooks/session-end` 핸들러가
  `store`를 전혀 건드리지 않던 것** — `claude`가 정상 종료해도 pane이 `idle`/`ended: false`로
  영구히 남았고, 이건 개발 모드와 아무 상관이 없다. 실제로 쌓인 154개를 분해해보니 `starting`
  잔존(= 이 항목이 설명하는 경로)은 37개였고 `idle` 잔존은 72개였다. `pane_list`가 반환하던
  유령은 109개, 그중 6시간 이내에 갱신된 건 **0개**였다. 자세한 수정은 아래 12번 항목 참고.

## 11. pane을 빠르게 반복 열고 닫으면 이후 pane 생성 버튼이 무반응 (원인 미확인)

- **증상**: 여러 pane을 짧은 시간 안에 닫았다 열었다를 반복하면(특히 검증/테스트 중처럼 빠르게
  여러 번 반복하는 상황) 이후 pane 열기 버튼("+ 새 pane"/"+ pane 추가")이 완전히 반응하지 않게
  되는 현상이 관찰됐다. 이와 별개로 평상시에도(빠른 반복이 아니어도) 새 pane 생성 시 셸(cmd) 창이
  뜨는 속도가 다소 느린 편으로 관찰된다.
- **원인**: 아직 미확인. 10번 항목("`tauri dev` 파일 감시 재시작 시 `ExitRequested` 없이 pane이
  안 지워짐")과 같은 계열(PTY/프로세스 cleanup 관련)일 가능성이 있지만 확정된 건 아니다 — 10번은
  "개발 모드의 파일 감시 재시작"이라는 원인이 명확히 특정된 반면, 이번 건은 앱을 재시작하지 않고
  pane을 반복해서 열고 닫기만 해도 재현된다는 점에서 정말 같은 근본 원인인지는 별도 조사가
  필요하다.
- **재현 조건**: 여러 pane을 짧은 간격으로 닫았다 열었다 반복.
- **원인 (2026-08-24 조사)**: 같은 증상을 내는 결함이 **네 개** 있었고 넷 다 고쳤다. 1·2번이
  진짜 원인이고(1번 단독으로는 안 고쳐진다), 3·4번은 같은 증상을 낼 수 있던 별개 결함이다.
  1. **셸이 죽어도 `pty://exit`가 아예 발동하지 않았다 (Windows ConPTY).** `pty.rs`의 리더
     스레드는 `reader.read()`가 `Ok(0)`(EOF)을 반환할 때만 이 이벤트를 emit하는데, **ConPTY의
     출력 파이프는 마스터 핸들을 쥔 쪽이 있는 한 닫히지 않는다** — `PtyHandle`이 pane이 살아
     있는 내내 `master`를 들고 있으므로, 사용자가 `exit`를 쳐서 셸이 실제로 죽어도 그 read는
     그냥 영원히 블록된다. 그래서 셸은 죽고 터미널은 먹통인데 아무 이벤트도 안 나가고 셀은
     그대로 남는다. **EOF가 아니라 프로세스 자체를 기다려야 한다.**
  2. **그 이벤트를 소비하는 쪽도 없었다.** `TerminalPane.tsx`가 터미널에
     `[셸이 종료되었습니다]`만 찍을 뿐 `App.tsx`는 `pty://exit`를 듣지도 않았다. pane 엔트리가
     Rust 쪽 `state.panes`에 그대로 남고, daemon 등록도 살아있고, **캐릭터 슬롯이 영구
     소비된다**(`commands::spawn_pane`이 열린 pane에서 `taken`을 계산하므로). 몇 번 반복하면
     `max_pane_count()`(롤스터 크기, 기본 4)에 걸려 `create_pane`이 실패하기 시작한다.
  3. **`App.tsx::removePane`에 `catch`가 없었다.** `close_pane`이 실패하면 목록에서 제거하는
     줄이 통째로 스킵되어 죽은 pane 셀이 UI에 영구히 남고, 그 셀이 `atMax` 계산에 계속
     포함되어 "+ pane 추가"가 안내문만 띄우는 no-op이 된다.
  4. **daemon이 안 떠 있으면 pane 생성마다 2초를 그냥 버린다.** `pane.rs::register_start`가
     실패를 `.ok()?`로 통째로 삼켜서, "데몬이 없다"와 "정상"이 구분되지 않았다. 같이 기록된
     "새 pane 생성이 느리다"는 관찰은 이것으로 설명된다 — `create_pane`은 이 2초 타임아웃이
     끝나야 프론트에 응답한다.
- **해결**: (1) `spawn_shell`이 자식 프로세스를 `child.wait()`으로 기다리는 전용 스레드를 띄우고,
  거기서 `pty://exit`를 emit한다. 리더 스레드의 기존 EOF emit은 fallback으로 남겨뒀다(핸들이
  실제로 drop된 뒤엔 발동하고, 프론트가 이미 지운 pane에 대한 중복은 무시한다). `PtyHandle`은
  `Child` 대신 `clone_killer()`로 얻은 killer를 들고 있다 — 자식 소유권은 waiter 스레드에 있고,
  같은 락 뒤에 `Child`를 두면 `kill()`과 `wait()`이 서로 데드락한다. (2) `App.tsx`가
  `pty://exit`를 듣고 해당 pane을 `close_pane` 경로로 정리한다 (중복 트리거 처리는 아래
  "덤으로 나온 함정" 참고). (3) `removePane`이 실패해도
  `finally`에서 목록에서 제거하고 에러는 안내문으로 보여준다. (4)
  `register_start`/`register_end` 실패가 stderr에 남는다. 더불어 `close_pane`이 daemon pane id를
  **엔트리를 지우기 전에** 읽도록 순서를 바꿨다 — 예전엔 먼저 지우고 나중에 읽어서, 등록 해제가
  실패하면 그 id의 유일한 사본이 이미 사라진 상태였다.
- **덤으로 나온 함정 — 이벤트 dedupe를 React state에 기대면 안 된다**: pane 하나를 닫으면
  종료 트리거가 **세 번** 온다 (× 버튼 또는 셸 `exit` / waiter 스레드의 `pty://exit` / 핸들이
  drop된 뒤 리더 스레드가 쏘는 fallback `pty://exit`). 처음엔 이걸 ref 두 개로 걸렀는데
  갱신 시점이 서로 달랐다 — 하나는 `finally`에서 동기적으로, 다른 하나는 `useEffect`라 렌더
  커밋 이후에. 그 사이 창에 세 번째 트리거가 떨어지면 두 가드를 다 통과해서, 백엔드가 이미
  잊은 pane에 `close_pane`을 호출하고 **"pane을 닫는 중 문제가 발생했습니다: 알 수 없는
  pane입니다"** 안내문이 간헐적으로 떴다(셀 자체는 첫 호출이 이미 지워서 정상 동작했기 때문에
  증상이 안내문뿐이었다). 지금은 `livePaneIds` ref 하나만 동기적으로 유지하고 `removePane`
  진입부에서 `Set.delete`의 반환값으로 test-and-claim한다 — 먼저 도착한 호출만 이기므로
  `close_pane`은 pane당 정확히 1회 호출된다. **여러 소스에서 오는 이벤트를 dedupe할 땐 렌더
  타이밍에 의존하지 않는 동기 게이트 하나로 모을 것.**
- **교훈**: 2번만 고치고 "됐다"고 넘어갔다가 사용자가 바로 재현시켰다 — 이벤트를 **소비**하는
  쪽만 보고 그 이벤트가 애초에 **발동은 하는지**를 확인하지 않은 실수다. PTY/프로세스 종료를
  다룰 때 "파이프 EOF = 프로세스 종료"라는 가정은 Windows ConPTY에서 성립하지 않는다.
  (2026-08-24, 캐릭터 배정 셔플백 기능 검증 중 최초 관찰됨. 셔플백 로직 자체와는 무관한 별개
  버그다 — 배정 기능 자체는 정상 동작 확인됨. **2026-08-24 사용자 직접 확인 완료**: pane 안에서
  `exit` 시 셀이 사라지고 `(n/4)` 카운터가 줄어들며, 반복해도 안내문 없이 정상 동작.)

## 12. `SessionEnd` 훅이 pane을 종료 처리하지 않아 세션이 끝나도 `pane_list`에 남음

- **증상**: `claude`를 정상적으로 종료해도 그 pane이 `pane_list`에 `status: "idle"`로 계속
  보인다. 오래 쓸수록 누적되어, 실측 시점엔 `pane_list`가 유령 109개를 반환하고 있었다 —
  1단계 핵심 기능("다른 세션 지금 뭐 해?")이 사실상 못 쓰는 상태였다.
- **원인**: `src/server.ts`의 `/hooks/session-end` 핸들러가 페르소나 요약만 킥오프하고
  `store`를 **한 번도 건드리지 않았다**. `src/state.ts`에는 `onSessionEnd` 자체가 없었다. pane을
  종료 처리하는 경로는 런처(`myade.bat`)의 `/sessions/end`와 GUI의 `ExitRequested`뿐이었는데,
  둘 다 "터미널 창을 X로 닫는다 / 앱이 강제 종료된다"는 흔한 경우를 못 잡는다.
- **해결**: `SessionStore.onSessionEnd`를 추가해 `status: "stopped"`, `ended: true`,
  `lastEvent: "SessionEnd(<reason>)"`로 마킹한다. 종료 마킹은 `markEnded()` 한 곳으로 모아
  런처 종료/훅 종료/GC가 전부 같은 모양의 레코드를 남기게 했다.
- **같이 고친 것 두 가지**:
  - `/hooks/session-end`에만 `isSummaryInFlight(input.cwd)` 가드가 빠져 있었다. 그대로 뒀으면
    페르소나 요약 서브프로세스가 끝날 때 **자기가 요약하던 원본 세션의 pane을** 대신 종료
    처리했을 것이다 (나머지 세 훅 핸들러엔 원래 있던 가드다).
  - `resolvePaneForHook`이 `session_id` 일치로 pane을 찾을 때 `ended`를 안 내렸다. 종료 마킹이
    생긴 뒤로는 `--resume`으로 되살아난 세션이 `ended: true`인 채 `idle`로 남아 `pane_list`에서
    사라지는 모순이 되므로, 이 분기에서 `ended = false`로 명시적으로 되돌린다.
- **주의**: `reason`이 `"clear"`/`"resume"`일 때도(터미널 자체는 살아있는 경우) pane 레코드를
  종료 처리한다. 의도된 동작이다 — 다음 세션은 `resolvePaneForHook`을 통해 자기 레코드를 새로
  받고, 이걸 열어두면 아무도 닫아주지 않는 유령이 하나 생긴다.
