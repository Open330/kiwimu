# kiwimu v1.1 SNS 발행 스케줄

## D-2 (GIF 녹화 전일)
- [ ] 로컬 프리뷰: `bun run dev` → BST → "회전" 드래그 → Save to Wiki → 토스트/사이드바 확인
- [ ] CleanShot X 설치/확인
- [ ] 녹화 환경 세팅 (해상도 1080p, 마우스 커서 강조, 배경 정리)

## D-1 (GIF 녹화일)
- [ ] 30초 GIF 3 takes 녹화
- [ ] 5초 반응 테스트 (3명에게 첫 5초 보여주기)
- [ ] 최종 take 선택

## D-Day (발행일)
- [ ] 후반작업: 트리밍 + 한/영 자막 입히기
- [ ] 4가지 포맷 내보내기:
  - X/Twitter: GIF (≤15MB) 또는 MP4
  - LinkedIn: MP4 (세로 크롭 없이 16:9)
  - Threads: MP4 (세로 9:16 크롭)
  - 블로그: MP4 + WebP
- [ ] 랜딩 페이지 배포: jiun.dev/kiwimu/demo
- [ ] 팔로우업 블로그 글 배포: jiun.dev/posts/kiwimu

### 발행 순서
1. **블로그** 먼저 (소개 링크의 최종 목적지)
2. **GitHub README 업데이트** (v1.1 기능 추가, GIF 삽입)
3. **X/Twitter** — GIF + 1줄 요약
4. **LinkedIn** — GIF + 전문가 관점 코멘트
5. **Threads** — GIF + 캐주얼 톤

### X/Twitter 문안 (한/영)

**한국어:**
> 모르는 문장을 드래그하면 AI가 답을 써주고, 한 번 클릭하면 위키 페이지가 됩니다.
> kiwimu v1.1 — 위키는 만드는 게 아니라 자라는 거였다.
> bunx @open330/kiwimu init --demo

**English:**
> Highlight text you don't understand → ask → AI writes the answer → one click → it's a wiki page.
> kiwimu v1.1 — wikis grow, they aren't made.
> bunx @open330/kiwimu init --demo

### LinkedIn 문안

> kiwimu v1.1을 공개합니다. 한 줄로: **위키는 만드는 게 아니라 자라는 거였다.**
>
> v1.0이 "문서를 넣으면 위키가 된다"를 증명한 버전이었다면, v1.1은 그 위키가 **읽는 동안 알아서 자라나는** 구조를 만든 업데이트입니다.
>
> 핵심은 단순합니다.
> 1. 위키 본문에서 모르는 문장을 드래그합니다.
> 2. 팝오버에 "이게 뭔데?" 한 줄 질문합니다.
> 3. AI가 답을 씁니다.
> 4. "위키에 저장" 한 번 누르면 정식 페이지가 됩니다.
>
> 그 자연스러운 행동이 위키를 키우는 동력이 됩니다. 문서를 처음부터 "쓰는" 사람은 적지만, 읽다가 막히는 사람은 모두입니다. 그 막히는 순간을 페이지로 변환해주는 것이 v1.1의 목표였습니다.
>
> 옆에 함께 들어간 일곱 가지:
> · 모든 AI 문장에 인라인 인용 자동 부착 — 신뢰 가능한 위키
> · kiwi.toml 5줄 스키마로 LLM 톤·카테고리 강제
> · 카탈로그 페이지 — 100개 페이지에서 길 잃지 않기
> · 활동 로그 — 위키가 실제로 쓰이고 있는지 시간선으로 확인
> · 링크 미리보기 패널 — 페이지 이동 없이 확인
> · 트랙 그룹핑 — 사이드바·인덱스를 학습 경로별로 자동 묶음
> · 인증 토큰 영속화 — 한 번 로그인하면 재시작해도 유지
>
> 셀프호스팅, MIT, 텔레메트리 없음. 30초 데모:
> `bunx @open330/kiwimu init --demo`
>
> 글: jiun.dev/posts/kiwimu
> 코드: github.com/Open330/kiwimu
>
> #LLM #OpenSource #DeveloperTools #KnowledgeManagement #Wiki

