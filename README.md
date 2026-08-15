<div align="center">

<img src="assets/logos/logo_2_minimalist_icon_transparent.png" alt="Kiwi Mu" width="120">

# Kiwi Mu

**Turn any textbook into your personal learning wiki**

전공책, PDF, 웹 콘텐츠를 넣으면 — LLM이 자동으로 상호 링크된 학습 위키 + 퀴즈를 생성합니다.

[![npm](https://img.shields.io/npm/v/@open330/kiwimu?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/@open330/kiwimu)
[![Bun](https://img.shields.io/badge/Bun-1.0+-fbf0df?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<br>

<img src="https://github.com/Open330/kiwimu/raw/main/.context/marketing/demo.gif" alt="kiwimu v1.1 데모: 본문 드래그 → 질문 → 위키 페이지로 저장" width="720">

<br>

> **v1.1 — 위키는 만드는 게 아니라 자라는 거였다.**
> 본문 드래그 → 팝오버 질문 → AI 답변 → 한 번 클릭으로 정식 위키 페이지로 승격. ([상세 글](https://jiun.dev/posts/kiwimu-v1-1))

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
- **다양한 파일 지원** — URL, PDF, DOCX, PPTX, PPT, DOC, KEY, RTF, **MD** (디렉토리 일괄 인제스트 지원)
- **4개 LLM 프로바이더** — Google Gemini, Azure OpenAI, OpenAI, Anthropic
- **다크 모드** — 시스템 테마에 자동 대응 (100% 커버리지)
- **모바일 지원** — 햄버거 메뉴 + 슬라이드 사이드바
- **접근성** — ARIA 속성, 검색 키보드 네비게이션
- **웹 UI** — 브라우저에서 문서 추가, 설정 변경, 빌드 실행
- **토큰 사용량 추적** — API 호출 수, 토큰, 예상 비용을 웹에서 확인
- **원클릭 배포** — GitHub Pages / Vercel
- **라이브 데모** — [kiwimu.internal.jiun.dev](https://kiwimu.internal.jiun.dev)

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

```bash
# npm/bunx로 바로 사용 (설치 불필요)
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

# 파일 추가 (PDF, DOCX, PPTX, DOC, PPT, KEY, RTF)
bunx @open330/kiwimu add textbook.pdf
bunx @open330/kiwimu add lecture.pptx
```

LLM이 문서를 분석하여:
1. 📖 **원본 페이지** — 원래 챕터/섹션 구조 보존
2. 📝 **개념 페이지** — 핵심 용어·정의·법칙 자동 생성
3. 🔗 **Cross-link** — 원본↔개념 간 유기적 연결
4. 📝 **퀴즈** — 개념별 학습 퀴즈 자동 생성

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

`kiwimu serve` 실행 후 콘솔에 표시되는 관리 URL (`/manage?token=...`)로 접속:
- 위키 이름 변경
- LLM 프로바이더/모델/API Key 설정
- 토큰 사용량 및 예상 비용 확인
- 파일 업로드 (PDF, DOCX, PPTX 등)
- URL 추가
- 수동 빌드 실행
- 페르소나 관리

### 배포

```bash
# GitHub Pages (기본)
bunx @open330/kiwimu deploy

# Vercel
bunx @open330/kiwimu deploy --target vercel
```

## Commands

| 명령 | 설명 |
|------|------|
| `kiwimu init [name]` | 새 위키 프로젝트 생성 (interactive CLI) |
| `kiwimu init --demo` | 샘플 데이터로 즉시 체험 (API key 불필요) |
| `kiwimu add <source>` | URL 또는 파일 추가 (PDF, DOCX, PPTX, DOC, PPT, KEY, RTF, MD). `--yes`로 비용 확인 스킵, `--force`로 강제 재인제스트 |
| `kiwimu add <directory>` | 디렉토리 내 모든 .md 파일 일괄 인제스트 |
| `kiwimu ask <question>` | 위키 전체에 질문 (RAG, 인용 포함) |
| `kiwimu index` | ask-the-wiki용 시맨틱 인덱스 증분 갱신 |
| `kiwimu build` | 정적 위키 사이트 빌드 |
| `kiwimu serve [-p port]` | 웹 서버 실행 (문서 추가/관리 가능) |
| `kiwimu quiz [-n count]` | 터미널에서 학습 퀴즈 풀기 |
| `kiwimu expand [--provider]` | LLM으로 문서 내용 확장 (선택) |
| `kiwimu deploy [--target]` | GitHub Pages / Vercel에 배포 |
| `kiwimu status` | 현재 위키 상태 표시 |

## Supported File Formats

| 형식 | 방법 |
|------|------|
| URL (HTTP/HTTPS) | Cheerio 웹 크롤링 |
| PDF | pdf-parse |
| DOCX | mammoth |
| PPTX | ZIP/XML 파싱 |
| DOC / PPT / RTF | macOS textutil |
| KEY (Keynote) | 텍스트 추출 (제한적) |
| Markdown (.md) | 직접 텍스트 추출 (디렉토리 일괄 지원) |

## Supported LLM Providers

| 프로바이더 | 추천 모델 | 비고 |
|-----------|----------|------|
| **Google Gemini** | `gemini-3.7-flash` | [무료 API key](https://aistudio.google.com/) |
| Azure OpenAI | `gpt-5.4-nano` | Azure 구독 필요 |
| OpenAI | `gpt-5.4` | API key 필요 |
| Anthropic | `claude-sonnet-4-6` | API key 필요 |

## Architecture

```
소스 (URL / PDF / DOCX / PPTX / DOC / PPT / KEY / RTF / MD)
    ↓
[ Ingest ]      ── Cheerio / pdf-parse / mammoth / jszip / textutil / MD 직접 추출
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
├── services/
│   ├── dynamic-qa.ts      # Dynamic Q&A 서버 로직
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
    └── edit-page.js       # 페이지 편집 클라이언트
```

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

## Security

- Bearer 토큰 인증 (serve 모드)
- SSRF 방지 (프라이빗 IP 차단, 리다이렉트 재검증)
- Path Traversal 방지 (resolve 검증)
- XSS 방지 (sanitize-html, CSP 헤더, escapeHtml)
- 파일 업로드 제한 (50MB)

## License

MIT
