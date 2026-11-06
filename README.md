# 우리말 바로쓰기 · 우리 반 순화어 사전

코드·학생 비밀번호·가입 화면 없이 학급을 선택해 참여하는 공동 사전입니다.

**표현 등록 → 원래 표현 상호 평가 → 순화어 제안·평가 → 교사 선택 → 최종 사전 편찬**

- 학생: 학교·학년·반을 선택하거나 새 학급을 만들고 바로 참여합니다. 익명 접속 정보는 같은 브라우저에서 유지됩니다.
- 원래 표현: 뜻과 순화가 필요한 이유를 등록하고, 다른 학생이 **순화 필요성**을 1~5점으로 평가합니다.
- 순화어: 원래 표현의 평가가 1개 이상 모이면 새 표현·뜻·이유·예문을 제안합니다. 다른 학생이 뜻의 전달력과 자연스러움을 1~5점으로 평가합니다.
- 최종 사전: **순화어 평균 4점 이상 + 1명 이상 평가 + 교사 선택**이 모두 필요합니다. 평점만으로 자동 편찬되지 않습니다. 이후 평점이 4점 미만이 되거나 교사가 선택을 취소하면 최종 사전에서 빠집니다.
- 자기 표현은 평가할 수 없습니다. 같은 학생이 다시 평가하면 기존 별점 한 개가 갱신됩니다. 원래 표현 하나당 자신의 순화어는 한 개를 제안할 수 있습니다.
- 교사·관리자 비밀번호: **`admin123`**. 데이터베이스에서 해시로 검증하며 인증은 8시간 유효합니다. 5회 실패하면 해당 접속은 15분 동안 다시 인증할 수 없습니다.
- 관리자만 학급을 삭제할 수 있습니다. 삭제하면 **DB의 학급 → 원래 표현 → 원본 별점 → 순화어 → 순화어 별점·편찬 선택까지** 외래 키 `ON DELETE CASCADE`로 함께 삭제됩니다. 다른 학급 자료는 유지됩니다.

## Supabase 연결 설정

현재 앱은 서울 리전의 무료 `korean-dictionary` 프로젝트에 연결되어 있으며, 사전 데이터베이스를 설치했습니다. 다른 프로젝트로 이전하거나 새 환경에 설치할 때는 다음 순서를 따릅니다.

1. Supabase에서 **Free 요금제** 프로젝트를 만들거나 기존 무료 프로젝트를 엽니다. 현재 프로젝트가 일시 중지되어 있다면 대시보드에서 복구합니다. 유료 플랜으로 업그레이드하지 않습니다.
2. 프로젝트의 **SQL Editor**에서 [`supabase/open-dictionary.sql`](supabase/open-dictionary.sql) **전체를 한 번 실행**합니다. 이 파일만으로 새 구조가 설치됩니다. 이전 수업 테이블은 삭제하지 않습니다. 이미 설치한 뒤 다시 실행해도 새 사전의 자료는 유지됩니다.
3. **Authentication → Sign In / Providers → Anonymous Sign-Ins**를 켭니다. 학생에게 로그인 입력을 받는 기능이 아니라 서버가 작성자·평가자를 구분하기 위한 익명 접속입니다.
4. 프로젝트의 **Connect / API 설정**에서 Project URL과 **publishable key**를 확인해 [`site/config.js`](site/config.js)에 넣습니다.

```js
window.APP_CONFIG = Object.freeze({
  supabaseUrl: 'https://프로젝트_ID.supabase.co',
  supabasePublishableKey: 'sb_publishable_...'
});
```

5. `site/config.js` 변경을 GitHub `main`에 commit/push합니다. **Actions → Deploy GitHub Pages**의 `test`와 `deploy`가 성공하면 연결 설정이 사이트에 반영됩니다.
6. 사이트에서 테스트 학급을 만들고 학생 두 브라우저로 등록·상호 평가·순화어 평가를 진행합니다. 교사·관리자로 `admin123`을 입력해 고평점 순화어를 편찬한 뒤, 테스트 학급 삭제까지 확인합니다.

브라우저에 공개되는 파일에는 publishable 키만 사용합니다. `service_role`, secret 키, DB 비밀번호는 넣지 않습니다. 브라우저 데이터 삭제나 시크릿 창·다른 기기는 다른 익명 참여자로 인식합니다.

## 무료 용량 보호

