# myade-relay

> **English summary.** Two stopped experiments from my first months of building with coding agents, kept as a record. **myade** tried to be a personal agent workspace: a session-status MCP server, persona memory and a multi-pane Tauri terminal with characters. It grew beyond what I could control and was stopped. **relay** kept only the core, passing short requests between Claude Code and Codex sessions started through relay with a receipt-based state machine. It worked with real CLIs, but was paused: there was no evidence yet that the benefit outweighed the setup cost, and vendor features started to overlap. The lessons led to [baton](https://github.com/chang406/baton), which drops the server entirely and hands work across sessions with files and Git. Docs are in Korean.

바이브 코딩을 처음 접하고 몇 달 동안 만든 실험 두 개를 기록으로 남긴 저장소다. 둘 다 개발을 멈췄다. 코드와 당시 문서는 그대로 두었고, 무엇을 했고 왜 멈췄는지는 각 폴더의 회고에 적었다.

| 폴더 | 기간 | 한 줄 | 회고 |
| --- | --- | --- | --- |
| [myade/](myade) | 2026-08(또는 그 전) ~ 09-14 | 세션 상태 서버 + 페르소나 + 멀티 pane 터미널 앱 | [RETROSPECTIVE.md](myade/RETROSPECTIVE.md) |
| [relay/](relay) | 2026-09-14 ~ 09-23 | relay로 띄운 Claude Code·Codex 세션 사이 요청 전달 | [RETROSPECTIVE.md](relay/RETROSPECTIVE.md) |

## 덜어 낸 순서

**1. myade: 다 넣어 봤다.**
- **시작.** 공부 전에 책상부터 정리하듯, 에이전트로 일할 작업 환경부터 만들어 쓰고 싶었다. 출발점은 터미널을 여러 개 띄워도 Claude 세션끼리 서로를 모른다는 불편이었다.
- **커진 과정.** 상태를 조회하는 서버에서 시작해, 캐릭터별 말투 기억과 한 창에 여러 터미널을 띄우는 데스크톱 앱, 캐릭터와 잡담하는 창까지 붙였다.
- **멈춘 이유.** 프로세스·동시성 같은 개념을 모른 채 자연어로 이것저것 맡기다 보니 작업이 여러 갈래로 갈라졌다. 규모는 크지 않았지만(코드 4천여 줄) 내가 이해하고 확인하는 속도보다 훨씬 빨리 불어났다.

**2. relay: 핵심만 남겼다.**
- **덜어 낸 것.** 그래도 미련이 남아 "세션 간 요청"이라는 생각만 가져와 새로 짰다. 캐릭터, 페르소나, 데스크톱 앱을 처음부터 범위 밖에 뒀다.
- **된 것.** 실제 Claude Code와 Codex 사이에서 요청을 보내고 답을 회수하는 데까지 확인했다.
- **멈춘 이유.** 09-15에, 동작은 하지만 설정 부담에 비해 이득이 크다는 근거가 없다고 보고 멈췄다. "기술 검증 성공을 제품 편의성 검증 성공으로 해석하지 않는다"고 적었다. 09-23에 다시 비교했을 때는 같은 기능이 Claude Code와 Codex에 들어오고 있어 중단을 유지했다.

**3. baton: 서버를 없앴다.**
- 같은 시간에 두 세션을 잇는 대신, 다른 시간에 이어받는 문제로 바꿨다. 한도에 걸려 끊겼을 때, 도구를 바꿨을 때, 다음 날 이어서 할 때다.
- 서버 없이 파일과 Git으로 푼다. → [chang406/baton](https://github.com/chang406/baton)

## 그사이 배운 것

두 프로젝트에 걸친 것만 적는다. 나머지는 각 회고의 "지금 다시 본다면"에 있다.

- **범위에는 상한이 필요하다.** 단계마다 "하지 않을 것"을 적었지만, 다음 단계에서 차례로 다 가져왔다. 덜어 낼수록 동작을 확인하기 쉬웠다.
- **"됐다"는 실제로 돌려서 확인한다.** myade에서는 확인을 건너뛴 자리에서 사고가 났고, relay에서는 시험이 통과해도 실제 CLI에서만 드러나는 버그가 있었다.
- **자동 처리를 그대로 믿지 않는다.** 처음부터 `.gitignore`만 믿지 않고, 고정 제외 목록을 더한 백업 스크립트를 따로 만들어 썼다([extras/SafeBackup.ps1](extras/SafeBackup.ps1)). 이 습관은 이후 baton에서도 이어졌다.

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
