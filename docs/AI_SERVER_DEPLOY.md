# AI 대본 서버 배포

GitHub Pages의 편집기에 AI 서버를 연결하면 참고자료와 정리 방향을 AI가 분석하고, 지정한 분량에 맞춘 한국어 나레이션 대본을 작성합니다. 보이스 API는 대본 작성에 필요하지 않습니다. 대본을 확인한 뒤 음성을 만드는 순서입니다.

`render.yaml`은 Render의 **Free Node 웹 서비스 하나**를 생성합니다. Render 계정 로그인과 OpenAI API 키 입력은 계정 소유자가 Render 화면에서 진행해야 합니다. 이 설정 파일만으로 서버 배포나 실제 AI 대본 생성이 완료된 것은 아닙니다.

## 1. Render에서 서버 만들기

1. [이 브랜치로 Render 배포 시작](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fbattlebuild001%2Fimage-studio%2Ftree%2Fimage-studio-server)을 열고 로그인합니다.
2. GitHub 연결을 요청하면 `battlebuild001/image-studio` 저장소 접근을 허용합니다. 저장소 접근 권한이 있는 GitHub 계정을 사용합니다.
3. Blueprint 설정에서 아래 항목을 확인합니다. 이름을 요구하는 경우 Blueprint 이름은 `image-studio` 등으로 정하면 됩니다.

   | 항목 | 값 |
   | --- | --- |
   | Repository | `battlebuild001/image-studio` |
   | Branch | `image-studio-server` |
   | Blueprint 파일 | `render.yaml` |
   | Service | `image-studio-ai` |
   | Runtime | Node |
   | Instance Type / Plan | **Free** |

4. `SCRIPT_AI_API_KEY` 입력란에 보유한 **OpenAI API 키**를 입력하고 배포합니다. 키는 Render에만 입력합니다. 채팅, GitHub 파일, 편집기 입력란에는 입력하지 않습니다. OpenAI API를 사용할 수 있는 결제·잔액 설정도 필요합니다.
5. 배포 상태가 **Live**가 될 때까지 기다립니다. 서비스 화면 상단의 실제 HTTPS 주소를 복사합니다. 이름 중복 시 주소에 접미사가 붙을 수 있으므로 예상 주소를 직접 입력하지 않습니다.
6. 복사한 주소 뒤에 `/healthz`를 붙여 열었을 때 정상 상태 JSON이 나오는지 확인합니다. 이 확인은 서버 실행 여부를 검사하며, OpenAI 호출 성공 여부는 아래 대본 작성 단계에서 확인합니다.

배포 링크로 브랜치를 불러오지 못하면 Render Dashboard에서 **New → Blueprint**로 저장소를 연결하고 `image-studio-server` 브랜치와 `render.yaml`을 선택합니다. `main`이나 정적 사이트용 `image-studio-web` 브랜치를 선택하지 않습니다.

## 2. 웹 편집기에서 연결하기

