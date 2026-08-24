# GIF / Video Captions — kiwimu v1.1

데모 길이 30초. 자막은 한 컷에 한 줄, 화면 하단 (영상 1080p 기준 약 60px 위).
폰트: Inter Bold 28px, 외곽선 2px black, 그림자 X. 모바일 가독성 최우선.

## 한국어 자막 (국내 SNS용)

| 타임코드 | 자막 |
|---|---|
| 00:02 → 00:05 | 모르는 문장을 드래그하세요 |
| 00:06 → 00:08 | 그냥 물어보세요 |
| 00:09 → 00:14 | AI가 답을 써드립니다 |
| 00:15 → 00:17 | 한 번 클릭하면 |
| 00:18 → 00:22 | 정식 위키 페이지가 됩니다 |
| 00:23 → 00:27 | 위키가 자라납니다 |
| 00:28 → 00:30 | bunx @open330/kiwimu init --demo |

## English captions (HN / dev.to / global)

| Timecode | Caption |
|---|---|
| 00:02 → 00:05 | Highlight any text you don't get |
| 00:06 → 00:08 | Just ask |
| 00:09 → 00:14 | The AI writes the answer |
| 00:15 → 00:17 | One click — |
| 00:18 → 00:22 | and it becomes a real wiki page |
| 00:23 → 00:27 | Your wiki grows with you |
| 00:28 → 00:30 | bunx @open330/kiwimu init --demo |

## 자막 디자인 가이드

- **위치**: 하단 중앙, viewport 높이 기준 약 78%
- **배경**: 50% 검정 반투명 배경 박스 (자막마다 width fit-content)
- **폰트 색**: 흰색
- **포인트 자막** (00:18 → 00:22): 색을 var(--namu-green) #66bb6a로 강조. "정식 위키 페이지" / "real wiki page" 부분 굵게. 매직 모먼트 강화.
- **언어 별 GIF 분리**: 같은 영상 트랙 + 자막만 한/영 두 버전. 채널별로 분기 업로드.

## 데모 콘텐츠 (BST 페이지)

데모는 `이진탐색트리` 페이지에서 시작.
드래그 대상 후보 (가장 자연스러운 순):

1. **"회전(rotation) 연산을 통해"** ⭐ 1순위 — 명확한 명사구
2. "Red-Black 트리는 자동으로 균형을 유지하여" — 문장 단위, 더 풍부한 답변 유도
3. "편향 이진 트리" — 짧지만 의미 명확

질문 입력 (1순위):
- 한국어: "어떻게 균형을 유지하나요?"
- English: "How does it stay balanced?"

기대 답변 길이: 200~400자 (LLM 응답을 prompt에서 제한 가능하면 더 좋음)
