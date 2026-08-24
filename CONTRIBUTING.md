# Contributing to Kiwi Mu

Kiwi Mu에 기여해주셔서 감사합니다! 🥝

## 개발 환경 설정

### 필수 요구사항
- [Bun](https://bun.sh) >= 1.3.14

### 설치 및 실행

```bash
git clone https://github.com/Open330/kiwimu.git
cd kiwimu
bun install --frozen-lockfile

# 기본 검증
bun run check

# 데모 모드로 테스트
mkdir /tmp/test-wiki && cd /tmp/test-wiki
bun run /path/to/kiwimu/src/index.ts init --demo
```

## 기여 방법

### 버그 리포트
- GitHub Issues에 버그를 등록해주세요
- 재현 방법, 예상 동작, 실제 동작을 포함해주세요

### 기능 제안
- GitHub Issues에 Feature Request를 등록해주세요
- 어떤 문제를 해결하는지 설명해주세요

### Pull Request
1. Fork 후 feature branch를 생성하세요
2. 변경사항에 대한 테스트를 추가해주세요
3. `bun run check`로 단위 테스트와 TypeScript 검사를 통과시키세요
4. UI 변경이라면 `bunx playwright install chromium` 후 `bun run test:e2e`를 실행하세요
5. Redis coordinator 변경이라면 실제 Redis/Valkey를 실행하고 `KIWIMU_TEST_REDIS_URL=redis://127.0.0.1:6379 bun run test:redis`를 실행하세요
6. PR을 생성해주세요

## 프로젝트 구조

```
src/
├── index.ts           # CLI 진입점
├── server.ts          # 웹 서버 (Bun.serve)
├── services/
│   └── ingest.ts      # 문서 처리 서비스 레이어
├── config.ts          # 설정 관리
├── store.ts           # SQLite 데이터 레이어
├── llm-client.ts      # LLM 프로바이더 추상화
├── ingest/            # 문서 추출 모듈
├── pipeline/          # LLM 처리 파이프라인
├── build/             # 정적 사이트 생성
├── demo/              # 데모 모드 데이터
└── expand/            # 콘텐츠 확장
```

## 코드 스타일
- TypeScript strict mode
- `catch (e: unknown)` 사용 (not `any`)
- 테스트: `bun:test` 사용

## 라이선스
MIT — 기여하신 코드도 MIT 라이선스로 제공됩니다.
