# woo-mods — Claude Code mods 두 개

| mod | 하는 일 | 명령 |
|---|---|---|
| **usage-band** | 프롬프트 바로 위에 Claude(5시간·주간·Fable 등 모델별 주간·컨텍스트)와 Codex 사용량 막대. 두 줄의 열이 맞춰져 있음 | `/usagebar` 두 줄 → 한 줄 → 숨김 |
| **pocket-pet** | 바탕화면에 사는 픽셀 펫 "클로"(주황 몸·민트 스카프). Claude가 생각·작업·허락 대기·완료할 때 반응하고, 마우스로 끌어 옮길 수 있음. 사용량 띠와는 따로 동작 | `/pet` 켜기, `/pet pat` 쓰다듬기, `/pet 끄기` |

필요: Claude Code **v2.1.287 이상** (`claude --version`). 터미널과 데스크톱 앱의 Code 탭에서 보입니다(VS Code 확장 채팅창에서는 안 그려짐).

## 설치 (Windows)

다른 PC에서는 GitHub 저장소(`kgrvGRECO/woo-mods`)를 마켓플레이스로 추가합니다. Claude Code에서:

```
/plugin marketplace add kgrvGRECO/woo-mods
/plugin install usage-band@woo-mods
/plugin install pocket-pet@woo-mods
/reload-plugins
```

새 버전이 올라오면 `/plugin marketplace update woo-mods` → `/plugin update pocket-pet@woo-mods`(또는 usage-band) → `/reload-plugins`. 바탕화면 클로에는 Python 3의 `pythonw`가 필요합니다(없으면 `/pet`에서 안내가 뜹니다).

이 PC(개발 폴더 `C:\dev\개발용\mods`)에서는 폴더를 마켓플레이스로 씁니다: `/plugin marketplace add C:\dev\개발용\mods` 뒤 위와 같이 설치. 설정 바꾸기(선택): `/plugin configure pocket-pet@woo-mods` — 이름, 자동으로 띄우기(on·off), pythonw 경로

한 번만 시험해 보려면 설치 없이: `claude --plugin-dir C:\dev\개발용\mods\pocket-pet --plugin-dir C:\dev\개발용\mods\usage-band`

수정한 뒤 반영: **이 폴더에서 Claude Code로 고치면 저절로 반영됩니다.** 프로젝트 훅(`.claude/settings.json`)이 고친 파일이 속한 mod를 `tools/sync_mods.py`로 플러그인 캐시에 복사하고 등록을 고쳐, 데스크톱 앱이 열린 Code 세션 모두에 다시 불러오기를 보냅니다(`desktop/`을 고치면 바탕화면 클로도 새 코드로 다시 뜹니다). 직접 편집기로 고쳤으면 한 번 실행하세요: `python tools\sync_mods.py` (하나만: `python tools\sync_mods.py pocket-pet`). 버전을 올리지 않아도 반영됩니다.

- 데스크톱 앱은 플러그인의 실제 위치가 캐시 폴더 안에 있어야만 불러옵니다. 그래서 개발 폴더를 링크로 직접 잇는 대신 복사합니다.
- **이미 열린 세션은 세션을 열 때 정해진 버전 폴더에서 계속 읽습니다.** 등록된 버전을 바꿔도 그 세션은 옮겨 가지 않아서, 예전에는 `/reload-plugins`를 해도 옛 코드가 다시 올라왔습니다. 그래서 동기화 스크립트는 지금 등록된 버전 폴더뿐 아니라 돌고 있는 세션이 쓰는 버전 폴더(Claude Code가 `.in_use` 표시를 남긴 곳) 전부에 최신을 넣습니다. 그러면 어느 세션이든 다시 불러올 때 새 코드가 올라갑니다.
- 다시 불러오기는 세션이 쉬고 있을 때 적용됩니다. 그 세션에서 Claude가 작업 중이면 턴이 끝난 뒤에 올라갑니다. 1분 안에 연달아 고치면 앱이 모았다가 1분 뒤 한 번에 적용합니다.

## 알아 둘 점

