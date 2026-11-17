# myade-gui - 2단계: 멀티 pane 터미널 + 캐릭터 + 컴패니언

하나의 창 안에 실제 셸 pane이 여러 개 그리드로 동시에 뜹니다. pane이 열리는 즉시 다른 pane과 안
겹치는 캐릭터가 배정되어 헤더에 배지로 표시되고, 그 pane 셸의 환경변수(`MYADE_CHARACTER_ID`)로도
심어져서 나중에 그 안에서 실행하는 `claude`가 실제로 그 캐릭터 정체성을 알고 응답합니다(배지가 UI
장식에 그치지 않음). 별도 팝업 창에서는 캐릭터를 하나 골라 그 성격만 빌린 독립적인 잡담을 나눌 수
있습니다.

> 옛 구조(왼쪽 실제 터미널 + 오른쪽 Claude 채팅이 승인 카드를 거쳐 그 터미널을 원격 조종)는 이
> 라운드에서 완전히 폐기됐습니다. 배경/설계 결정은 [`../MULTI_PANE_ADE_PRD.md`](../MULTI_PANE_ADE_PRD.md),
> 겪은 문제와 해결은 [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)를 참고하세요.

1단계 myade 서버(`../myade`)는 그대로 백엔드로 재사용합니다 - 각 pane은 열릴 때 그 서버에 pane으로
등록되고, pane 안에서 실행한 `claude`는 (다른 터미널과 똑같이) 그 서버의 훅을 그대로 탑니다. 다른
터미널에서 `pane_list`로 조회할 수 있습니다.

## 구성 요소

- `src-tauri/` - Rust 백엔드 (Tauri v2)
  - `state.rs` - `AppState`가 pane 레지스트리(`HashMap<paneId, PaneEntry>`)와 컴패니언 세션 맵을 들고 있음
  - `pty.rs` - pane마다 독립된 실제 셸 프로세스 (portable-pty). 셸을 띄울 때 그 pane에 배정된 캐릭터 id를 `MYADE_CHARACTER_ID` 환경변수로 심어서 안에서 실행되는 `claude`(와 그 훅 서브프로세스)까지 상속되게 함
  - `characters.rs` - 캐릭터 롤스터(`~/.myade/characters/*.md`) 읽기/기본값 생성/배정 로직. 배정 자체는 `commands::spawn_pane`이 pane 생성 시점에 즉시 함 (예전엔 pane 출력에서 "Claude Code" 배너를 찾을 때까지 기다렸다가 사후에 배정했는데, 그러면 그 pane의 첫 `claude` 실행은 이미 `SessionStart` 훅이 끝난 뒤라 정체성을 주입할 방법이 없었음)
  - `companion.rs` - 컴패니언 팝업의 헤드리스 `claude -p` 턴 실행 (도구 전부 비활성화, cwd는 `~/.myade/companion` 고정)
  - `pane.rs` - 1단계 myade 서버에 pane 등록/해제
  - `commands.rs` - 프론트엔드가 호출하는 Tauri 명령들 (`init_app`/`create_pane`/`close_pane`/`list_panes`/`list_characters`/`open_companion_window`/`companion_send_message`/`pty_*`)
- `src/` - React 프론트엔드
  - `App.tsx` - 메인 창: pane 그리드(0개일 땐 `WelcomeScreen`), "+ pane 추가"/"컴패니언 열기" 툴바
  - `WelcomeScreen.tsx` - pane이 0개일 때(최초 실행 포함) 보여주는 화면. "+ 새 pane" 버튼 하나뿐
  - `TerminalPane.tsx` - pane 하나당 xterm.js 터미널
  - `CompanionApp.tsx` - 컴패니언 팝업 창의 캐릭터 선택 + 채팅 UI
  - `main.tsx` - 메인 창인지 컴패니언 창인지는 URL이 아니라 `getCurrentWindow().label`로 판단 (이유는 트러블슈팅 참고)

## 동작 방식 (요약)

