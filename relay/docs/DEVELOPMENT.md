# Development

## 요구 사항

- Node.js 20 이상
- npm
- 실제 통합 검증 시 Claude Code와 Codex CLI

2026-09-14 실험 환경에서는 Claude Code 2.1.218, Codex CLI 0.154.0을 사용했다. 버전이 바뀌면 먼저 `--version`과 관련 `--help`를 확인하고 검증 문서에 기록한다.

## 설치와 기준선

```powershell
npm install
npm test
```

`npm test`는 TypeScript build 후 `tests/*.test.cjs`를 Node test runner로 실행한다. 현재 기준선은 16개 통과다. 설치 시 audit 경고가 보이더라도 dependency를 강제 변경하기 전에 영향과 호환성을 검토한다.

## 서버 실행

개발 데이터는 별도 폴더에 둔다.

```powershell
npm start -- --data-dir .relay/dev --port 4318
```

또는 build 결과를 직접 실행한다.

```powershell
node dist/src/cli.js serve --data-dir .relay/dev --port 4318
```

확인:

```powershell
Invoke-RestMethod http://127.0.0.1:4318/health
node dist/src/cli.js sessions
```

환경 변수는 `RELAY_BASE`, `RELAY_PORT`, `RELAY_DATA_DIR`, `RELAY_CODEX_BIN`을 지원한다. command flag가 있으면 해당 값을 우선 사용한다.

## 세션 등록과 실행

수동 등록:

```powershell
node dist/src/cli.js register --provider claude --id claude-main --cwd C:\work\project
node dist/src/cli.js register --provider codex --id codex-main --thread CODEX_THREAD_ID --binary C:\path\to\codex.exe --cwd C:\work\project
```

interactive launcher:

```powershell
node dist/src/cli.js launch --provider claude --id claude-main --binary C:\path\to\claude.exe --cwd C:\work\project
node dist/src/cli.js launch --provider codex --id codex-main --thread CODEX_THREAD_ID --binary C:\path\to\codex.exe --cwd C:\work\project
```

`--thread`를 생략한 Codex launch는 loopback WebSocket App Server에 TUI를 연결하고 공식 `thread/started` notification으로 새 thread를 자동 등록한다.

명시적 retry:

```powershell
node dist/src/cli.js retry --session SOURCE_SESSION --request REQUEST_ID --direction request
node dist/src/cli.js retry --session TARGET_SESSION --request REQUEST_ID --direction answer
```

request retry는 source, answer retry는 target만 요청할 수 있다. retry 요청은 JSON에 보존되고 다음 실제 transport attempt가 소비한다.

실행 전 진단:

```powershell
node dist/src/cli.js doctor --claude C:\path\to\claude.exe --codex C:\path\to\codex.exe --session planned-session --data-dir .relay\dev --runtime-dir .relay\runtime
```

`doctor`는 설정 변경이나 permission 승인 없이 Relay, CLI 기능, 경로와 등록 상태만 검사한다.

launcher 뒤에 provider 추가 인자를 둘 수 있다. Relay가 permission 우회 인자를 기본으로 넣어서는 안 된다.

## 자동 테스트가 보장하는 것

- stdio MCP adapter가 설정된 session identity를 사용함
- exchange 정상 상태 전이와 ownership 거부
- cross-workspace opt-in
- Codex queue 성공이 receipt가 아닌 attempt만 기록함
- Codex delivery 실패가 2회에서 멈춤
- 명시적 retry의 방향별 ownership, 완료 상태 차단, 기존 JSON 호환과 attempt trigger 기록
- Claude launcher가 일반 permission 흐름을 유지함
- Codex launcher가 정확한 thread를 재개하고 approval을 우회하지 않음
- 새 Codex TUI가 remote App Server lifecycle로 thread를 생성할 수 있음
- doctor의 정상/실패/경고 판정
- 독립 포트의 HTTP 왕복

자동 테스트는 실제 provider UI wake-up이나 모델의 MCP 호출을 보장하지 않는다.

## 실제 P0 검증 절차

1. 새 `.relay/verification-<date>` 폴더와 사용하지 않는 loopback 포트로 server를 실행한다.
2. `claude --version`, `claude --help`, `codex --version`, 관련 queue/MCP help를 저장한다.
3. 알려진 Codex thread를 launcher로 재개한다.
4. Claude를 launcher로 열고 `/mcp` 또는 provider UI에서 Relay 도구 연결을 확인한다.
5. Claude가 `relay_send`를 호출하게 한다.
6. JSON/API에서 먼저 `queued`, transport 후 `delivery_attempted`를 확인한다.
7. Codex가 실제로 깨어나 `relay_receive`, `relay_reply`를 호출하는지 확인한다.
8. Claude가 answer notification을 받아 `relay_collect`를 호출하는지 확인한다.
9. 최종 JSON에서 `delivered`와 request/answer attempts를 확인한다.
10. 사용자에게 보인 trust/permission 화면과 사람이 수행한 동작을 검증 기록에 남긴다.

확인 화면에서는 내용과 대상 action을 읽은 뒤 필요한 항목만 사용자가 승인한다. 자동 키 입력은 사용하지 않는다.

## 새 Codex thread 연구 절차

1. 설치된 CLI의 `--help`와 공식 문서에서 session/lifecycle/hook/event 지원을 확인한다.
2. 공식적으로 제공되는 ID만 사용한다. 화면 scraping이나 비공식 저장 포맷 파싱은 도입하지 않는다.
3. hook payload가 있으면 임시 파일과 독립 서버에서 raw shape를 최소 범위로 관찰한다. secret과 대화 본문은 기록하지 않는다.
4. ID를 얻을 수 있으면 기존 `PATCH /api/sessions/:id`의 `providerSessionId`에 연결한다.
5. 새 thread를 만든 실제 interactive roundtrip으로 완료를 판단한다.
6. 지원되지 않으면 정확한 제약과 알려진 thread를 얻는 최소 사용자 절차를 문서화한다.

## 변경 체크리스트

- 시작 전에 `git status --short`, `git diff` 확인
- 상태 의미와 ownership 경계 유지
- provider command는 `spawn(..., { shell: false })` 사용
- 테스트 데이터와 기본 사용자 데이터 분리
- 관련 테스트 추가 또는 갱신
- `npm test` 실행
- provider integration을 바꿨다면 실제 interactive 검증을 별도로 실행
- `docs/TECHNICAL_VALIDATION.md`와 `docs/HANDOFF.md` 갱신
- 완료 보고에서 검증/미검증/다음 단계를 분리

## 알려진 유지보수 항목

- `npm install`에서 high severity audit 항목 1개가 보고되었다. 현재 dependency 호환성과 실제 영향은 아직 조사하지 않았다.
- JSON persistence에는 migration과 multi-process locking이 없다.
- CLI parser는 최소 구현이며 `--key value` 형식만 처리한다.
