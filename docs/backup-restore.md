# 백업·복원 운영 절차

Kiwi Mu의 기본 저장소는 SQLite WAL 모드입니다. 실행 중인 `kiwi.db` 파일 하나만 복사하면 WAL에 남아 있는 최근 commit을 잃을 수 있으므로, 이 절차는 서비스를 정지한 상태에서 수행합니다. 여러 호스트의 공유 SQLite 볼륨은 지원하지 않습니다.

## 백업 범위

다음 항목을 하나의 일관된 복구 단위로 보관합니다.

- `kiwi.toml`: 프로젝트와 LLM 설정
- `kiwi.db`, `kiwi.db-wal`, `kiwi.db-shm`: 콘텐츠와 학습 데이터
- `.kiwimu-runtime.db` 및 동반 `-wal`·`-shm`: 로컬 coordinator 상태(존재할 때)
- `.kiwi-token`: `KIWIMU_AUTH_TOKEN`을 쓰지 않을 때의 관리 토큰
- `uploads/`, `figures/`: 업로드 원본과 추출된 그림

`_site/`는 `kiwimu build`로 다시 만들 수 있으므로 필수 백업 대상이 아닙니다. 환경변수로 주입한 API key, 인증 토큰, Redis/Valkey 자격 증명은 별도 secret manager에서 백업해야 합니다.

## 오프라인 백업

1. 새 upload·add·build 요청 유입을 중단합니다.
2. `kiwimu serve` 또는 Compose 서비스를 정상 종료하고 프로세스가 완전히 끝났는지 확인합니다.
3. 프로젝트 디렉터리의 상위 경로에서 시간과 프로젝트 이름을 포함한 archive를 만듭니다. archive에는 위 백업 범위만 포함하고 권한을 `0600`으로 제한합니다.
4. 서비스가 정지된 동안 아래 무결성 검사를 수행합니다.

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database("kiwi.db", { readonly: true }); const rows = db.query("PRAGMA integrity_check").values(); db.close(); if (rows.length !== 1 || rows[0]?.[0] !== "ok") { console.error(rows); process.exit(1); } console.log("ok");'
```

5. 암호화된 백업 저장소로 archive를 옮기고, 원본과 별개의 임시 위치에서 복원 drill을 수행합니다. API key와 토큰이 들어갈 수 있으므로 평문 archive를 공개 object storage나 소스 저장소에 올리지 않습니다.

Compose named volume을 사용하는 경우에도 컨테이너가 정지된 뒤 volume 내용을 백업합니다. 실행 중인 컨테이너에서 `kiwi.db`만 `docker cp`하는 방식은 사용하지 않습니다.

## 복원

1. 대상 서비스가 정지되어 있고 대상 디렉터리가 비어 있는지 확인합니다. 기존 디렉터리에 덮어쓰지 말고, 기존 상태는 별도 이름으로 보존합니다.
2. archive를 새 디렉터리에 풀고 소유자를 서비스 계정으로 맞춥니다. `kiwi.toml`, DB, `.kiwi-token`은 서비스 계정만 읽고 쓸 수 있게 제한합니다.
3. 외부 coordinator를 사용했다면 `KIWIMU_COORDINATOR_URL`과 동일한 `KIWIMU_COORDINATOR_NAMESPACE`를 복원합니다. 콘텐츠 DB에 저장된 fencing epoch보다 오래된 coordinator snapshot을 임의로 재사용하지 않습니다. 서버 시작 시 coordinator를 안전하게 fast-forward할 수 없으면 시작이 실패해야 합니다.
4. 위 `PRAGMA integrity_check`를 다시 실행합니다.
5. `kiwimu status`, `kiwimu build`를 실행하고 `_site/index.html`이 생성되는지 확인합니다.
6. 서버를 로컬 인터페이스에서 먼저 시작해 `/health/ready`, 인증된 `/api/status`, 대표 문서·검색·그림을 확인한 다음 트래픽을 다시 엽니다.

## 정기 복구 drill

출시 전과 스키마 변경 전후에 최소 한 번 실제 archive로 새 디렉터리를 복원합니다. 다음 결과를 운영 기록에 남깁니다.

- 백업 시각, 앱 버전, DB 크기와 checksum
- 무결성 검사 결과
- 복원 소요 시간과 `build` 결과
- 대표 문서·검색·학습 이력·그림 확인 결과
- 외부 coordinator 사용 여부와 namespace

백업이 존재한다는 사실만으로 복구 가능성이 입증되지는 않습니다. 정기 drill이 실패하면 출시 차단 이슈로 취급합니다.