1. 앱을 켜면(최초 실행이든 이후 실행이든) pane 없이 "+ 새 pane" 버튼만 있는 웰컴 화면으로 시작합니다. 이전 세션의 pane 구성을 기억해 자동으로 복원하지 않습니다 - 버튼을 눌러 폴더를 고르면 그 폴더에 pane이 열립니다.
2. pane이 열리는 즉시, 아직 다른 pane이 안 쓰고 있는 캐릭터가 배정되어 pane 헤더에 배지로 표시됩니다 (`claude`를 실행하기 전이라도). pane 개수는 캐릭터 롤스터 크기(`~/.myade/characters/*.md` 파일 수)로 제한되고, `~/.myade/characters/`에 파일을 추가하면 한도가 늘어납니다.
3. 각 pane은 진짜 셸(PowerShell)이고, 사람이 직접 명령을 치거나 `claude`를 실행합니다. 그 pane 안에서 실행한 `claude`는 배정된 캐릭터의 정체성(롤스터 파일 내용)과 그 캐릭터의 말투 선호(`~/.myade/persona-<characterId>.md`)를 `SessionStart` 훅으로 자동으로 전달받습니다 - 배지가 UI 장식에 그치지 않고 실제 응답에 반영됩니다.
4. "컴패니언 열기"를 누르면 별도 창이 뜨고, 캐릭터를 고르면 그 캐릭터의 성격(롤스터 파일 내용)을 반영한 독립적인 헤드리스 `claude -p` 대화가 시작됩니다. 이 대화는 어떤 프로젝트 pane과도 무관하며(도구 없음, cwd는 `~/.myade/companion` 고정), 캐릭터별로 대화가 따로 이어집니다(이 앱을 재시작하면 초기화됨). 말투 선호 파일은 pane과 동일하게 캐릭터별로 공유됩니다(`persona-<characterId>.md`) - 별도 배선이 필요 없습니다.

## 사전 준비 (Windows) - 처음이라면 시간이 좀 걸립니다

Tauri는 Rust와 시스템 웹뷰가 필요합니다. 순서대로:

1. **Rust 설치**: https://rustup.rs 에서 `rustup-init.exe`를 받아 실행 (기본 옵션으로 설치하면 됩니다). 설치 후 새 터미널에서 확인:
   ```
   rustc --version
   cargo --version
   ```
2. **Visual Studio Build Tools (C++ 워크로드)**: Rust가 Windows에서 링크할 때 필요합니다. https://visualstudio.microsoft.com/visual-cpp-build-tools/ 에서 받아 설치할 때 "Desktop development with C++" 워크로드를 선택하세요. (Visual Studio를 이미 쓰고 있다면 Visual Studio Installer에서 같은 워크로드를 추가하면 됩니다.)
3. **WebView2**: Windows 10/11에는 대부분 이미 설치되어 있습니다. 없다면 https://developer.microsoft.com/microsoft-edge/webview2/ 에서 "Evergreen Bootstrapper"를 받아 설치하세요.
4. **Node.js**: 1단계에서 이미 설치하셨을 겁니다 (`node -v`로 확인).

## 설치

```
cd myade-gui
npm install
```

## 실행

```
npm run tauri dev
```

처음 실행하면 Rust 쪽이 컴파일되느라 몇 분 걸립니다 (두 번째부터는 빠릅니다). 컴파일이 끝나면 창이 뜨고, 작업할 폴더를 고르라는 대화상자가 나옵니다.

## 검증 (2단계 완료 기준 체크)

1. 창이 뜨고 pane 2개가 그리드로 나란히 보이는지 확인. 각 pane에 직접 타이핑해서 평소처럼 명령을 실행해보세요.
2. "+ pane 추가"로 pane을 계속 늘려보세요. 열리는 즉시 각 pane에 서로 다른 캐릭터 배지가 뜨는지 확인 (캐릭터 롤스터 크기(기본 4)에 도달하면 버튼이 흐려지고, 눌러도 안내 메시지만 뜨는지도 확인).
3. 배지가 붙은 pane에서 `claude`를 실행하고 "넌 누구야?" 같은 질문을 해보세요. 배지에 표시된 캐릭터 이름/성격을 실제로 알고 응답하는지 확인 (배지만 UI에 있고 실제로는 모르는 회귀가 없는지가 핵심).
4. "컴패니언 열기"를 누르세요. 새 창에 캐릭터 목록이 뜨고, 하나를 골라 메시지를 보내면 그 캐릭터 성격이 반영된 응답이 오는지 확인 (한글 메시지 포함해서 테스트 - 트러블슈팅 8번 참고). 다른 캐릭터 탭으로 바꿔서 보내도 서로 섞이지 않는지 확인.
5. 다른 터미널 창에서 (1단계 launcher로) `myade`를 실행해 `pane_list`를 물어보면, 이 GUI 세션의 pane들도 `gui:<폴더이름>` 라벨로 목록에 나오고, 방금 띄운 launcher 세션도 정상 조회되는지 확인 (회귀 확인).
6. 앱을 완전히 껐다가 다시 켜서, 이전에 열려있던 pane들의 폴더 구성이 복원되는지 확인 (대화 내용/터미널 스크롤백은 복원되지 않습니다 - 아래 "알려진 한계" 참고).

