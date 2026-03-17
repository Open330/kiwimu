<div align="center">

<img src="assets/logos/logo_2_minimalist_icon_transparent.png" alt="Kiwi Mu" width="120">

# Kiwi Mu

**나만의 학습 위키를 만드세요**

전공책, PDF, 웹 콘텐츠를 넣으면 — LLM이 챕터/개념별로 분석하여 상호 링크된 학습 위키를 자동 생성합니다.

[![Bun](https://img.shields.io/badge/Bun-1.0+-fbf0df?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

---

## Quickstart for Agents

<div><img src="https://quickstart-for-agents.vercel.app/api/header.svg?theme=claude-code&logo=kiwimu&title=Set+up+a+learning+wiki+from+any+textbook+or+URL&lang=Agents&font=mono&mascot=hat" width="100%" /></div>

```
git clone https://github.com/Open330/kiwimu.git && cd kiwimu && bun install
mkdir my-wiki && cd my-wiki
bunx kiwimu init
bunx kiwimu add "<YOUR_URL_OR_PDF>"
bunx kiwimu serve
```

<div><img src="https://quickstart-for-agents.vercel.app/api/footer.svg?theme=claude-code&text=copy+this+prompt+%C2%B7+paste+into+your+agent+%C2%B7+get+a+learning+wiki&font=mono" width="100%" /></div>

---

## Why Kiwi Mu?

교과서 한 권을 읽으면 수십 개의 개념이 서로 연결됩니다.
Kiwi Mu는 LLM을 활용해 이 연결을 **자동으로** 만들어, 지식을 빠르게 탐색할 수 있는 위키로 변환합니다.

- **LLM 기반 문서 분석** — 챕터/섹션 구조를 보존한 원본 페이지 + 핵심 개념별 자동 생성 페이지
- **원본/개념 분리** — 📖 원본 문서와 📝 개념 문서를 시각적으로 구분
- **자동 상호 링크** — 원본↔개념 간 유기적 cross-link + 외부 참고 자료 (Wikipedia 등)
- **지식 그래프** — D3.js 인터랙티브 그래프 (원본: 파란색, 개념: 초록색)
- **웹 UI** — 브라우저에서 문서 추가, 설정 변경, 빌드 실행
- **다양한 파일 지원** — URL, PDF, DOCX, PPTX, PPT, DOC, KEY
- **다중 LLM 프로바이더** — Google Gemini, Azure OpenAI, OpenAI, Anthropic
- **토큰 사용량 추적** — API 호출 수, 토큰, 예상 비용을 웹에서 확인
- **원클릭 배포** — GitHub Pages / Vercel

## Quick Start

### 설치

```bash
git clone https://github.com/Open330/kiwimu.git
cd kiwimu && bun install
```

### 프로젝트 생성 (Interactive CLI)

```bash
mkdir my-wiki && cd my-wiki
bunx kiwimu init
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
│  gemini-2.0-flash-lite

◆ API Key
│  ••••••••••••

🥝 'Radio Astronomy Wiki' 위키가 생성되었습니다!
```

이름을 바로 지정할 수도 있습니다:

```bash
bunx kiwimu init "My Study Wiki"
```

### 문서 추가

```bash
# URL 추가
bunx kiwimu add "https://www.cv.nrao.edu/~sransom/web/Ch1.html"

# PDF 추가
bunx kiwimu add textbook.pdf
```

LLM이 문서를 분석하여:
1. 📖 **원본 페이지** — 원래 챕터/섹션 구조 보존
2. 📝 **개념 페이지** — 핵심 용어·정의·법칙 자동 생성
3. 🔗 **Cross-link** — 원본↔개념 간 유기적 연결

### 빌드 및 서버

```bash
# 정적 사이트 빌드
bunx kiwimu build

# 로컬 서버 실행 (웹에서 문서 추가 가능)
bunx kiwimu serve
# → http://localhost:8000

# 포트 변경
bunx kiwimu serve -p 3000

# 네트워크에 공개 (0.0.0.0)
bunx kiwimu serve --host 0.0.0.0
```

### 웹 UI에서 문서 추가

`kiwimu serve` 실행 후 http://localhost:8000 에서:
- **🔗 URL 탭** — URL 입력 후 추가
- **📄 파일 업로드 탭** — PDF, DOCX, PPTX 등 드래그앤드롭 업로드
- 진행 상태 실시간 표시, 완료 시 자동 새로고침

### 관리 페이지

http://localhost:8000/admin 에서:
- 위키 이름 변경
- LLM 프로바이더/모델/API Key 설정
- 토큰 사용량 및 예상 비용 확인
- 등록된 소스 목록
- 수동 빌드 실행

### 배포

```bash
# GitHub Pages (기본)
bunx kiwimu deploy

# Vercel
bunx kiwimu deploy --target vercel
```

## Commands

| 명령 | 설명 |
|------|------|
| `kiwimu init [name]` | 새 위키 프로젝트 생성 (interactive CLI) |
| `kiwimu add <source>` | URL 또는 파일 추가 (LLM 분석 + 링크 생성) |
| `kiwimu build` | 정적 위키 사이트 빌드 |
| `kiwimu serve [-p port] [--host host]` | 웹 서버 실행 (문서 추가/관리 가능) |
| `kiwimu deploy` | GitHub Pages / Vercel에 배포 |
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

## Supported LLM Providers

| 프로바이더 | 추천 모델 | 비고 |
|-----------|----------|------|
| **Google Gemini** | `gemini-2.0-flash-lite` | [무료 API key](https://aistudio.google.com/) |
| Azure OpenAI | `gpt-5-nano` | Azure 구독 필요 |
| OpenAI | `gpt-4o-mini` | API key 필요 |
| Anthropic | `claude-sonnet-4-20250514` | API key 필요 |

## Architecture

```
소스 (URL / PDF / DOCX / PPTX)
    ↓
[ Ingest ]    ── Cheerio / pdf-parse / mammoth / jszip
    ↓
[ Phase 1 ]   ── LLM: 원본 구조 추출 (📖 원본 페이지)
    ↓
[ Phase 2 ]   ── LLM: 개념 추출 (📝 개념 페이지)
    ↓
[ Phase 3 ]   ── [[wiki link]] 해석 + 원본↔개념 cross-link
    ↓
[ Build ]     ── 정적 HTML 생성 (탭 사이드바, KaTeX, 지식 그래프)
    ↓
[ Deploy ]    ── GitHub Pages / Vercel
```

```
project-dir/
├── kiwi.toml          # 프로젝트 + LLM 설정
├── kiwi.db            # SQLite (문서, 링크, 사용량)
├── uploads/           # 업로드된 파일
└── _site/             # 빌드 결과
    ├── index.html     # 홈 (문서 추가 UI + 사용량 대시보드)
    ├── graph.html     # 지식 그래프
    ├── wiki/          # 각 문서 페이지
    ├── static/        # CSS, JS, 로고
    └── search-index.json
```

## Tech Stack

- **Bun** — 런타임, 패키지 매니저, 빌트인 SQLite
- **TypeScript** — 타입 안전한 파이프라인
- **@clack/prompts** — Interactive CLI
- **Cheerio** — 웹 페이지 파싱
- **Mammoth** — DOCX 파싱
- **JSZip** — PPTX 파싱
- **Marked** — Markdown → HTML
- **D3.js** — 지식 그래프
- **KaTeX** — 수학 수식 렌더링
- **gh-pages** — GitHub Pages 배포

## License

MIT
