# myade - 개인 ADE(Agentic Development Environment)

> **보관: 2026-08~09 실험, 개발 중단.** 아래 문서는 모두 당시 기준이라 지금과 맞지 않는 문장(시험 수, 이미 지운 기능 등)이 있다. 무엇을 했고 왜 멈췄는지는 [RETROSPECTIVE.md](RETROSPECTIVE.md)에 있다. 데스크톱 앱(`myade-gui/`)은 Windows에서 Tauri 개발 모드로만 확인했다.

## 2026-09-14 재개

현재 방향은 **실제 Claude/Codex 터미널을 유지하는 범용 개인 작업 공간**입니다.
[분석·업데이트 내역·새 PRD·구현 계획](docs/RESTART_PRD.md)을 먼저 확인하세요.

- 기존 Tauri/PTY와 캐릭터·컴패니언을 재사용합니다.
- 정확한 pane ID 연결과 `exchange_send/list/receive/reply/collect/cancel` MCP 도구를 추가했습니다.
- 수신/회수는 agent의 명시적 도구 호출 방식입니다. 대기 중인 CLI 자동 wake-up은 아직 없습니다.
- 검증: 루트 `npm test`. 두 MCP 클라이언트의 실제 요청 왕복을 포함합니다.
- 사용하려면 서버 재시작 및 CLI MCP 도구 목록 갱신이 필요합니다. 사용자 설정은 자동 변경하지 않았습니다.

아래는 기존 설치·기능 설명입니다. 새 상태와 충돌하면 위 PRD를 우선합니다.

여러 터미널에서 각각 `claude`를 띄워도, 한 세션이 "다른 세션은 지금 뭐 하고 있어?"를 도구 호출로 물어볼 수 있게 해주는 개인용 프로젝트입니다. 자세한 배경/스펙은 [`ADE PROJECT.md`](./ADE%20PROJECT.md) 참고.

단계별로 진행 중입니다:

- **1단계 (이 폴더 루트) - 세션 상태 조회 MCP 서버**: 완료. 아래 내용이 전부 이 단계에 대한 설명입니다.
- **2단계 ([`myade-gui/`](./myade-gui)) - 멀티 pane 터미널 + 캐릭터 + 컴패니언**: MVP 완료 (개발 모드). 하나의 창 안에 여러 개의 실제 셸 pane이 그리드로 동시에 뜨고, 각 pane에서 `claude`를 실행하면 안 겹치는 캐릭터가 자동 배정되며, 별도 팝업에서 캐릭터를 골라 잡담할 수 있는 Tauri 데스크톱 앱입니다. 왼쪽 터미널/오른쪽 승인 카드 채팅이던 옛 구조는 이번 라운드에서 완전히 폐기됐습니다 (배경은 [`MULTI_PANE_ADE_PRD.md`](./MULTI_PANE_ADE_PRD.md) 참고). 1단계 서버를 백엔드로 그대로 재사용합니다. 설치/실행/검증 방법은 [`myade-gui/README.md`](./myade-gui/README.md) 참고.

## 구성 요소 (1단계)

- `src/` - MCP 서버 본체 (TypeScript, 공식 `@modelcontextprotocol/sdk` 사용)
  - `state.ts` - 세션(pane) 상태 저장/조회 로직 (MCP와 무관, 2단계에서 그대로 재사용)
  - `tools.ts` - MCP 도구 정의: `pane_list`, `pane_status`, `pane_ping`
  - `persona.ts` - 페르소나 레이어: 캐릭터별 `~/.myade/persona-<characterId>.md` 읽기/append, `SessionEnd` 시 백그라운드로 세션을 `--resume --fork-session`해(원본 세션 파일은 건드리지 않음) 말투/선호를 요약. myade-gui 캐릭터 pane/컴패니언 전용 기능이라 캐릭터가 없는 세션(아래 "동작 방식" 참고)에는 적용되지 않음
  - `server.ts` - Express 서버. `/mcp`(MCP), `/hooks/*`(훅 수신), `/sessions/*`(런처 등록)를 모두 하나의 프로세스에서 서빙
  - `types.ts` - 공용 타입 정의
