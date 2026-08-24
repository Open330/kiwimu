# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.2.x   | ✅        |
| 1.1.x   | ⚠️ Best-effort |
| < 1.1   | ❌         |

## Reporting a Vulnerability

보안 취약점을 발견하셨다면 다음 방법으로 보고해주세요:

1. **GitHub Issues에 공개하지 마세요**
2. 이메일: jiunbae.623@gmail.com
3. 가능하면 PoC와 영향 범위를 포함해주세요

48시간 이내에 응답드리겠습니다.

## Security Features

kiwimu는 다음과 같은 보안 기능을 포함합니다:

- **관리 토큰 인증**: serve 모드에서 `HttpOnly` same-origin 쿠키 또는 Bearer 토큰 사용
- **SSRF 방지**: 프라이빗 IP 차단, 리다이렉트 재검증
- **XSS 방지**: sanitize-html, 정적 CSP meta, serve 모드 CSP header, self-hosted runtime asset
- **경로 경계**: 정적 파일의 정규화 경로와 실제 경로를 모두 site root 안으로 제한
- **파일 업로드 제한**: 크기 제한과 body 수신 admission 적용
- **Rate Limiting**: 동적 질의 API에 project-wide 제한 적용
- **SQL Injection 방지**: 모든 쿼리 파라미터화
- **콘텐츠 fencing**: lease epoch를 콘텐츠 DB transaction 안에서 검증해 stale writer의 이후 commit 차단

## Privacy / Telemetry

kiwimu는 텔레메트리나 사용량 분석을 수집하지 않으며, kiwimu가 운영하는 서버로 어떤 데이터도 전송하지 않습니다. 외부 통신은 (1) 사용자가 설정한 LLM/임베딩 프로바이더, (2) 사용자가 추가한 URL 소스, (3) 사용자가 실행한 배포 대상(GitHub Pages/Vercel)에 한합니다. 문서·위키·학습 이력·사용량 로그는 모두 로컬 SQLite에 저장됩니다(`usage`·`activity` 기록은 로컬 전용).

## Known Limitations

- `serve` 모드의 인증은 단일 토큰 방식입니다 (세션 기반 아님)
- 정적 배포에도 CSP와 self-hosted asset 경계는 적용되지만, 서버 인증·rate limit·동적 API 보호는 제공되지 않습니다
- 여러 호스트가 같은 SQLite 프로젝트를 active-active로 읽고 쓰는 배포는 지원하지 않습니다
- 기본 Docker image에서 선택적인 PDF 그림 추출 도구의 제공 여부는 해당 release image 문서를 확인해야 합니다
