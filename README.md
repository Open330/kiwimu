<div align="center">

<img src="assets/logos/logo_2_minimalist_icon_transparent.png" alt="Kiwi Mu" width="120">

# Kiwi Mu

**Turn any textbook into your personal learning wiki**

전공책, PDF, 웹 콘텐츠를 넣으면 — LLM이 자동으로 상호 링크된 학습 위키 + 퀴즈를 생성합니다.

[![npm](https://img.shields.io/npm/v/@open330/kiwimu?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/@open330/kiwimu)
[![Bun](https://img.shields.io/badge/Bun-1.3.14+-fbf0df?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<br>

<img src="https://github.com/Open330/kiwimu/raw/main/.context/marketing/demo.gif" alt="kiwimu v1.1 데모: 본문 드래그 → 질문 → 위키 페이지로 저장" width="720">

<br>

> **v1.1 — 위키는 만드는 게 아니라 자라는 거였다.**
> 본문 드래그 → 팝오버 질문 → AI 답변 → 한 번 클릭으로 정식 위키 페이지로 승격. ([상세 글](https://jiun.dev/posts/kiwimu))

⭐ 도움이 됐다면 [GitHub Star](https://github.com/Open330/kiwimu)로 응원해주세요.

</div>

---

## What's new in v1.2

- 🤖 **위키 전체 질의 (Ask-the-Wiki / RAG)** — 페이지를 청크 단위로 임베딩해 시맨틱 검색 + 위키 전체 대상 채팅. 관련 근거를 찾아 인용과 함께 답변 (`kiwimu ask`, serve 모드 `/api/ask-wiki`, `kiwimu index`로 증분 인덱싱)
- 🖼️ **그림 추출 (Figure Extraction)** — PDF의 다이어그램·그림을 자동 추출해 위키 페이지에 임베드, 멀티모달 LLM이 캡션 생성 (vision 미지원/도구 미설치 시 자동 건너뜀)
- ♻️ **증분 재인제스트 (Incremental Re-ingest)** — 내용이 바뀐 문서만 다시 처리. 변경 없으면 LLM 호출 없이 즉시 스킵 (`--force`로 강제)
- 💵 **비용 미리보기** — `add` 실행 시 예상 토큰·비용을 먼저 보여주고 확인 (`--yes`로 스킵)

---

## What's new in v1.1

- 🔖 **출처 추적 (Provenance Tracking)** — 모든 AI 생성 문장에 인라인 인용 자동 부착, 출처 커버리지 행렬 제공
- 🧱 **스키마 레이어** — `kiwi.toml`의 5줄로 카테고리·용어·페이지 템플릿을 정의하면 LLM이 그 안에서만 작동
- 💬 **질문 → 위키 승격** — 본문 드래그 → 질문 → "위키에 저장" 한 번이면 정식 페이지. 중복 자동 감지
- 📑 **콘텐츠 카탈로그** — 자동 카테고리 분류 + 출처 커버리지 한눈 보기
- 📈 **활동 로그** — 페이지 생성·질문·프로모트·스키마 변경이 시간선으로 누적
- 👁️ **링크 미리보기 (Peek Panel)** — `/wiki/*` 링크 클릭 시 우측 슬라이드 패널로 미리보기, 확장 버튼으로 전체 이동. 너비 드래그 조절·다이어그램·인라인 편집·드래그 Q&A까지 패널 안에서 그대로 동작
- 🗂️ **트랙 그룹핑 (Track Grouping)** — `kiwi.toml` 설정으로 사이드바·인덱스를 자동 카테고리(트랙)별로 묶어서 표시
- 🔑 **인증 토큰 영속화** — 서버 재시작해도 쿠키 기반으로 인증 유지 (관리 페이지·동적 Q&A 한 번 로그인하면 끝)

---

## 30초 데모 체험

API key 없이 바로 체험할 수 있습니다:

```bash
mkdir my-wiki && cd my-wiki
bunx @open330/kiwimu init --demo
# → 양자역학 샘플 위키 + 학습 퀴즈가 즉시 생성됩니다
# → http://localhost:8000 에서 확인하세요
```

---

## Quickstart for Agents

<div><img src="https://quickstart-for-agents.vercel.app/api/header.svg?theme=claude-code&logo=kiwimu&title=Set+up+a+learning+wiki+from+any+textbook+or+URL&lang=Agents&font=mono&mascot=hat" width="100%" /></div>

```
mkdir my-wiki && cd my-wiki
bunx @open330/kiwimu init
bunx @open330/kiwimu add "<YOUR_URL_OR_PDF>"
bunx @open330/kiwimu serve
```

<div><img src="https://quickstart-for-agents.vercel.app/api/footer.svg?theme=claude-code&text=copy+this+prompt+%C2%B7+paste+into+your+agent+%C2%B7+get+a+learning+wiki&font=mono" width="100%" /></div>

---

## Why Kiwi Mu?

교과서 한 권을 읽으면 수십 개의 개념이 서로 연결됩니다.
Kiwi Mu는 LLM을 활용해 이 연결을 **자동으로** 만들어, 지식을 빠르게 탐색할 수 있는 위키로 변환합니다.

- **LLM 기반 문서 분석** — 챕터/섹션 구조를 보존한 원본 페이지 + 핵심 개념별 자동 생성 페이지
- **원본/개념 분리** — 📖 원본 문서와 📝 개념 문서를 시각적으로 구분
- **자동 상호 링크** — 원본↔개념 간 유기적 cross-link + 외부 참고 자료 (Wikipedia 등)
- **Dynamic Q&A** — 텍스트 드래그 → 팝오버 질문 → LLM이 새 개념 페이지 자동 생성 + 하이라이트 링크
- **웹 페이지 편집** — serve 모드에서 ✏️ 마크다운 편집
- **SM-2 간격 반복** — Anki 스타일 SRS (퀴즈 자동 생성 포함)
- **학습 대시보드** — 숙달도, 약한 개념, 복습 일정 시각화
- **MD 파일 + 디렉토리 일괄 인제스트** — `kiwimu add <directory>`로 .md 파일 일괄 처리
- **LaTeX 수식 렌더링** — KaTeX 기반 수학 수식 지원
- **Mermaid 다이어그램 지원** — Mermaid.js 기반 다이어그램 렌더링
- **지식 그래프** — D3.js 인터랙티브 그래프 (원본: 파란색, 개념: 초록색)
- **데모 모드** — API key 없이 `--demo`로 즉시 체험 (양자역학 + 자료구조)
- **다양한 파일 지원** — URL, PDF, DOCX, PPTX, **MD** + extractor 도구가 있는 CLI 환경의 레거시 DOC/PPT/KEY/RTF
- **6개 LLM 프로바이더** — Google Gemini, Azure OpenAI, OpenAI, Anthropic, Ollama(로컬·무료), OpenRouter
- **다크 모드** — 시스템 테마에 자동 대응 (100% 커버리지)
- **모바일 지원** — 햄버거 메뉴 + 슬라이드 사이드바
- **접근성** — ARIA 속성, 검색 키보드 네비게이션
- **웹 UI** — 브라우저에서 문서 추가, 설정 변경, 빌드 실행
- **토큰 사용량 추적** — API 호출 수, 토큰, 예상 비용을 웹에서 확인
- **원클릭 배포** — GitHub Pages / Vercel
- **라이브 데모** — [open330.github.io/kiwimu](https://open330.github.io/kiwimu/) (설치 없이 브라우저에서 바로 체험)

## vs. Alternatives

| Feature | Kiwi Mu | NotebookLM | Obsidian | Anki |
|---------|---------|------------|----------|------|
| Auto wiki from PDF | ✅ | ❌ | ❌ | ❌ |
| Knowledge graph | ✅ | ❌ | ✅ (plugin) | ❌ |
| Auto quiz generation | ✅ | ❌ | ❌ | ❌ (manual) |
| Spaced repetition | ✅ (basic) | ❌ | ❌ | ✅ |
| Self-hosted | ✅ | ❌ | ✅ | ✅ |
| One-click deploy | ✅ | ❌ | ❌ | ❌ |
| Open source | ✅ | ❌ | ❌ | ✅ |
| Free | ✅ | ✅ | Freemium | ✅ |

## Quick Start

### 설치

> **런타임:** kiwimu는 [Bun](https://bun.sh) ≥ 1.3.14 위에서 동작합니다 (`bun:sqlite`·`Bun.serve` 등 Bun 전용 API 사용). **Node.js / npx는 지원하지 않습니다** — 아래처럼 `bunx`로 실행하세요.

```bash
# bunx로 바로 실행 (Bun 런타임 필요, 별도 설치 불필요)
bunx @open330/kiwimu init

# 또는 글로벌 설치
bun add -g @open330/kiwimu
```

### 데모 모드 (API key 불필요)

```bash
mkdir my-wiki && cd my-wiki
bunx @open330/kiwimu init --demo
```

양자역학 샘플 위키가 생성되어 바로 체험할 수 있습니다:
- 📖 원본 문서 + 📝 개념 페이지
- 🔗 자동 상호 링크
- 📊 지식 그래프
- 📝 학습 퀴즈
- 🎲 임의 문서 탐험

### 프로젝트 생성 (Interactive CLI)

```bash
mkdir my-wiki && cd my-wiki
bunx @open330/kiwimu init
```

Interactive 프롬프트가 실행됩니다:

```
🥝 Kiwi Mu — 새 학습 위키 만들기

◆ 위키 이름
│  Radio Astronomy Wiki

◆ LLM 프로바이더
│  ● Google Gemini  (무료 API key: aistudio.google.com)
│  ○ Azure OpenAI
│  ○ OpenAI
│  ○ Anthropic Claude

◆ 모델명
│  gemini-3.7-flash

◆ API Key
│  ••••••••••••

🥝 'Radio Astronomy Wiki' 위키가 생성되었습니다!
```

### 문서 추가

```bash
# URL 추가
bunx @open330/kiwimu add "https://www.cv.nrao.edu/~sransom/web/Ch1.html"

# 파일 추가 (PDF, DOCX, PPTX, MD; 레거시는 아래 runtime 요구사항 참고)
bunx @open330/kiwimu add textbook.pdf
bunx @open330/kiwimu add lecture.pptx
```

LLM이 문서를 분석하여:
1. 📖 **원본 페이지** — 원래 챕터/섹션 구조 보존
2. 📝 **개념 페이지** — 핵심 용어·정의·법칙 자동 생성
3. 🔗 **Cross-link** — 원본↔개념 간 유기적 연결
4. 📝 **퀴즈** — 개념별 학습 퀴즈 자동 생성

비용 미리보기는 표준 가격이 확인된 정확한 provider/model 조합에만 USD 금액을 표시합니다. 사용자 지정 모델이나 계약별 가격인 Azure 배포는 임의 가격을 적용하지 않고 `가격 정보 없음`으로 표시하며, 해당 호출은 누적 USD 합계에서 제외하되 토큰 예상량과 실제 사용량은 계속 기록합니다.

### 학습 퀴즈

```bash
# 터미널에서 퀴즈 풀기
bunx @open330/kiwimu quiz

# 문제 수 지정
bunx @open330/kiwimu quiz -n 10
```

웹에서도 `http://localhost:8000/quiz.html`에서 카드 플립 방식으로 퀴즈를 풀 수 있습니다.

### Dynamic Q&A

위키 페이지에서 이해가 안 되는 부분을 드래그하면, 팝오버가 나타나 LLM에게 질문할 수 있습니다.

1. **텍스트 드래그** — 궁금한 구절을 선택
2. **팝오버 질문** — "이게 뭐야?", 자유 질문, 또는 자동 생성 질문 선택
3. **새 개념 페이지 생성** — LLM이 답변을 새로운 개념 페이지로 자동 생성
4. **하이라이트 링크** — 드래그한 텍스트가 새 페이지로의 링크로 변환

`kiwimu serve` 모드에서 실시간으로 동작합니다. 학습 중 발생하는 궁금증을 즉시 해결하고, 위키가 유기적으로 확장됩니다.

### 빌드 및 서버

```bash
# 정적 사이트 빌드
bunx @open330/kiwimu build

# 로컬 서버 실행 (웹에서 문서 추가 가능)
bunx @open330/kiwimu serve
# → http://localhost:8000

# 포트 변경
bunx @open330/kiwimu serve -p 3000
```

### 관리 페이지

`kiwimu serve` 실행 후 콘솔의 토큰 없는 관리 URL(`/manage`)로 접속합니다. 인증 토큰은 `KIWIMU_AUTH_TOKEN`을 지정했으면 그 값을, 아니면 프로젝트의 권한 제한 파일 `.kiwi-token` 값을 사용해 최초 한 번 `/manage?token=<token>`으로 전달합니다.
- 위키 이름 변경
- LLM 프로바이더/모델/API Key 설정
- 토큰 사용량 및 예상 비용 확인
- 파일 업로드 (PDF, DOCX, PPTX 등)
- URL 추가
- 수동 빌드 실행
- 페르소나 관리

브라우저에서 관리 URL로 처음 접속하면 쿼리 토큰을 즉시 제거하고 30일짜리 `HttpOnly`, `SameSite=Lax` 쿠키로 전환합니다. 스크립트나 API 클라이언트에서는 `Authorization: Bearer <token>`을 사용할 수 있습니다.

관리 API에서 Azure OpenAI endpoint를 변경할 때는 사용자 정보와 별도 포트가 없는 공식 `https://<resource>.openai.azure.com` 주소만 허용합니다. 이는 관리 토큰이 노출되더라도 임의의 내부 HTTP 서비스로 요청을 전송하지 못하게 하는 기본 경계입니다. 같은 공식 hostname을 private DNS로 사설 주소에 연결하는 Azure Private Link 구성은 이 검사를 통과하므로, 해당 DNS zone과 서버 egress는 신뢰할 수 있는 운영자가 관리해야 합니다. Sovereign cloud나 custom gateway처럼 다른 hostname이 필요한 구성은 현재 웹 설정 대상이 아니며, 허용 범위와 egress 정책을 합의한 뒤 운영자 전용 설정으로 구성해야 합니다.

### 서버 운영 설정

| 환경 변수 | 기본값 | 설명 |
|-----------|--------|------|
| `KIWIMU_AUTH_TOKEN` | 자동 생성·`.kiwi-token` 저장 | 16자 이상의 고정 관리/API 토큰 |
| `KIWIMU_UPLOAD_CONCURRENCY` | `1` | 프로젝트 전체 동시 업로드 허용 수 (`1`–`4`) |
| `KIWIMU_LEASE_TTL_SECONDS` | `300` | 업로드·빌드 등 콘텐츠 작업 lease 만료 (`30`–`3600`) |
| `KIWIMU_TASK_TTL_SECONDS` | `90` | 백그라운드 작업 heartbeat 만료 (`15`–`600`) |
| `KIWIMU_SHUTDOWN_DRAIN_SECONDS` | `20` | 종료 시 진행 중인 요청·백그라운드 작업을 기다릴 최대 시간 (`1`–`26`) |
| `KIWIMU_COORDINATOR_URL` | 비어 있음 | 외부 runtime-state coordinator Redis/Valkey URL (`redis://`, `rediss://`, `valkey://`) |
| `KIWIMU_COORDINATOR_NAMESPACE` | 비어 있음 | 외부 coordinator를 공유하는 동일 프로젝트 식별자 (URL 설정 시 필수) |
| `KIWI_TRUST_PROXY` | `false` | 신뢰된 private reverse proxy의 `X-Forwarded-For`·`X-Forwarded-Proto` 사용 |
| `KIWIMU_EXTERNAL_HTTPS` | `false` | TLS 종료 프록시 뒤에서 외부 HTTPS origin과 `Secure` 인증 쿠키를 강제 |

상한 26초는 Compose의 30초 `stop_grace_period` 안에 timeout cleanup, listener와 저장소 종료를 위한 4초를 남깁니다. 범위를 벗어난 명시적 설정은 조용히 보정하지 않고 서버 시작을 거부합니다. 종료 drain이 시간 초과되면 진행 중인 서버 작업의 URL 요청, LLM·embedding 요청과 외부 변환 subprocess에 취소 신호를 전달합니다. DOCX/PPTX 파서는 안전한 단계 사이에서 취소를 확인합니다. `pdf-parse`는 프로세스 내부 CPU 파싱을 중단하는 API가 없으므로 PDF는 파싱 진입 전과 반환 직후에만 취소를 확인하며, 이미 시작된 파싱의 CPU 사용은 프로세스가 종료될 때까지 계속될 수 있습니다.

기본값에서는 요청 제한, 작업 상태, 업로드·빌드 lease를 콘텐츠 DB와 분리된 `.kiwimu-runtime.db`에 저장합니다. 같은 호스트의 여러 프로세스가 한 프로젝트를 서비스할 때는 `kiwi.db`, `.kiwimu-runtime.db`, `_site`가 같은 로컬 볼륨에 있어야 합니다.

`KIWIMU_COORDINATOR_URL`을 설정하면 rate limit, task 상태, 작업 admission lease와 단조 증가 fencing token만 Redis/Valkey에서 원자적으로 조정하며 `.kiwimu-runtime.db` 공유가 필요 없습니다. coordinator 연결에 실패하면 안전하지 않은 로컬 상태로 우회하지 않고 서버 시작을 중단합니다. coordinator 데이터가 복구된 경우 콘텐츠 DB가 기억한 fencing token까지 자동으로 fast-forward한 뒤 새 lease를 발급합니다. 외부 coordinator에는 TLS와 인증, 고가용성, persistence(AOF/RDB), `noeviction` 정책을 권장합니다.

**여러 호스트가 같은 프로젝트를 동시에 읽고 쓰는 active-active 배포는 현재 지원하지 않습니다.** Redis/Valkey는 `kiwi.db`, `kiwi.toml`, 인증 토큰, 업로드 또는 `_site`를 복제하지 않으며, SQLite WAL 파일을 여러 호스트의 네트워크 파일시스템에서 공유하는 구성도 지원 대상이 아닙니다. 외부 transactional content store와 versioned object storage가 합의·구현되기 전에는 배포 replica를 1로 제한해 fail-closed로 운영하세요. 콘텐츠 DB 쓰기 자체는 coordinator token과 local epoch를 같은 SQLite transaction에서 확인하므로 단일 콘텐츠 호스트 안에서 lease를 잃은 장기 작업의 이후 commit은 차단됩니다.

### Docker Compose와 Cloudflare Tunnel

```bash
# 호스트에서만 접근 가능한 직접 HTTP 디버그 경로
docker compose up --build
# http://127.0.0.1:8400

# Cloudflare Tunnel 추가 실행
CLOUDFLARE_TUNNEL_TOKEN=<token> docker compose --profile external up --build
```

기본 Compose는 named volume에 재시작 후에도 유지되는 데모 프로젝트를 생성합니다. 실제 프로젝트를 서비스하려면 Compose override에서 해당 프로젝트 디렉터리를 `/data/wiki`에 bind mount하고, 컨테이너의 `bun` 사용자(UID 1000)가 읽고 쓸 수 있게 소유권과 권한을 맞춥니다.

공식 Docker 이미지와 기본 서버 업로드는 **PDF, DOCX, PPTX, Markdown**을 지원합니다. 이미지에 macOS 전용 `textutil`이나 별도 `strings` 도구를 추가하지 않으므로 DOC/PPT/KEY/RTF는 지원 목록에 표시되지 않으며, 우회 업로드도 파일 저장이나 백그라운드 작업 전에 `400`으로 거부됩니다.

브라우저 관리 화면이 아닌 직접 `/api/upload` 클라이언트는 multipart 요청과 함께 `X-Kiwimu-File-Extension: pdf`처럼 파일 확장자를 보내야 합니다. 서버는 본문을 받기 전에 이 값을 runtime capability와 대조하고, 이후 multipart 파일명의 실제 확장자와도 다시 대조합니다.

```yaml
services:
  kiwimu:
    volumes:
      - ./my-wiki:/data/wiki
```

운영에서는 `KIWIMU_AUTH_TOKEN`을 secret으로 주입하는 방식을 권장합니다. 자동 생성 토큰을 쓴 경우 아래 명령은 값을 shell history에 넣지 않고 현재 터미널에만 표시합니다. 출력은 비밀로 취급하세요.

```bash
docker compose exec kiwimu bun -e 'process.stdout.write((await Bun.file("/data/wiki/.kiwi-token").text()).trim()+"\n")'
```

Compose가 공개하는 호스트 포트는 `127.0.0.1:8400`의 평문 HTTP 하나뿐이며 `KIWIMU_DIRECT_PORT`로 포트 번호만 바꿀 수 있습니다. 이 포트는 HTTPS가 아니므로 `https://127.0.0.1:8400`으로 접속하지 마세요. Cloudflare의 published application origin은 Compose 내부 주소 `http://kiwimu:8000`으로 설정합니다. Tunnel은 outbound 연결과 내부 Compose 네트워크를 사용하므로 별도 공인 호스트 포트가 필요하지 않습니다.

기본 Compose는 `KIWI_TRUST_PROXY=true`, `KIWIMU_EXTERNAL_HTTPS=false`로 실행됩니다. 따라서 private immediate peer인 cloudflared가 전달하는 `X-Forwarded-Proto: https` 요청에는 `Secure` 인증 쿠키를 발급하고 HTTPS origin으로 검증하지만, 해당 헤더가 없는 로컬 직접 HTTP 접속은 계속 사용할 수 있습니다. `KIWIMU_EXTERNAL_HTTPS=true`를 지정하면 모든 요청을 외부 HTTPS로 취급해 로컬 HTTP에서 발급된 `Secure` 쿠키를 브라우저가 되돌려 보내지 않으므로 tunnel-only 운영에서만 사용하세요.

루프백 바인딩은 외부 네트워크 노출을 차단하지만 같은 호스트의 프로세스에는 보안 경계가 아닙니다. 신뢰할 수 없는 로컬 사용자가 있는 tunnel-only 호스트에서는 Compose override로 `ports`를 제거하세요. 애플리케이션은 private immediate peer의 forwarded header만 신뢰하며, Cloudflare는 원본 클라이언트가 보낸 `X-Forwarded-Proto`를 실제 접속 프로토콜로 덮어씁니다.

`GET /health/live`는 프로세스 생존 여부를, `GET /health/ready`는 정적 index·콘텐츠 DB·coordinator 준비 상태를 확인합니다. 두 endpoint는 load balancer용 최소 정보만 반환하며 인증이 필요하지 않습니다. 트래픽은 readiness가 `200`일 때만 전달하세요. `SIGTERM`/`SIGINT` 수신 시 readiness는 즉시 `503`으로 바뀌고 새 API 변경 요청을 거부한 뒤, 진행 중인 작업을 위 제한 시간까지 drain합니다.

### 배포

```bash
# GitHub Pages (기본)
bunx @open330/kiwimu deploy

# origin을 읽을 수 없거나 별도 Pages 경로를 사용할 때
bunx @open330/kiwimu deploy --base-path /repository-name

# Vercel
bunx @open330/kiwimu deploy --target vercel
```

GitHub Pages 배포는 `git remote origin`의 HTTPS/SSH URL에서 저장소 이름을 읽어 일반 프로젝트 사이트를 자동으로 `/repository-name/`에 맞춥니다. `owner.github.io` 저장소는 루트(`/`)로 배포하며, 추론할 수 없으면 잘못된 경로로 게시하지 않고 `--base-path` 입력을 요구합니다. 원본 `_site`는 변경하지 않고 임시 배포 복사본의 링크와 정적 런타임 경로만 변환하며 `.nojekyll`을 함께 게시합니다. Vercel과 로컬 `serve`는 기존 루트 경로를 그대로 사용합니다.

GitHub Pages/Vercel의 정적 산출물은 문서 탐색·검색·그래프·클라이언트 퀴즈를 제공하지만, 인증 서버가 없으므로 문서 추가·편집, Dynamic Q&A, Ask-the-Wiki, 학습 이력 저장 같은 `/api` 기능은 제공하지 않습니다. 이 기능이 필요하면 `kiwimu serve`를 운영하세요.

### 업그레이드와 백업

버전을 올리기 전 프로젝트 전체를 백업하고, 업데이트 후 `kiwimu status`와 `kiwimu build`를 실행해 스키마와 정적 산출물을 검증하세요. SQLite WAL을 포함한 정확한 백업·복원·무결성 검사와 복구 drill은 [백업·복원 운영 절차](docs/backup-restore.md)를 따릅니다.

## Commands

| 명령 | 설명 |
|------|------|
| `kiwimu init [name]` | 새 위키 프로젝트 생성 (interactive CLI) |
| `kiwimu init --demo` | 샘플 데이터로 즉시 체험 (API key 불필요) |
| `kiwimu add <source>` | URL 또는 파일 추가 (PDF, DOCX, PPTX, MD; DOC/PPT/KEY/RTF는 extractor 도구 필요). `--yes`로 비용 확인 스킵, `--force`로 강제 재인제스트 |
| `kiwimu add <directory>` | 디렉토리 내 모든 .md 파일 일괄 인제스트 |
| `kiwimu ask <question>` | 위키 전체에 질문 (RAG, 인용 포함) |
| `kiwimu index` | ask-the-wiki용 시맨틱 인덱스 증분 갱신 |
| `kiwimu build` | 정적 위키 사이트 빌드 |
| `kiwimu serve [-p port]` | 웹 서버 실행 (문서 추가/관리 가능) |
| `kiwimu quiz [-n count]` | 터미널에서 학습 퀴즈 풀기 |
| `kiwimu expand [--provider]` | LLM으로 문서 내용 확장 (선택) |
| `kiwimu deploy [--target] [--base-path]` | GitHub Pages / Vercel에 배포 (`--base-path`는 Pages 경로 override) |
| `kiwimu status` | 현재 위키 상태 표시 |

## Supported File Formats

| 형식 | 방법 |
|------|------|
| URL (HTTP/HTTPS) | Cheerio 웹 크롤링 |
| PDF | pdf-parse |
| DOCX | mammoth |
| PPTX | ZIP/XML 파싱 |
| DOC / RTF | `textutil` 필요 (일반적으로 macOS CLI) |
| PPT / KEY (Keynote) | `strings` 필요, 텍스트 추출 제한적 |
| Markdown (.md) | 직접 텍스트 추출 (디렉토리 일괄 지원) |

DOC/PPT/KEY/RTF는 선택적 레거시 지원입니다. `kiwimu add`를 실행하는 CLI/runtime의 `PATH`에 위 extractor 명령이 있어야 하며, macOS CLI의 기존 지원은 유지됩니다. `kiwimu serve` 관리 화면은 서버 시작 시 실제 명령 가용성을 검사해 업로드 가능한 형식만 표시합니다. 공식 Docker 이미지에는 해당 OS 명령을 추가하지 않으므로 서버 업로드 지원 범위는 PDF/DOCX/PPTX/MD입니다.

## Supported LLM Providers

| 프로바이더 | 추천 모델 | 비고 |
|-----------|----------|------|
| **Google Gemini** | `gemini-3.7-flash` | [무료 API key](https://aistudio.google.com/) |
| Azure OpenAI | `gpt-5.4-nano` | Azure 구독 필요 |
| OpenAI | `gpt-5.4` | API key 필요 |
| Anthropic | `claude-sonnet-4-6` | API key 필요 |
| Ollama | `llama3.1` | 로컬 실행·무료, API key 불필요 (`ollama serve`, 기본 `http://localhost:11434`) |
| OpenRouter | `openrouter/auto` | API key 필요 ([openrouter.ai/keys](https://openrouter.ai/keys)), 채팅 전용·모델별 가격 |

## Architecture

```
소스 (URL / PDF / DOCX / PPTX / MD + runtime extractor가 있는 레거시 형식)
    ↓
[ Ingest ]      ── Cheerio / pdf-parse / mammoth / jszip / MD 직접 추출 (+ 선택적 OS extractor)
    ↓
[ Phase 1 ]     ── LLM: 원본 구조 추출 (📖 원본 페이지) — 병렬 처리 (concurrency=3)
    ↓
[ Phase 2 ]     ── LLM: 개념 추출 (📝 개념 페이지)
    ↓
[ Phase 2.5 ]   ── LLM: 학습 퀴즈 자동 생성 (📝 퀴즈) — 병렬 처리
    ↓
[ Phase 3 ]     ── [[wiki link]] 해석 + 원본↔개념 cross-link
    ↓
[ Build ]       ── 정적 HTML (사이드바, KaTeX, Mermaid, 지식 그래프, 퀴즈, 다크 모드)
    ↓
[ Deploy ]      ── GitHub Pages / Vercel

[ Dynamic Q&A ] ── 텍스트 드래그 → 팝오버 → LLM 질문 → 새 개념 페이지 생성 + 하이라이트 링크
                   (serve 모드에서 실시간 동작)
```

```
project-dir/
├── kiwi.toml              # 프로젝트 + LLM 설정
├── kiwi.db                # SQLite (문서, 링크, 퀴즈, 사용량)
├── .kiwimu-runtime.db     # 요청 제한, 작업 상태, 프로세스 간 lease
├── uploads/               # 업로드된 파일
└── _site/                 # 빌드 결과
    ├── index.html         # 홈 (문서 목록)
    ├── graph.html         # 지식 그래프
    ├── quiz.html          # 학습 퀴즈
    ├── dashboard.html     # 학습 대시보드
    ├── wiki/              # 각 문서 페이지
    │   └── random.html    # 임의 문서
    ├── static/            # CSS, JS, 로고
    │   ├── dynamic-qa.js  # Dynamic Q&A (드래그→팝오버→질문)
    │   └── edit-page.js   # 웹 페이지 편집 모달
    └── search-index.json

src/
├── repositories/          # 퀴즈·활동·인용 데이터 접근 계층
├── server/                # 인증, 응답, 정적 HTML 등 서버 보조 모듈
├── services/
│   ├── dynamic-qa.ts      # Dynamic Q&A 서버 로직
│   ├── runtime-state.ts   # SQLite 기반 로컬 다중 프로세스 coordination
│   ├── runtime-coordinator.ts # SQLite/외부 coordinator 선택과 공통 계약
│   ├── redis-runtime-state.ts # Redis/Valkey 다중 호스트 coordination
│   └── ingest.ts          # 공유 인제스트 로직
├── ingest/
│   ├── markdown.ts        # Markdown 파일 파싱 (디렉토리 일괄 지원)
│   ├── web.ts / pdf.ts / docx.ts / pptx.ts
│   └── ...
├── demo/
│   ├── sample-data.ts     # 데모 샘플 데이터
│   └── setup.ts           # 데모 초기화
└── build/static/
    ├── dynamic-qa.js      # Dynamic Q&A 클라이언트
    ├── edit-page.js       # 페이지 편집 클라이언트
    └── vendor/            # 로컬 KaTeX·Mermaid·D3 런타임
```

빌드 결과의 다이어그램·그래프 런타임은 `_site/static/vendor`에 포함됩니다. 수식은 브라우저의 네이티브 MathML로 표시하고 글꼴은 시스템 글꼴을 사용하므로, 정적 위키는 CDN이나 Google Fonts 가용성에 의존하지 않습니다.

## Tech Stack

- **Bun** — 런타임, 패키지 매니저, 빌트인 SQLite
- **TypeScript** — 타입 안전한 파이프라인
- **@clack/prompts** — Interactive CLI
- **Cheerio** — 웹 페이지 파싱
- **Mammoth** — DOCX 파싱
- **JSZip** — PPTX 파싱
- **Marked** + **sanitize-html** — Markdown → 안전한 HTML
- **D3.js** — 지식 그래프
- **KaTeX** — LaTeX 수학 수식 렌더링
- **Mermaid.js** — 다이어그램 렌더링
- **gh-pages** — GitHub Pages 배포

## 출시 검증

```bash
bun run check
bunx playwright install chromium
bun run test:e2e

# 실제 Redis/Valkey 두 클라이언트 통합 검사
KIWIMU_TEST_REDIS_URL=redis://127.0.0.1:6379 bun run test:redis
```

자동 접근성 tree, 키보드, reduced-motion, forced-colors, axe 검사는 E2E에 포함됩니다. 정식 후보 빌드의 실제 VoiceOver/NVDA 청취 검사는 [접근성 출시 체크리스트](docs/accessibility-release-checklist.md)에 검사자·날짜·이슈를 기록해 별도로 sign-off합니다.

## Security

- `HttpOnly` 쿠키 + Bearer 토큰 인증 (serve 모드, 쿼리 토큰 즉시 제거)
- SSRF 방지 (프라이빗 IP 차단, 리다이렉트 재검증)
- Path Traversal 방지 (resolve 검증)
- XSS 방지 (sanitize-html, escapeHtml, 실행 스크립트는 external self-only CSP)
- 파일 업로드 제한 (50MB, body 파싱 전 동시성 admission)

## Privacy

kiwimu는 **텔레메트리나 사용량 분석을 수집하지 않습니다.** 실행 중 외부로 나가는 네트워크 요청은 모두 사용자가 직접 트리거하는 다음 세 가지뿐입니다:

1. 사용자가 설정한 **LLM·임베딩 프로바이더** — 콘텐츠 생성·질의·임베딩
2. 사용자가 `add`로 추가한 **URL 소스**
3. 사용자가 `deploy`로 실행한 **배포 대상** (GitHub Pages / Vercel)

kiwimu가 운영하는 서버로 데이터를 보내는 콜백·핑·분석 비콘은 없습니다. 문서·위키·학습 이력·사용량 로그는 모두 로컬 SQLite(`kiwi.db`)에 저장되며(`usage`·`activity` 기록도 로컬 전용), 정적 배포 산출물에도 서드파티 분석 스크립트를 주입하지 않습니다.

## License

MIT