1. Render의 `image-studio-ai` 서비스에서 **Environment**를 엽니다.
2. 자동 생성된 `STUDIO_ACCESS_TOKEN` 값을 확인해 개인적으로 복사합니다. 이 값은 이 앱에 접속하는 **앱 접속코드**입니다. `SCRIPT_AI_API_KEY`와 다른 값입니다.
3. [웹 편집기](https://battlebuild001.github.io/image-studio/)를 열고 상단 **AI 서버 연결**을 누릅니다.
4. **AI 서버 주소**에는 Render에서 복사한 HTTPS 기본 주소를 입력합니다. `/healthz`나 `/api/script`를 붙이지 않습니다.
5. **앱 접속코드**에는 `STUDIO_ACCESS_TOKEN` 값을 입력하고 **연결 확인·저장**을 누릅니다.
6. **대본 작성**에서 참고 파일 또는 텍스트, 목표 길이, 정리 방향을 넣고 **AI 대본 작성**을 누릅니다. 참고자료를 그대로 초안 칸으로 옮기는 수동 작업과 별개의 AI 요청입니다.

서버 주소는 브라우저에 저장됩니다. 앱 접속코드는 현재 탭의 세션에만 저장하므로 새 세션에서는 다시 입력해야 합니다. 접속코드와 제공자 API 키는 프로젝트 파일·백업에 들어가지 않습니다.

## 서버 설정

| 환경 변수 | 용도 |
| --- | --- |
| `SCRIPT_AI_API_KEY` | OpenAI API 키. Blueprint 생성 시 Render의 비공개 입력란에서 설정합니다. |
| `SCRIPT_AI_MODEL` | 대본 모델. 기본값 `gpt-5-mini`. |
| `STUDIO_ACCESS_TOKEN` | Render가 자동 생성하는 앱 접속코드. API 요청 인증에 사용합니다. |
| `STUDIO_ALLOWED_ORIGINS` | 연결을 허용하는 웹사이트의 출처. 기본값 `https://battlebuild001.github.io`. 경로와 마지막 `/`는 넣지 않습니다. |
| `STUDIO_PUBLIC` | 외부 공개 서버 설정. `1`로 두어 인증과 접근 제한을 적용합니다. |
| `NODE_VERSION` | 실행 환경 버전. 검증한 `24.19.0`으로 고정합니다. |

이 서버는 Render가 제공하는 `PORT`를 사용하고 `0.0.0.0`으로 수신합니다. GitHub Pages는 화면을 제공하고, AI 요청은 인증을 거쳐 Render 서버가 처리합니다. OpenAI API 키는 브라우저로 보내지 않습니다. 음성 키를 설정하지 않아도 AI 대본 작성과 저장을 사용할 수 있습니다.

Codex 클라우드 환경의 시크릿은 Render로 자동 복사되지 않습니다. 같은 이름의 시크릿이 클라우드에 있더라도 Render에서 실제 키를 따로 설정해야 합니다. 이후 키를 변경하려면 해당 Render 서비스의 **Environment**에서 수정하고 재배포합니다. 앱 접속코드를 바꾸면 편집기의 연결 설정에도 새 코드를 입력합니다.

## 비용·업데이트·연결 확인

- Blueprint의 서비스 플랜은 명시적으로 `free`입니다. 유료 인스턴스로 자동 변경하는 설정은 없습니다. **OpenAI API 사용료는 별도**입니다.
- Render Free 서비스는 15분간 요청이 없으면 중지되며, 다음 접속 때 다시 시작하는 데 약 1분이 걸릴 수 있습니다. `/healthz`로 서버가 깨어난 것을 확인한 뒤 연결을 다시 확인합니다. 월별 무료 사용량과 초과 과금 조건은 [Render 무료 서비스 문서](https://render.com/docs/free)에서 확인합니다.
- `image-studio-server` 브랜치가 갱신되면 Render가 서버를 자동 재배포합니다. GitHub Pages의 정적 화면 배포는 별도입니다.
- 접속코드 오류가 나오면 `STUDIO_ACCESS_TOKEN`을 다시 확인합니다. OpenAI API 키를 앱 접속코드로 입력하지 않습니다.
- 허용 사이트 오류가 나오면 Render의 `STUDIO_ALLOWED_ORIGINS`가 위 값인지 확인합니다. 다른 도메인으로 편집기를 옮길 경우 해당 출처를 서버에서 허용해야 합니다.
- 서버에는 연결되지만 AI 키가 없다는 안내가 나오면 Render의 `SCRIPT_AI_API_KEY`와 재배포 상태를 확인합니다. OpenAI의 사용 한도·결제 오류는 해당 OpenAI 계정에서 해결합니다.

배포 파일은 [Render 공식 Blueprint 스키마](https://render.com/schema/render.yaml.json)를 기준으로 작성했습니다. 브랜치 지정 배포 링크는 [Deploy to Render 문서](https://render.com/docs/deploy-to-render), Node 버전 고정은 [Node.js 버전 설정 문서](https://render.com/docs/node-version)를 따릅니다. 설정 필드는 [Blueprint 명세](https://render.com/docs/blueprint-spec)에서 확인할 수 있습니다.