### Threads 문안 (한국어, 5-스레드)

**1/5**
> 위키 안 만들어 봤어요? 저도요.
> 근데 만들기 전에 "위키가 자라난다"는 게 뭔지 30초만 보고 가세요.
> [GIF]

**2/5**
> kiwimu v1.1을 공개합니다.
> 한 줄로: 위키는 만드는 게 아니라 자라는 거였다.
> 본문 드래그 → AI 질문 → 답변 → 한 번 클릭으로 정식 페이지 승격.

**3/5**
> 핵심 인사이트는 간단해요.
> "문서를 처음부터 쓰는 사람은 적지만, 읽다가 막히는 사람은 모두."
> 그 막히는 순간을 페이지로 변환해주는 게 v1.1의 목표였어요.

**4/5**
> 옆에 들어간 것들:
> ✅ 모든 AI 문장에 인용 자동 부착
> ✅ 5줄 스키마로 LLM 강제
> ✅ 카탈로그 + 활동 로그
> ✅ 링크 호버 미리보기

**5/5**
> 셀프호스팅, MIT, 텔레메트리 없음.
> bunx @open330/kiwimu init --demo
>
> 코드 → github.com/Open330/kiwimu
> 글 → jiun.dev/posts/kiwimu

## D+1 ~ D+5

### HN Show 본문
**제목:** Show HN: kiwimu v1.1 – Wikis grow, they aren't made

**본문:**
> Hi HN, I'm jiun, the author of kiwimu — a self-hosted CLI that turns documents (PDF, DOCX, URL, Markdown) into a hyperlinked learning wiki using LLMs.
>
> v1.0 (released a month ago) proved the basic loop: drop in a textbook, get a navigable wiki + auto-generated quizzes. v1.1 changes the philosophy from "make a wiki" to "let the wiki grow as you read it." Seven things shipped:
>
> 1. **Inline citations on every AI-generated sentence.** Each sentence ends with a `[^src:slug]` pointer to the source page. There's also a coverage matrix that surfaces pages where the AI made claims with no source backing — the biggest legitimacy hole for AI-generated wikis.
>
> 2. **Schema layer.** Five lines in `kiwi.toml` define your team's categories, page templates, and tone constraints. The LLM operates inside that schema or doesn't operate at all. This was the most-requested v1.0 feature: people wanted consistency without a human moderator.
>
> 3. **Query → wiki promotion (the killer feature).** Highlight any sentence in a wiki page → popover asks for your question → LLM writes a concept page → one click promotes it to a real linked page. With duplicate detection so you don't fork existing pages. The natural reading-when-stuck moment becomes the wiki's growth engine.
>
> 4. **Content catalog + activity log.** Auto-categorized index page so you don't lose your way at 100+ pages, and a timeline of every page creation, question, promotion, and schema change.
>
> 5. **Peek panel.** Click any internal `/wiki/*` link → a resizable side panel slides in with the linked page's body, fully interactive (drag-Q&A, inline edit, diagrams all work inside). Wikipedia-style hover preview but for your own wiki, on steroids.
>
> 6. **Config-driven track grouping.** Define learning tracks in `kiwi.toml` and the sidebar + index auto-group pages by track. The structure of the wiki itself becomes the table of contents.
>
> 7. **Persisted auth tokens.** v1.0 reissued a fresh token on every restart, which broke any browser session. v1.1 caches it on disk and accepts it via cookie, so authentication survives restarts. `KIWI_AUTH_TOKEN` env var works too if you want to pin it for CI.
>
> Stack: Bun + TypeScript, SQLite (FTS5 + embeddings), zero runtime deps for the static site. MIT, no telemetry, optional 4 LLM providers (Gemini free tier works fine).
>
> 30s try:
> ```
> bunx @open330/kiwimu init --demo
> ```
>
> Repo: https://github.com/Open330/kiwimu
> Long-form post: https://jiun.dev/posts/kiwimu
>
> Happy to discuss design decisions — especially the citation pipeline (LLM-as-judge for source attribution turned out trickier than I expected) and the schema enforcement (deterministic post-processing vs system prompt vs structured output, all three have failure modes).

