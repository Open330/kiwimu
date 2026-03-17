<div align="center">

# 🥝 kiwimu

**나만의 학습 위키를 만드세요**

전공책, PDF, 웹 콘텐츠를 넣으면 — 나무위키처럼 상호 링크된 개인 위키가 만들어집니다.

[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<br>

```
kiwimu init "양자역학"
kiwimu add quantum-mechanics.pdf
kiwimu add "https://feynmanlectures.caltech.edu/III_01.html"
kiwimu build && kiwimu serve
```

</div>

---

## Why kiwimu?

교과서 한 권을 읽으면 수십 개의 개념이 서로 연결됩니다.
kiwimu는 이 연결을 **자동으로** 만들어, 지식을 빠르게 탐색할 수 있는 위키로 변환합니다.

- **자동 문서 분할** — 챕터/섹션 단위로 위키 페이지 생성
- **자동 상호 링크** — 문서 간 개념 참조를 감지해 나무위키처럼 연결
- **지식 그래프** — Obsidian 스타일 D3.js 인터랙티브 그래프
- **검색** — 즉시 검색되는 퍼지 매칭
- **LLM 확장** — Claude, GPT 등으로 문서를 더 풍부하게 (선택사항)
- **100% 로컬** — API 키 없이도 완전히 동작

## Quick Start

```bash
# 설치
git clone https://github.com/jiunbae/kiwimu.git
cd kiwimu
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

# 위키 생성
mkdir my-wiki && cd my-wiki
kiwimu init "Radio Astronomy"
kiwimu add "https://www.cv.nrao.edu/~sransom/web/Ch1.html"
kiwimu add "https://www.cv.nrao.edu/~sransom/web/Ch2.html"
kiwimu build
kiwimu serve
# → http://localhost:8000 에서 위키 확인
```

## Commands

| 명령 | 설명 |
|------|------|
| `kiwimu init <name>` | 빈 위키 프로젝트 생성 |
| `kiwimu add <source>` | URL 또는 PDF 추가 (자동 파싱 + 링크) |
| `kiwimu expand` | LLM으로 문서 확장 (선택사항) |
| `kiwimu build` | 정적 위키 사이트 빌드 |
| `kiwimu serve` | 로컬 서버 실행 (`http://localhost:8000`) |
| `kiwimu status` | 현재 위키 상태 표시 |

## Features

### 나무위키 스타일 UI

깔끔한 사이드바, 목차, 백링크를 갖춘 위키 인터페이스.
각 페이지에서 관련 문서로 바로 이동할 수 있습니다.

### 지식 그래프

D3.js force-directed 그래프로 문서 간 관계를 시각화합니다.
노드 크기는 연결 수에 비례하고, 클릭하면 해당 문서로 이동합니다.

### LLM 확장 (선택)

API 키가 있다면 문서를 자동으로 풍부하게 만들 수 있습니다.

```bash
# Anthropic API
export ANTHROPIC_API_KEY="sk-..."
kiwimu expand --provider anthropic

# OpenAI API
export OPENAI_API_KEY="sk-..."
kiwimu expand --provider openai

# Claude Code CLI
kiwimu expand --provider claude-cli

# 특정 문서만 확장
kiwimu expand --provider anthropic --pages blackbody-radiation --pages polarization
```

## Architecture

```
소스 (URL/PDF)
    ↓
[ Ingest ] ── 웹 스크래핑 / PDF 파싱
    ↓
[ Chunk ]  ── 섹션 단위로 문서 분할
    ↓
[ Link ]   ── 문서 간 자동 링크 생성
    ↓
[ Build ]  ── Jinja2 → 정적 HTML
    ↓
[ Serve ]  ── http://localhost:8000
```

```
project-dir/
├── kiwi.toml          # 프로젝트 설정
├── kiwi.db            # SQLite (문서, 링크, 소스)
└── _site/             # 빌드 결과
    ├── index.html
    ├── graph.html
    ├── wiki/          # 각 문서 페이지
    ├── static/        # CSS, JS
    └── search-index.json
```

## Tech Stack

- **Python 3.11+** — Click CLI, Jinja2 템플릿, Markdown 렌더링
- **SQLite** — 문서/링크/소스 저장 (파일 하나, 서버 불필요)
- **BeautifulSoup** — 웹 페이지 파싱
- **PyMuPDF** — PDF 텍스트 추출
- **D3.js** — 지식 그래프 시각화
- **KaTeX** — 수학 수식 렌더링

## License

MIT