## 알려진 한계 (MVP)

- **터미널 스크롤백/캐릭터 배정은 저장되지 않습니다**: 앱을 재시작하면 각 pane은 새로 시작합니다 (작업 폴더 구성만 기억합니다). 컴패니언의 캐릭터별 대화도 앱을 재시작하면 초기화됩니다.
- **배포용 설치 파일(.msi 등)은 만들지 않았습니다**: `npm run tauri dev`로 실행하는 개발 모드가 기본입니다. 개발 모드는 파일을 수정할 때마다 앱 전체가 재시작되는데, 이때 이전 pane들이 stage-1 서버에 좀비로 남는 특성이 있습니다 (배포 빌드에서는 발생하지 않음 - [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) 10번 항목).
- **pane 개수는 캐릭터 롤스터 크기로 제한됩니다**: `~/.myade/characters/`에 캐릭터 파일을 추가하면 한도가 늘어납니다. 롤스터가 pane 수보다 적어지면(파일을 지우면) 다음 실행 시 초과분 pane은 자동으로 안 열립니다.
- **문서 자체가 프로젝트 컨텍스트로 자동 로드됩니다**: 이 리포에서 pane을 열면 `CLAUDE.md`가 그 pane의 `claude`에게 프로젝트 컨텍스트로 자동 주입됩니다. 롤스터 캐릭터 실명을 "예전에 잘못된 identity였다"는 식으로 문서에 못박아두면, 정확히 그 이름으로 배정된 pane이 자기참조적으로 그 정체성을 거부하는 문제가 실사용 중 있었습니다 - 캐릭터 관련 버그 사례를 문서화할 땐 실명 대신 "캐릭터 A/B"처럼 익명화하세요 (`CLAUDE.md` 참고).
- **컴패니언은 프로젝트 작업 내용을 전혀 모릅니다**: 의도된 설계입니다 - 어떤 pane의 대화도 참조하지 않는 완전히 독립된 잡담입니다.

## 문제 해결

- **`claude 실행 실패`**: `claude` CLI가 PATH에 있는지 확인 (`claude --version`). 새 터미널에서 `npm run tauri dev`를 실행했는지도 확인하세요 (PATH 변경은 새 터미널부터 적용됩니다). 컴패니언 창에서 메시지 전송 시 `batch file arguments are invalid`가 뜨면 [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) 8번 항목 참고 (이미 고쳐진 문제지만, 새 headless `claude` spawn 코드를 추가할 때 같은 함정을 밟을 수 있습니다).
- **Rust 컴파일 오류**: 사전 준비 섹션의 Visual Studio Build Tools(C++ 워크로드)가 제대로 설치됐는지 확인하세요. `cargo --version`은 되는데 빌드가 실패한다면 대부분 이 문제입니다.
- **캐릭터 배지가 안 뜸**: pane 생성 시점에 즉시 배정되므로 `claude` 실행 여부와 무관합니다 - pane이 열렸는데도 배지가 없다면 `~/.myade/characters/`에 `.md` 파일이 있는지 확인하세요 (롤스터가 이미 꽉 찼어도 겹쳐서 재배정될 뿐 안 뜨지는 않습니다).
- **배지는 있는데 `claude`가 그 캐릭터를 모름**: pane 생성 후 그 셸에서 실행한 `claude`부터 `MYADE_CHARACTER_ID`를 상속받습니다 - 이미 실행 중이던 `claude`를 재시작하지 않고 그대로 쓰면 반영되지 않습니다. `/exit` 후 다시 `claude`를 실행해보세요. 그래도 안 되면 daemon(`../myade`)이 최신 빌드로 떠있는지, `data/server.log`에 `[persona]`/에러 로그가 있는지 확인하세요.
- **컴패니언 창이 비어 보이거나 "응답 없음"이 됨**: 알려진 두 가지 원인이 이미 고쳐져 있습니다 - URL 해시 라우팅 문제와 창 생성 sync 커맨드 데드락 ([`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) 9번 항목). 최신 코드인데도 재현되면 새로운 문제이니 자세히 기록해두세요.
- **`pane_list`에 안 쓰는 pane이 계속 쌓임**: 개발 모드(`tauri dev`) 특유의 문제입니다 - [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) 10번 항목 참고.