- `scripts/myade.bat`, `scripts/myade.sh` - `claude` 대신 실행하는 런처. 서버가 안 떠있으면 띄우고, 세션 시작/종료를 서버에 알린 뒤 `claude`를 실행
- `scripts/register.js` - 런처가 호출하는 실제 로직 (서버 기동 확인/자동 시작, 등록 HTTP 호출)
- `scripts/session-start-hook.js` - `SessionStart` 훅 전용 `type: "command"` 래퍼. Claude Code가 `SessionStart`에는 `type: "http"` 훅을 지원하지 않아서(다른 이벤트와 다름, 아래 참고) 필요함. stdin으로 받은 훅 JSON을 그대로 `/hooks/session-start`로 POST하고 응답을 stdout으로 돌려줄 뿐, 로직은 없음
- `claude-config/settings.snippet.json` - Claude Code 훅 설정에 병합할 스니펫
- `data/` - 서버가 pane 상태를 기록하는 `state.json`과 `server.log` (둘 다 git에는 커밋되지 않음)
- `~/.myade/persona-<characterId>.md` (리포 바깥, 사용자 홈 하위, 캐릭터별로 하나씩) - 세션 종료마다 누적되는 그 캐릭터의 말투/선호 메모. 리포 위치와 무관하게 전역으로 유지됨. **`~/.myade` 등 리포 바깥의 사용자 데이터 디렉터리는 테스트 정리 목적이라도 사용자 확인 없이 삭제하지 않습니다** (과거 검증용 데이터를 지우다가 실사용 로그까지 함께 날아간 사고가 있었음 - [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 2번 참고)
- `dist/` - `npm run build`(tsc) 결과물

## 동작 방식 (요약)

1. `myade`를 실행하면 서버(`node dist/server.js`, 기본 포트 4317)가 안 떠있을 경우 자동으로 백그라운드로 기동됩니다.
2. 런처가 서버에 "세션 시작"을 등록하고, 그 다음 실제 `claude`를 실행합니다.
3. Claude Code의 `Stop` / `Notification` / `SessionEnd` 훅은 **직접 HTTP POST**로 서버에 이벤트를 보냅니다 (Claude Code의 `type: "http"` 훅 기능을 그대로 사용 - 화면 파싱이나 셸 스크립트가 필요 없습니다). `SessionStart`만 예외입니다: Claude Code 클라이언트가 이 이벤트에 한해 `type: "http"` 훅을 지원하지 않고 조용히 건너뛰기 때문에(디버그 로그로 확인됨), `scripts/session-start-hook.js`를 `type: "command"`로 등록해 같은 엔드포인트(`/hooks/session-start`)에 대신 POST해줍니다 - 서버 쪽 로직은 동일합니다. 결과적으로 훅 등록은 **`SessionStart`만 command, 나머지는 전부 http인 비대칭 구조**입니다 - 새 훅을 추가할 때 이 비대칭을 잊지 말 것.
4. 서버는 훅이 보낸 `cwd`를 이용해 어떤 pane(터미널)의 이벤트인지 찾아 상태를 갱신합니다.
5. 어느 세션에서든 `pane_list` / `pane_status` MCP 도구를 호출하면, 서버가 메모리(+`data/state.json` 파일)에 들고 있는 전체 pane 목록/상태를 돌려줍니다.
6. **페르소나 레이어 (myade-gui 캐릭터 pane/컴패니언 전용)**: myade-gui가 pane의 셸 프로세스에 `MYADE_CHARACTER_ID` 환경변수를 심어두면(그 안에서 실행된 `claude`까지 상속됨) `scripts/session-start-hook.js`가 이걸 훅 JSON에 얹어 보내고, `SessionStart` 훅 응답에 그 캐릭터의 `~/.myade/persona-<characterId>.md` 내용을 컨텍스트로 실어 보내 새 세션이 이전에 기록된 말투/선호를 바로 알 수 있게 합니다. 세션이 완전히 끝나면(`SessionEnd` 훅, 매 턴이 아니라 세션당 1회) 서버가 백그라운드로 그 세션을 `claude -p --resume --fork-session`으로 다시 불러 "이번 세션에서 말투/선호가 새로 드러났으면 한 줄, 아니면 SKIP"을 물어보고, SKIP이 아니면 같은 캐릭터 파일에 append합니다. `--fork-session` 덕분에 이 재요약은 항상 새 세션으로 분기되고 원래 세션의 대화 파일은 절대 건드리지 않습니다(강제 종료돼도 마찬가지). 이 과정은 사용자에게 보이지 않고, 실패해도 원래 세션에는 아무 영향이 없습니다. **캐릭터 없는 세션(예: myade-gui를 거치지 않고 `myade` 런처로 직접 띄운 일반 터미널)은 이 레이어의 대상이 아닙니다** - 공용 폴백 파일이 없으므로 `data/server.log`에 `[persona] readPersona: expected a valid characterId...` 로그만 남고 아무것도 기록/주입되지 않습니다. pane_list/pane_status 등 1단계의 다른 기능(아래 "검증" 1-5번)은 캐릭터와 무관하게 그대로 동작합니다.

---

## 설치 순서

### 0. 사전 확인

터미널(cmd 또는 PowerShell)에서:

```
node -v
npm -v
claude --version
```

세 명령 모두 정상적으로 버전이 출력되어야 합니다. Node.js는 18 이상을 권장합니다.

### 1. 의존성 설치 및 빌드

이 폴더(`myade`)에서:

```
npm install
npm run build
```

`dist/` 폴더가 생기면 성공입니다. 서버가 잘 뜨는지 한 번 수동으로 확인해보세요:

```
npm start
```

다른 터미널을 하나 더 열고:

```
curl http://127.0.0.1:4317/health
```

`{"ok":true,...}` 가 나오면 정상입니다. 확인했으면 `npm start` 를 실행한 창은 Ctrl+C로 꺼도 됩니다 (앞으로는 `myade` 런처가 알아서 서버를 띄워줍니다).

### 2. 런처를 PATH에 등록

`scripts` 폴더를 PATH에 추가하거나, `scripts\myade.bat`을 이미 PATH에 있는 폴더로 복사하세요.

PowerShell에서 현재 사용자 PATH에 추가하는 예시 (한 번만 실행, 이후 새 터미널부터 적용):

```
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\path\to\myade\scripts", "User")
```

새 cmd/PowerShell 창을 열어서 `myade`만 입력했을 때 (아직 훅/MCP 등록 전이라 에러가 나도 괜찮습니다) 명령어 자체는 인식되는지 확인하세요.

### 3. Claude Code에 MCP 서버 등록

```
claude mcp add --transport http myade http://127.0.0.1:4317/mcp --scope user
```

`--scope user`로 등록하면 어떤 프로젝트 폴더에서 `claude`를 열든 이 서버에 연결됩니다. 확인:

```
claude mcp list
```

목록에 `myade`가 보이고 연결 가능 상태인지 확인하세요 (서버가 떠있어야 확인됩니다 - 1번 단계에서 `npm start`로 켜두거나, 먼저 `myade` 런처를 한 번 실행해서 서버를 띄운 뒤 확인해도 됩니다).

### 4. 훅 등록

`%USERPROFILE%\.claude\settings.json` 파일을 여세요 (없으면 새로 만드세요. `%USERPROFILE%`은 보통 `C:\Users\<사용자 이름>` 입니다).

파일이 비어있다면 `claude-config/settings.snippet.json`의 내용을 그대로 복사해 넣으면 됩니다.

이미 `hooks` 항목이 있다면, `SessionStart` / `Stop` / `Notification` 배열 안에 스니펫의 항목을 **추가**하세요 (기존 항목을 지우지 말고 병합). 예를 들어 이미 이런 파일이 있다면:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo hi" }] }
    ]
  }
}
```

스니펫을 병합하면:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo hi" }] },
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:\\path\\to\\myade\\scripts\\session-start-hook.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [ ... 스니펫의 Stop 항목 ... ],
    "Notification": [ ... 스니펫의 Notification 항목 ... ],
    "SessionEnd": [ ... 스니펫의 SessionEnd 항목 ... ]
  }
}
```

