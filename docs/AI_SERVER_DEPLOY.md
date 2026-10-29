# 앱 API 설정과 선택적 서버 배포

**OpenAI 대본 작성·이미지 생성·음성 인식에는 Render 계정이나 별도 서버가 필요하지 않습니다.** 웹 편집기의 **설정 → OpenAI API**에 본인의 키를 입력하면 브라우저가 OpenAI에 직접 요청합니다. 대본을 먼저 작성한 뒤 필요할 때 음성을 만들고 영상을 편집하는 순서이며, 대본·이미지에는 보이스 API가 필요하지 않습니다.

아래 Render 배포는 **CLOVA Voice 음성 합성**이나 **키를 서버에 보관하는 운영 방식**을 선택할 때만 사용합니다. 앱 설정에 직접 키를 입력하려고 Render 계정을 만들 필요는 없습니다. OpenAI API 사용료와 모델 이용 권한은 개인 OpenAI 계정에 따르며, ChatGPT 구독이나 Codex 채팅을 직접 호출하는 연결은 아닙니다.

## 1. 앱 안에서 OpenAI 직접 연결

1. [웹 편집기](https://battlebuild001.github.io/image-studio/)에서 상단 **설정**을 누르고 **OpenAI API**를 엽니다.
2. **OpenAI API 키** 비밀번호 입력란에 본인의 키를 입력합니다. 키는 채팅이나 GitHub 파일에 보내지 않습니다.
3. 대본 모델은 `gpt-5-mini`, 이미지 모델은 `gpt-image-2`, 시간 정보를 사용하는 음성 인식은 `whisper-1`을 기본으로 사용합니다.
4. 연결을 확인하거나 저장합니다. 연결 확인은 과금 없는 `GET https://api.openai.com/v1/models` 요청이며 자료·이미지·음성을 보내지 않습니다. 모델 목록 읽기 권한이 없는 제한 키는 확인 없이 저장할 수 있습니다. 모델 목록 확인의 성공만으로 실제 생성 권한·결제·출력 품질을 검증한 것은 아닙니다.
5. **대본 작성**에 자료·정리 방향·목표 분량을 넣고 AI 작성을 실행합니다. **레퍼런스로 이미지 제작**에는 기준 이미지·배경 설정·장면 요청을 넣고 생성을 실행합니다. **음성 분석 · 자동 자막**은 선택한 내레이션 구간만 인식합니다.
6. 결과를 검토한 뒤 대본·이미지·자막을 명시적으로 적용합니다. 설정 저장, 프로젝트 복원, 파일 추가만으로 유료 생성이나 자동 재시도를 하지 않습니다.

키는 기본적으로 현재 페이지의 메모리에만 둡니다. 새로고침 후에도 사용하려면 탭 세션 보관 옵션을 직접 선택합니다. 이 경우에만 `sessionStorage`를 사용합니다. 키는 `localStorage`, 프로젝트·보관함·백업·Git·로그에 포함하지 않습니다. 키 삭제 시 보관 값과 입력란을 비우고, 연결 변경은 진행 중인 이전 요청을 취소합니다.

직접 연결 키는 고정된 HTTPS `api.openai.com` 경로로만 보내며 임의 서버나 리디렉션으로 전달하지 않습니다. 대본과 이미지는 같은 키를 재사용합니다. 대본은 실제 웹 검색 완료와 출처를 확인하고, 자막은 인식 서비스의 실제 시간 정보를 사용합니다. 원문 복사나 글자 수로 추정한 시간을 AI 조사·발화 시간으로 대신 표시하지 않습니다.

CLOVA Voice는 브라우저 직접 연결을 제공하지 않습니다. OpenAI 키를 입력해도 CLOVA 음성 합성이 활성화되지는 않습니다. 준비한 MP3·WAV를 가져오거나 아래 선택적 서버를 연결합니다.

## 2. 선택 사항: Render에서 서버 만들기

`render.yaml`은 Render의 **Free Node 웹 서비스 하나**를 생성합니다. 계정 로그인과 서버용 키 입력은 Render 화면에서 진행합니다. 설정 파일이나 소스 브랜치 게시만으로 실제 서버 배포·AI 생성이 완료된 것은 아닙니다.

1. [이 브랜치로 Render 배포 시작](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fbattlebuild001%2Fimage-studio%2Ftree%2Fimage-studio-server)을 열고 로그인합니다.
2. GitHub 연결을 요청하면 `battlebuild001/image-studio` 저장소 접근을 허용합니다. 저장소 접근 권한이 있는 GitHub 계정을 사용합니다.
3. Blueprint 설정을 확인합니다.

   | 항목 | 값 |
   | --- | --- |
   | Repository | `battlebuild001/image-studio` |
   | Branch | `image-studio-server` |
   | Blueprint 파일 | `render.yaml` |
   | Service | `image-studio-ai` |
   | Runtime | Node |
   | Instance Type / Plan | **Free** |

4. 제공자 키 없이 서버를 먼저 배포할 수 있습니다. **서버에서 OpenAI를 호출하는 방식**을 선택할 경우에만 서비스의 Environment에 `SCRIPT_AI_API_KEY`를 추가합니다. 앱의 개인 직접 연결 키가 서버로 복사되는 것은 아닙니다.
5. 배포 상태가 **Live**가 될 때까지 기다린 뒤 서비스 화면에 표시된 실제 HTTPS 주소를 복사합니다. 이름 중복 시 접미사가 붙을 수 있으므로 예상 주소를 직접 입력하지 않습니다.
6. 주소 뒤에 `/healthz`를 붙여 정상 상태 JSON이 나오는지 확인합니다. 이 확인은 서버 실행 여부만 검사합니다.
7. CLOVA 합성을 사용할 경우 Render 서비스의 **Environment**에 `CLOVA_VOICE_CLIENT_ID`와 `CLOVA_VOICE_CLIENT_SECRET`을 추가하고 재배포합니다. CLOVA 키는 OpenAI 키와 별개입니다.

링크로 브랜치를 불러오지 못하면 Render Dashboard의 **New → Blueprint**에서 저장소를 연결하고 `image-studio-server`와 `render.yaml`을 선택합니다. `main`이나 정적 사이트용 `image-studio-web` 브랜치를 선택하지 않습니다.

## 3. 선택 사항: 앱에서 고급 서버 연결

1. Render 서비스의 **Environment**에서 자동 생성된 `STUDIO_ACCESS_TOKEN`을 개인적으로 복사합니다. 이 값은 **앱 접속코드**이며 제공자 API 키와 다릅니다.
2. 웹 편집기의 **설정**에서 고급 서버 연결을 엽니다.
3. 서버 주소에 Render의 HTTPS 기본 주소를 넣습니다. `/healthz`나 `/api/script`를 붙이지 않습니다.
4. 앱 접속코드에 `STUDIO_ACCESS_TOKEN`을 넣고 연결을 확인·저장합니다. 제공자 API 키를 앱 접속코드 칸에 입력하지 않습니다.
5. 서버 연결 방식을 선택해 사용할 기능을 실행합니다. CLOVA 음성 생성은 서버의 CLOVA 키 설정이 필요합니다. 직접 연결과 서버 연결의 인증정보를 서로 복사하지 않습니다.

서버 주소는 브라우저에 저장할 수 있습니다. 앱 접속코드는 현재 탭의 `sessionStorage`에만 보관하며 프로젝트·백업에 넣지 않습니다. 서버 운영용 제공자 키는 서버에서만 읽고 브라우저로 반환하지 않습니다.

## 서버 환경 변수

아래 변수는 선택적 서버 방식에만 적용합니다. 개인 OpenAI 직접 연결에는 필요하지 않습니다.

| 환경 변수 | 용도 |
| --- | --- |
| `SCRIPT_AI_API_KEY` | 서버의 OpenAI 대본·이미지·음성 인식에 사용할 키. Render 비공개 환경 설정에서 입력합니다. |
| `SCRIPT_AI_MODEL` | 서버 대본 모델. 기본값 `gpt-5-mini`. |
| `IMAGE_AI_MODEL` | 서버 이미지 모델. 기본값 `gpt-image-2`. |
| `TRANSCRIBE_MODEL` | 실제 시간 정보를 반환하는 음성 인식 모델. 기본값 `whisper-1`. |
| `CLOVA_VOICE_CLIENT_ID` | CLOVA Voice Premium 애플리케이션의 서버용 Client ID. |
| `CLOVA_VOICE_CLIENT_SECRET` | 같은 애플리케이션의 서버용 Client Secret. |
| `STUDIO_ACCESS_TOKEN` | Render가 생성하는 앱 접속코드. 공개 API 요청 인증에 사용합니다. |
| `STUDIO_ALLOWED_ORIGINS` | 기본값 `https://battlebuild001.github.io`. 경로와 마지막 `/`는 넣지 않습니다. |
| `STUDIO_PUBLIC` | `1`로 설정해 공개 서버 인증과 접근 제한을 적용합니다. |
| `NODE_VERSION` | 검증한 실행 환경 버전 `24.19.0`. |

서버는 Render의 `PORT`를 사용하고 `0.0.0.0`으로 수신합니다. 모든 `/api/` 요청에 인증과 허용 출처 검사를 적용하고, 분당 POST 요청 수와 동시 유료 작업을 제한합니다. `/healthz`는 공개 상태 확인 경로입니다. 인증 없는 과금 프록시로 공개하지 않습니다.

Codex 클라우드 환경의 시크릿은 Render나 앱의 개인 API 설정으로 자동 복사되지 않습니다. 클라우드의 `SCRIPT_AI_API_KEY`가 비어 있어도 앱에서 본인 키를 입력하는 직접 연결은 사용할 수 있습니다. 서버 키를 바꾸면 서버를 다시 시작하고, 앱 접속코드를 바꾸면 앱의 고급 서버 연결도 갱신합니다.

## 비용·업데이트·확인 범위

- 직접 연결에는 Render 비용이 없습니다. OpenAI API 사용료는 별도입니다.
- Blueprint의 서버 플랜은 `free`이며 유료 인스턴스로 자동 변경하는 설정은 없습니다. CLOVA와 서버 경유 OpenAI 사용료는 각 제공자 계정에 따릅니다.
- Render Free 서비스는 15분간 요청이 없으면 중지되며, 다시 시작하는 데 약 1분이 걸릴 수 있습니다. [Render 무료 서비스 문서](https://render.com/docs/free)에서 사용량 조건을 확인합니다.
- `image-studio-server` 브랜치 갱신은 서버 재배포에 사용합니다. 정적 웹 화면의 `image-studio-web` 배포와 별개입니다.
- 키 연결·모델 목록·CORS·모의 응답 테스트는 실제 대본 품질, 이미지 일관성, 한국어 음성 인식 또는 CLOVA 음질 검증과 구분합니다. 실제 생성 성공은 사용자 키로 명시적 요청이 완료된 뒤에만 확인할 수 있습니다.

배포 파일은 [Render 공식 Blueprint 스키마](https://render.com/schema/render.yaml.json)를 따릅니다. 브랜치 지정 링크는 [Deploy to Render](https://render.com/docs/deploy-to-render), Node 버전은 [Node.js 버전 설정](https://render.com/docs/node-version), 세부 필드는 [Blueprint 명세](https://render.com/docs/blueprint-spec)를 참고하세요.
