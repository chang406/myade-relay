# agent-experiments

> **English summary.** Two abandoned experiments from my first months of building with coding agents, kept as a record. **myade** tried to be a personal agent workspace: a session-status MCP server, persona memory and a multi-pane Tauri terminal with characters. It grew beyond what I could control and was stopped. **relay** kept only the core, passing short requests between live Claude Code and Codex sessions with a receipt-based state machine. It worked with real CLIs, but was paused because the setup cost outweighed the benefit and vendor features started to overlap. The lessons led to [baton](https://github.com/chang406/baton), which drops the server entirely and hands work across sessions with files and Git. Docs are in Korean.

바이브 코딩을 처음 접하고 몇 달 동안 만든 실험 두 개를 기록으로 남긴 저장소다. 둘 다 개발을 멈췄다. 코드와 당시 문서는 그대로 두었고, 무엇을 했고 왜 멈췄는지는 각 폴더의 회고에 적었다.

| 폴더 | 기간 | 한 줄 | 회고 |
| --- | --- | --- | --- |
| [myade/](myade) | 2026-08 ~ 09-14 | 세션 상태 서버 + 페르소나 + 멀티 pane 터미널 앱 | [RETROSPECTIVE.md](myade/RETROSPECTIVE.md) |
| [relay/](relay) | 2026-09-14 ~ 09-23 | 열린 Claude Code·Codex 세션 사이 요청 전달 | [RETROSPECTIVE.md](relay/RETROSPECTIVE.md) |

## 덜어 낸 순서

**1. myade: 다 넣어 봤다.**
- **시작.** 공부 전에 책상부터 정리하듯, 에이전트로 일할 작업 환경부터 만들어 쓰고 싶었다. 출발점은 터미널을 여러 개 띄워도 Claude 세션끼리 서로를 모른다는 불편이었다.
- **커진 과정.** 상태를 조회하는 서버에서 시작해, 캐릭터별 말투 기억과 한 창에 여러 터미널을 띄우는 데스크톱 앱, 캐릭터와 잡담하는 창까지 붙였다.
- **멈춘 이유.** CS 기초가 부족한 채로 자연어로 이것저것 맡기다 보니 작업이 여러 갈래로 갈라졌다. 규모는 감당하기 어려울 만큼 빨리 불어났다.

**2. relay: 핵심만 남겼다.**
- **덜어 낸 것.** 그래도 미련이 남아 "세션 간 요청"만 떼어 냈다. 캐릭터, 페르소나, 데스크톱 앱을 처음부터 범위 밖에 뒀다.
- **된 것.** 실제 Claude Code와 Codex 사이에서 요청을 보내고 답을 회수하는 데까지 확인했다.
- **멈춘 이유.** 동작했지만, 시작하는 데 드는 설정이 매번 무거웠다. 같은 기능이 Claude Code와 Codex에 들어오기 시작했다. "기술 검증 성공을 제품 편의성 검증 성공으로 해석하지 않는다"고 적고 멈췄다.

**3. baton: 서버를 없앴다.**
- 같은 시간에 두 세션을 잇는 대신, 다른 시간에 이어받는 문제로 바꿨다. 한도에 걸려 끊겼을 때, 도구를 바꿨을 때, 다음 날 이어서 할 때다.
- 서버 없이 파일과 Git으로 푼다. → [chang406/baton](https://github.com/chang406/baton)

## 그사이 배운 것

- **덜어 낼수록 끝까지 갔다.** 기능을 더할 때보다 뺄 때 동작하는 것이 남았다.
- **에이전트에게 맡길수록 구조를 먼저 정해야 한다.** 구조 없이 자연어로 덧붙이면 작업이 갈라지고 규모가 불어난다.
- **"됐다"는 실제로 돌려서 확인한다.** 시험이 통과해도 실제 CLI에서만 드러나는 문제가 있었다.
- **조용한 실패는 흔적을 남기게 한다.** 훅과 서브프로세스가 아무 말 없이 실패하는 일을 여러 번 겪었다.
- **자동 처리를 그대로 믿지 않는다.** 처음부터 에이전트의 `.gitignore` 처리를 믿지 않고, 민감 파일을 빼고 압축하는 백업 스크립트를 따로 만들어 썼다([extras/SafeBackup.ps1](extras/SafeBackup.ps1)). 이 습관이 baton의 비밀값 검사와 "멈추고 묻기"로 이어졌다.
- **동작한다고 계속할 이유가 되지는 않는다.** 플랫폼이 같은 기능을 넣기 시작하면, 직접 만든 것의 몫은 빠르게 줄어든다.

## 실행해 보려면

Node.js 20 이상.

```bash
cd relay && npm ci && npm test
```

```bash
cd myade && npm ci && npm test
```

relay 시험 16개와 myade 서버 시험 8개가 통과한다(보관 시점, Linux). 실제 세션 간 왕복은 Claude Code와 Codex CLI가 있어야 한다. myade 데스크톱 앱(`myade/myade-gui/`)은 Windows에서 Tauri 개발 모드로만 확인했다.

## 라이선스

[MIT](LICENSE)
