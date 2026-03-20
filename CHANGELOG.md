# Changelog

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