2026-11-06에 확인한 [Supabase Free 요금제](https://supabase.com/pricing)의 DB 한도는 500 MB, uncached egress는 5 GB, MAU는 50,000입니다. 이 앱은 텍스트 DB와 익명 인증만 사용하며 파일 저장소·Realtime·Edge Functions를 사용하지 않습니다.

- 앱의 **DB 저장 보호 한도는 450,000,000바이트(450 MB)**입니다. 모든 학급·표현·별점·순화어 INSERT/UPDATE 앞에서 서버가 `pg_database_size()`로 실제 프로젝트 DB 크기와 여유 공간을 확인합니다.
- 같은 트랜잭션 잠금으로 동시 쓰기를 직렬화합니다. 클라이언트 검사를 우회해도 테이블 트리거가 한도 도달 시 저장을 거절합니다. 일반 사용자는 테이블에 직접 쓰거나 제한 값을 변경할 권한이 없습니다.
- 한도에 도달하면 학생의 새 저장·평점 변경·교사 편찬을 막고 안내합니다. **기존 자료 조회와 관리자 로그인·학급 삭제는 가능**합니다.
- DB 전체 크기에는 이 앱 외의 테이블도 포함됩니다. 삭제한 행의 공간은 PostgreSQL이 재사용하므로, 삭제 직후 파일 크기가 줄어들지 않을 수 있습니다. 그런 경우 저장 차단이 유지될 수 있으며 관리자 유지보수가 필요합니다. [DB 크기 설명](https://supabase.com/docs/guides/platform/database-size)
- 이 장치는 **DB 저장 용량**을 보호합니다. 프로젝트 전체 트래픽·MAU를 청구 시스템과 동일하게 실시간 측정하는 장치는 아닙니다. 다른 무료 항목은 Supabase Free 요금제 자체 제한을 따릅니다. 앱은 업그레이드나 유료 초과 사용을 활성화하지 않습니다.
- 조회는 페이지 단위로 제한하며 주기적인 전체 목록 자동 조회를 하지 않습니다. Free 플랜을 유지하고 Supabase Usage에서 다른 항목도 확인하세요. [Egress 설명](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

## 구조와 권한

```text
class_dictionaries
└─ dictionary_words
   ├─ dictionary_word_ratings
   └─ dictionary_revisions (교사 선택 여부 포함)
      └─ dictionary_revision_ratings

dictionary_settings        # 비밀번호 해시, 저장 한도; 사용자 직접 접근 불가
dictionary_admin_sessions  # 인증 만료·실패 제한; 사용자 직접 접근 불가
```

앱은 제한된 `dictionary_*` RPC로만 DB를 사용합니다. 각 함수가 익명 인증, 작성자, 별점 범위, 단계 조건, 관리자 권한을 검사합니다. 테이블은 RLS를 활성화하고 `anon`·`authenticated`의 직접 읽기·변경 권한을 회수했습니다. 학급 목록만 로그인 세션 없이 조회할 수 있으며, 참여 시 익명 세션을 자동 발급합니다.

기존 `supabase/schema.sql`, `permissions-update.sql`, `lesson-flow-update.sql`은 이전 차시형 앱의 설치 자료로 보관합니다. **현재 버전은 `open-dictionary.sql`을 사용하세요.** 이전 버전의 수업 자료를 새 공개 학급 사전으로 자동 복사하지 않습니다.

## GitHub와 배포

- 저장소: https://github.com/fromjuly31/Korean
- 사이트: https://fromjuly31.github.io/Korean/
- 배포 대상: `site/`
- 학급 링크: `/#class=학급_UUID` (GitHub Pages에서는 `/Korean/#class=...`)
- [`pages.yml`](.github/workflows/pages.yml): `main` push → JavaScript 검사·DB 통합 테스트 → GitHub Pages 배포
- DB 설정이나 SQL 변경은 GitHub Pages 배포만으로 Supabase에 적용되지 않습니다.

## 로컬 검증

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

DB 테스트는 PGlite(PostgreSQL)에서 실제 SQL, 비밀번호 해시, 서버 권한, 용량 제한 트리거와 연쇄 삭제를 실행합니다. 브라우저 테스트는 학생 두 명과 관리자 한 명을 분리해 전체 편찬 흐름, 모바일, 저장 실패 재시도, 무료 용량 차단, 삭제를 확인합니다. 인증 세션 발급과 HTTP 전송만 테스트용으로 대체하며 **운영 Supabase 연결 성공을 뜻하지 않습니다.**

이미 설치된 Chromium은 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 환경 변수로 지정할 수 있습니다. `test-results/`에 검증 스크린샷을 저장합니다.