### dev.to 본문 (영문)
> 블로그 글 `blog-v1-1.md`의 영문 번역 버전. dev.to 형식 (frontmatter + tags). 작성 필요 — 한글 원문 135줄, 번역 + 영문 톤 조정 + tags(`#opensource #ai #wiki #llm #typescript`) 추가.
>
> 시간 절약을 위해 HN Show 본문을 토대로 확장하는 게 더 빠를 수 있음.

### Reddit r/programming
**제목:** kiwimu v1.1 — turn any document into a self-growing wiki via inline LLM Q&A (MIT, self-hosted)

**본문:**
> v1.1 of kiwimu just shipped. It's a CLI that converts documents into hyperlinked wikis with LLM-generated cross-links. The new version focuses on letting the wiki **grow while you read it**, rather than treating wiki generation as a one-shot batch job.
>
> The core interaction is what I'd call "reading-driven authoring":
>
> - Highlight a sentence you don't understand inside any wiki page
> - Ask a question in the popover
> - LLM writes a concept page answering it
> - One click promotes that answer to a fully linked wiki page (with duplicate detection)
>
> Each AI-generated sentence carries an inline citation pointing to its source. There's a coverage matrix to flag pages that have AI claims with no source attribution — the standard legitimacy problem for AI-generated docs.
>
> Schema layer in `kiwi.toml` lets you constrain LLM output to your team's categories, page templates, and tone (5 lines of TOML).
>
> Stack: Bun, TypeScript, SQLite (FTS5 + embeddings). MIT, no telemetry. Demo runs without an API key.
>
> ```bash
> bunx @open330/kiwimu init --demo
> ```
>
> Repo: https://github.com/Open330/kiwimu
> Writeup: https://jiun.dev/posts/kiwimu
>
> Discussion welcome — particularly interested in feedback on the citation enforcement (LLM-as-judge has been the trickiest piece).

### Reddit r/selfhosted
**제목:** kiwimu v1.1 — self-hosted learning wiki builder, MIT, no telemetry, no API key required for demo

**본문:**
> v1.1 of kiwimu is out. It's a CLI that takes documents (PDF, DOCX, URL, Markdown) and builds a self-hosted, hyperlinked learning wiki. Fully MIT, zero telemetry, runs entirely on your machine.
>
> A demo mode runs without any API key — you get a sample wiki on quantum mechanics + data structures preloaded with quizzes:
>
> ```bash
> bunx @open330/kiwimu init --demo
> ```
>
> Then `kiwimu serve` and you're at `localhost:8000`.
>
> v1.1 highlights:
>
> - Inline LLM Q&A: highlight any text in a wiki page, ask a question, get an answer that promotes to a real page in one click
> - Schema layer (`kiwi.toml`) — define categories/templates/tone in 5 lines, LLM follows them
> - Inline citations on all AI-generated content with a coverage matrix
> - Activity log so you can see how the wiki is actually being used
> - Resizable peek panel on internal links (page body, edit, drag-Q&A all inside)
> - Track grouping — sidebar/index auto-grouped by learning track defined in config
> - Persisted auth: log in once, your session survives `kiwimu serve` restarts
>
> LLM provider is your choice: Gemini (free), OpenAI, Anthropic, Azure OpenAI. Pick one and drop the key into the config.
>
> Hosting story: static site builds via `kiwimu build` for read-only deploys, or `kiwimu serve` for the editable + dynamic Q&A version. SQLite under the hood, easy to back up.
>
> Repo: https://github.com/Open330/kiwimu
> Writeup: https://jiun.dev/posts/kiwimu

### 그 외
- [ ] 댓글/멘션 모니터링 및 응답 (24h 적극 응답)