`SessionStart`만 `type: "command"`인 이유는 위 "동작 방식" 3번 참고. `command`의 경로는 이 리포를 클론한 실제 절대 경로로 바꿔야 합니다 (`C:\path\to\myade` 부분을 실제 클론 경로로 수정).

`SessionEnd`는 페르소나 레이어(말투/선호 기억)에 쓰이는 새 훅입니다. 이것도 빠뜨리지 말고 병합하세요.

저장한 뒤 `claude` 세션 안에서 `/hooks` 를 입력하면 등록된 훅 목록을 확인할 수 있습니다.

---

## 검증 (1단계 완료 기준 체크)

1. 새 cmd 창을 하나 열고 아무 프로젝트 폴더로 이동한 뒤 `myade` 실행. `claude`가 정상적으로 뜨면 성공. (뒤에서 서버가 자동으로 켜졌는지 궁금하면 다른 창에서 `curl http://127.0.0.1:4317/debug/panes` 로 확인 가능)
2. 그 세션에서 아무 질문이나 하나 던져서 답을 받아보세요 (`Stop` 훅이 발동됩니다).
3. cmd 창을 하나 더 열고, 다른 프로젝트 폴더에서 `myade`로 두 번째 `claude` 세션을 띄우세요.
4. 두 번째 세션에서 이렇게 물어보세요: **"다른 Claude 세션들 지금 뭐 하고 있는지 확인해줘"** - Claude가 `pane_list` 또는 `pane_status` 도구를 호출해서, 첫 번째 세션의 폴더/상태를 정확히 알려주면 성공입니다.
5. (선택) 세 번째 창까지 띄워서 세 개가 모두 보이는지 확인.
6. (페르소나 레이어 - myade-gui 전용) 위 1-5번은 캐릭터 없는 일반 `myade` 터미널 세션으로도 검증되지만, 페르소나 레이어 자체는 myade-gui 캐릭터 pane/컴패니언이 있어야 확인할 수 있습니다 - [`myade-gui/README.md`](./myade-gui/README.md)의 검증 절 참고.

