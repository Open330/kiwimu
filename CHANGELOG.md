# Changelog

## [1.2.0] - 2026-07-06

### Added
- **위키 전체 질의 (Ask-the-Wiki / RAG)** — 페이지를 청크 단위로 임베딩해 시맨틱 검색 + 위키 전체 대상 채팅 (`kiwimu ask`, serve 모드 `/api/ask-wiki`, `kiwimu index` 증분 인덱싱)
- **그림 추출 (Figure Extraction)** — PDF의 다이어그램·그림을 자동 추출해 위키 페이지에 임베드, 멀티모달 LLM 캡션 생성 (vision 미지원/도구 미설치 시 자동 건너뜀)
- **비용 미리보기** — `add` 실행 시 예상 토큰·비용을 먼저 표시하고 확인 (`--yes`로 스킵)
- LLM 파이프라인·핵심 서비스 characterization 테스트 (총 103개)

### Changed
- **증분 재인제스트** — 내용이 바뀐 문서만 다시 처리, 변경 없으면 LLM 호출 없이 스킵 (`--force`로 강제)

## [1.1.0] - 2026-05-08

### Added
- **출처 추적 (Provenance Tracking)** — 모든 AI 생성 문장에 인라인 인용 자동 부착, 출처 커버리지 행렬 (`/provenance`)
- **스키마 레이어** — `kiwi.toml`로 카테고리·용어·페이지 템플릿을 정의하면 LLM이 그 안에서만 작동
- **질문 → 위키 승격** — 본문 드래그 → 질문 → 클릭 한 번으로 정식 페이지 승격, 중복 자동 감지
- **콘텐츠 카탈로그** — 자동 카테고리 분류 + 출처 커버리지 뷰
- **활동 로그** — 페이지 생성·질문·프로모트·스키마 변경 시간선 (`/activity`)
- **링크 미리보기 (Peek Panel)** — `/wiki/*` 링크 클릭 시 우측 슬라이드 패널 미리보기
- **트랙 그룹핑** — 사이드바·인덱스를 카테고리(트랙)별로 그룹 표시

### Changed
- 인증 토큰 영속화 — 서버 재시작에도 쿠키 기반 인증 유지 (`.kiwi-token` 파일, `KIWIMU_AUTH_TOKEN` env 지원)

## [1.0.1] - 2026-03-29

### Fixed
- 배포 이슈 수정 — 정적 파일 URL 디코딩, CSP 헤더, 로고 경로
- 관리 페이지 경로 `admin` → `manage` 변경

## [1.0.0] - 2026-03-29

### Added
- SM-2 간격 반복(spaced repetition) 기반 퀴즈 복습
- 웹 에디터 (페이지 인라인 편집)
- CS 데모 위키

### Changed
- 기술 부채 정리 (전역 상태 제거, 모듈 경계 정비)

## [0.9.1] - 2026-03-29

### Fixed
- Remove global `style` attribute from sanitize-html allowlist (CSS injection prevention)
- Convert all `require()` calls to dynamic `import()` for ESM consistency (6 occurrences)
- Remove deprecated global LLM wrappers (`setLLMConfig`, `chatComplete`, etc.)

### Added
- SECURITY.md with vulnerability reporting policy and security feature documentation

## [0.9.0] - 2026-03-28

### Changed
- Extract shared `renderPageContent()` in renderer to eliminate duplicated markdown rendering + sanitization logic
- `llmChunkDocument` now requires `LLMClient` parameter (no longer falls back to deprecated global state)
- `htmlToRawText` is now async (uses dynamic `import("cheerio")` instead of `require`)

### Removed
- Deprecated global state LLM wrappers: `setLLMConfig`, `chatComplete`, `getUsageStats`, `resetUsageStats`, `getEstimatedCost`, `printUsageSummary`

## [0.8.0] - 2026-03-20

### Added
- Spaced repetition: smart quiz selection (unattempted → wrong → oldest correct)
- Quiz attempts tracking (quiz_attempts table)
- Quiz explanations with LLM-generated context
- Learning stats display (correct rate, weak concepts)
- Higher Bloom's taxonomy quiz prompts
- CONTRIBUTING.md with dev setup and guidelines
- CHANGELOG.md
- GitHub issue templates (bug report, feature request)
- GitHub pull request template
- .npmignore to exclude test files from npm
- CLI file format validation
- Phase timing display ("Phase 1 완료 (12.3초)")

### Fixed
- Exit codes: errors now exit with code 1
- stderr separation: errors use console.error
- Quiz answer matching: exact match only (no partial substring)

## [0.7.1] - 2026-03-20

### Fixed
- Quiz page XSS vulnerability (DOM API for safe rendering)
- Quiz answer normalization (trim, lowercase, whitespace collapse)

### Added
- 8 demo quiz questions for instant experience
- Demo quizzes showcase fill_blank, ox, short_answer types

## [0.7.0] - 2026-03-20

### Added
- OpenAI provider support (gpt-4o default)
- Anthropic provider support (claude-sonnet default)
- Demo mode: `kiwimu init --demo` (no API key needed)
- Learning quiz system with Phase 2.5 LLM generation
- Quiz page with card-flip animation and score tracking
- CLI `kiwimu quiz` command for terminal-based learning
- SDK client caching for all LLM providers

## [0.6.0] - 2026-03-20

### Added
- Unit tests (33 tests: slugify, Store CRUD, validateUrl)
- Mobile hamburger menu with slide-in sidebar
- Search keyboard navigation (Arrow keys, Enter, / shortcut)
- Random page button (🎲 임의 문서)
- Dark mode support (@media prefers-color-scheme)
- CLI support for all file formats (DOCX, PPTX, DOC, PPT, KEY, RTF)

### Changed
- Architecture: index.ts split into server.ts + services/ingest.ts (735→308 lines)
- LLM client: global state → class-based (LLMClient)
- All `any` types removed (19→0), using `unknown` with proper narrowing

### Removed
- Dead code: llm-linker.ts, extractSections, extractHtmlFromDocx

## [0.5.1] - 2026-03-19

### Added
- LLM Phase 1 parallelization (concurrency=3, ~60% speedup)
- HTML sanitization (sanitize-html for XSS prevention)
- Content-Security-Policy header
- SSRF redirect prevention (manual redirect with re-validation)

### Changed
- Gemini API key: URL query → x-goog-api-key header
- Index page: upload forms moved to admin-only

### Fixed
- Server async IIFE Store close in catch paths
- JSON.stringify XSS in admin page
- Command injection: added -- separator in Bun.spawn

## [0.5.0] - 2026-03-19

### Added
- Bearer token authentication for serve mode
- SSRF prevention (private IP blocking, scheme validation)
- Path traversal protection (basename + resolve)
- File upload 50MB limit
- SQLite indexes (4 indexes for query performance)
- Bulk backlinks query (N+1 → single query)
- Korean slugify support (가-힣, ㄱ-ㅎ, ㅏ-ㅣ)
- Noto Sans KR web font loading
- Empty state design for index page

### Fixed
- Store close safety (try/finally in all CLI commands)
- Version mismatch (CLI 0.2.0 → 0.4.2)
- Global border-radius reset breaking KaTeX

### Removed
- Dead code: chunkSections, STRUCTURE_SYSTEM, unused Decompress import
