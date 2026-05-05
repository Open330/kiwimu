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
- [ ] 팔로우업 블로그 글 배포: jiun.dev/posts/kiwimu-v1-1

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

## D+1 ~ D+5
- [ ] HN Show: "Show HN: kiwimu – Wikis grow, they aren't made"
- [ ] dev.to: 블로그 글 영문 번역 버전
- [ ] Reddit r/programming, r/selfhosted
- [ ] 댓글/멘션 모니터링 및 응답