# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.9.x   | ✅        |
| 0.8.x   | ⚠️ Best-effort |
| < 0.8   | ❌         |

## Reporting a Vulnerability

보안 취약점을 발견하셨다면 다음 방법으로 보고해주세요:

1. **GitHub Issues에 공개하지 마세요**
2. 이메일: jiunbae.623@gmail.com
3. 가능하면 PoC와 영향 범위를 포함해주세요

48시간 이내에 응답드리겠습니다.

## Security Features

kiwimu는 다음과 같은 보안 기능을 포함합니다:

- **Bearer Token 인증**: serve 모드에서 모든 관리 API에 UUID 토큰 인증
- **SSRF 방지**: 프라이빗 IP 차단, 리다이렉트 재검증
- **XSS 방지**: sanitize-html + Content-Security-Policy 헤더
- **Path Traversal 방지**: resolve + 접두사 검증
- **파일 업로드 제한**: 50MB
- **Rate Limiting**: /api/ask 분당 10회
- **SQL Injection 방지**: 모든 쿼리 파라미터화
- **UPSERT**: INSERT OR REPLACE 대신 ON CONFLICT 사용
- **ON DELETE CASCADE**: 전체 FK에 적용

## Known Limitations

- `serve` 모드의 인증은 단일 토큰 방식입니다 (세션 기반 아님)
- 정적 빌드에서는 보안 기능이 적용되지 않습니다
- CDN 리소스(KaTeX, D3)에 SRI 해시가 없습니다