문제가 있으면 `curl http://127.0.0.1:4317/debug/panes` 로 서버가 실제로 무엇을 알고 있는지 원시 JSON으로 볼 수 있습니다. MCP 연결 자체가 안 되는 것 같으면 `claude mcp list`와 `/hooks`(세션 안에서) 결과를 같이 알려주세요.

---

## 트러블슈팅

> 설치/설정 관련 문제는 아래를 참고하세요. 개발 과정에서 겪은 더 근본적인 함정(설계/구현
> 단계에서 발견된 버그와 그 대응)은 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)에 따로 정리되어
> 있습니다.

- **포트 충돌 (4317이 이미 사용 중)**: 시스템 환경변수 `MYADE_PORT`를 다른 값(예: 4318)으로 설정하고, `settings.snippet.json`과 `claude mcp add`의 URL도 같은 포트로 맞춰주세요.
- **서버가 안 켜짐**: `myade` 런처가 백그라운드로 자동 기동한 경우에만 `data\server.log` 파일에 에러가 남습니다. `npm start`/`node dist\server.js`로 터미널에서 직접(포그라운드로) 실행한 경우에는 로그 파일이 아니라 그 콘솔 화면에 에러가 그대로 출력됩니다 - 파일에 아무것도 없다고 서버에 문제가 없다는 뜻은 아닙니다 ([`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 5번 참고).
- **훅은 등록했는데 상태가 안 바뀜**: 서버가 실제로 떠있는지(`curl .../health`) 먼저 확인하세요. 훅 호출은 실패해도 Claude Code 동작을 막지 않으므로 조용히 무시될 수 있습니다.
- **새 세션에 페르소나 내용이 안 실림 (`SessionStart`만 안 됨)**: `scripts/session-start-hook.js`는 실패해도 항상 exit 0 + 빈 stdout으로 넘어가 세션 시작 자체를 막지 않지만, 실패 사유는 stderr에 `[myade:session-start-hook]`로 시작하는 한 줄로 남깁니다. `claude --debug hooks`(또는 세션 안에서 `/hooks`)로 이 훅의 stderr 출력을 확인하세요. 흔한 원인: 서버 미기동(`ECONNREFUSED` 메시지로 표시됨), `settings.json`의 `command` 경로가 실제 클론 위치와 다름, PATH에 `node`가 없는 셸에서 훅이 실행됨. **캐릭터 없는 세션(myade-gui를 거치지 않은 일반 터미널)이라면 이건 버그가 아니라 정상입니다** - 페르소나 레이어는 이제 캐릭터 전용이라 아무것도 주입할 게 없습니다.
- **`myade`가 명령어로 인식 안 됨**: PATH 등록 후 새 터미널 창을 열었는지 확인하세요 (기존 창에는 반영되지 않습니다).
- **세션이 끝났는데 `persona-<characterId>.md`가 안 늘어남**: 소소한 세션(단순 질의응답 등)은 옵트아웃되어 아무것도 기록되지 않으니 정상일 수 있습니다. `data/server.log`에 `[persona]`로 시작하는 로그가 있는지 확인하세요. 요약용 백그라운드 `claude -p --resume` 호출이 실패해도 원래 세션에는 영향을 주지 않습니다. 로그가 `[persona] readPersona: expected a valid characterId...`라면 그 세션에 애초에 캐릭터가 없었다는 뜻입니다(myade-gui 밖에서 실행됨) - 이것도 정상입니다.

---

## 다음 단계

1단계 검증이 끝났다면 [`myade-gui/`](./myade-gui)에서 2단계(멀티 pane 터미널 + 캐릭터 자동배정 + 컴패니언 잡담 팝업)를 진행합니다. MVP는 개발 모드(`npm run tauri dev`)로 구현/검증까지 끝났고, 배포용 설치 파일(.msi 등) 빌드는 아직 하지 않았습니다. 자세한 설치/검증/알려진 한계는 [`myade-gui/README.md`](./myade-gui/README.md)를 참고하세요.