- **Fable 같은 모델별 주간 한도**는 상태줄(awesome-statusline)이 1분마다 받아 두는 `%TEMP%\.claude_usage_cache`에서 읽습니다. 상태줄을 끄면 마지막 값에 "몇 분 전 기록"이 붙습니다. 파일 위치가 다르면 `/plugin configure usage-band@woo-mods`에서 지정하세요.
- **Claude 한도**는 이번 세션의 첫 응답 뒤에 채워집니다. 그 전에는 지난 세션에서 본 값을 "몇 분 전 기록"으로 보여 줍니다.
- **Codex 사용량**은 이 PC의 `%USERPROFILE%\.codex\sessions` 기록에서 읽습니다. 그래서 Codex를 마지막으로 쓴 시점의 값이고, 다른 PC·VM에서만 Codex를 쓰면 비어 있습니다. 다른 폴더라면 `/plugin configure usage-band@woo-mods`에서 Codex 폴더를 지정하세요. 리셋 시각이 지난 창은 0%로 표시합니다.
- **바탕화면 클로**는 Claude Code를 열면 함께 뜹니다(Python 3의 `pythonw`가 필요, 이 PC에는 이미 있음). 마우스를 올리면 아래에 입력 영역이 열립니다: **Code** 또는 **대화**(일반 Claude 대화)를 고르고 적어서 Enter를 누르면 Claude 데스크톱 앱에서 이어집니다. Code에서는 폴더 칩을 눌러 **열린 세션에 이어서**(그 세션에 바로 들어감) 또는 **새 세션 폴더**(그 폴더에서 새 Code 세션)를 고릅니다. 열린 세션으로 보내기는 pocket-pet 0.5.0 이상이 돌고 있는 세션에서만 됩니다(목록에도 그런 세션만 나옴). **새 세션 폴더**로 보내면 클로가 Claude Code CLI(`claude`)로 그 폴더에서 첫 턴을 화면 없이 돌린 뒤(보통 10~30초, 클로가 "생각하는 중"으로 보여 줌) 그 세션을 데스크톱 앱에 들여와 바로 엽니다. 첫 턴은 화면이 없어서 허락을 물을 수 없으므로, 읽기만으로 답할 수 있는 질문은 바로 답해 두고, 파일 수정·명령 실행이 필요한 요청은 계획만 적어 두었다가 앱에서 "진행"이라고 하면 시작합니다(그때부터는 평소처럼 허락을 묻습니다). CLI가 없으면 앱의 새 세션 작성 화면에 글만 채워 두므로 Enter로 시작하세요. CLI 경로를 직접 지정하려면 `desktop.json`에 `"claude": "경로"`를 적습니다. **말하기**는 Windows 음성 입력(Win+H)을 켭니다(설정 → 시간 및 언어 → 음성에서 한국어 음성 입력이 켜져 있어야 함). 왼쪽 버튼으로 끌어 옮기고, 클릭하면 Claude 데스크톱 앱이 앞으로 나옵니다(꺼져 있으면 실행). 오른쪽 클릭하면 메뉴(Claude 열기 · 쓰다듬기 · 말풍선 끄고 켜기 · 크기 작게/보통/크게 · 끄기)가 나옵니다. 자리와 크기는 `%USERPROFILE%\.claude\clo\desktop.json`에 남습니다.
- 세션이 여럿이면 허락을 기다리는 세션을 먼저, 그다음 가장 최근에 바뀐 세션을 따릅니다. Claude Code를 모두 닫고 30분이 지나면 클로도 스스로 꺼집니다.
- 펫 그림을 바꾸려면 새 시안 묶음(clo-pet-assets)을 풀고 `python pocket-pet	ools\make-frames.py <폴더>`(Pillow 필요)를 실행하세요.
- mod는 Claude Code와 같은 권한으로 실행됩니다. 이 두 mod가 하는 일: 파일 읽기(Codex 기록, 상태줄의 사용량 캐시), 클로 상태 파일 쓰기(`~/.claude/clo`), PowerShell(큰 Codex 기록에서 마지막 줄만 뽑을 때, 바탕화면 클로를 띄울 때), 자체 저장소에 설정 저장. 네트워크는 쓰지 않습니다. `claude plugin validate .\usage-band` 로 직접 확인할 수 있습니다.
- mods API는 아직 얼리 액세스라 Claude Code 업데이트 때 깨질 수 있습니다. 그러면 `claude --debug`의 로그를 Claude에게 보여 주세요.
- 클로의 말풍선과 입력 카드 글꼴은 [Neo둥근모](https://github.com/neodgm/neodgm)(SIL Open Font License 1.1, `pocket-pet/desktop/fonts/LICENSE-neodgm.txt`)입니다. 프로그램 안에서만 불러오며 Windows에 설치하지 않습니다. 사용량 띠의 데스크톱 패널도 같은 글꼴(woff2, `usage-band/fonts/`)을 그림 안에 넣어 씁니다.
