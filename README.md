# 우리말 리디자인 프로젝트

GitHub Pages에서 실행되는 고등학교 국어 수업용 참여형 웹앱입니다. 학생은 클래스 코드로 익명 입장하고, 교사는 수업용 비밀번호 하나로 교사 공간에 들어갑니다. 생각 나누기 → 발견 → 진단 → 설계 → 검증의 데이터가 자동으로 이어집니다.

## Supabase 준비

1. Supabase에서 새 프로젝트를 만듭니다.
2. 새 프로젝트라면 **SQL Editor**에서 [`supabase/schema.sql`](supabase/schema.sql) 전체를 실행합니다. 이미 스키마를 설치한 현재 프로젝트라면 [`supabase/permissions-update.sql`](supabase/permissions-update.sql) 전체를 실행해 최신 기능과 권한만 반영합니다.
3. 이어서 **SQL Editor**에서 [`supabase/lesson-flow-update.sql`](supabase/lesson-flow-update.sql) 전체를 실행합니다. 이 파일은 기존 수집 자료를 지우지 않고 1차시 생각 나누기와 2~4차시 학생 주도 흐름을 추가하며, 기존 설치본에 빠진 대시보드 테이블과 수업 결과 초기화 함수도 복구합니다.
4. **Authentication > Providers > Anonymous Sign-Ins**를 활성화합니다.
5. [`site/config.js`](site/config.js)에 Project URL과 publishable 키를 입력합니다.

```js
window.APP_CONFIG = Object.freeze({
  supabaseUrl: 'https://프로젝트_ID.supabase.co',
  supabasePublishableKey: 'sb_publishable_...'
});
```

초기 교사 비밀번호는 `school`입니다. 실제 운영 전에는 SQL Editor에서 아래처럼 변경합니다.

```sql
update public.teacher_access_codes
set code_hash = extensions.crypt(lower('새 교사 비밀번호'), extensions.gen_salt('bf'))
where label = '기본 교사 코드';
```

`publishable` 키는 브라우저 앱용 공개 키입니다. `service_role` 또는 Supabase secret 키는 `site/`에 넣지 않습니다.

## 수업 운영 흐름

1. 교사는 첫 화면에서 수업용 교사 비밀번호만 입력합니다.
2. **새 클래스 개설**에서 지역, 학교, 학년, 반, 사용할 클래스 코드와 코드 찾기 힌트를 입력하거나 **기존 클래스 입장**에서 기존 클래스 코드를 입력합니다.
3. 클래스 코드는 교사가 영문·숫자 4~12자리로 정합니다. 이미 사용 중인 코드는 중복 안내가 표시됩니다.
4. 학생은 첫 화면에서 클래스 코드를 입력해 익명으로 참여합니다.
5. 학생은 대기 화면에 머물며, 교사가 시작한 현재 차시만 볼 수 있습니다.
6. 교사가 차시를 바꾸면 학생 화면이 약 5초 안에 자동 전환됩니다.

교사 화면에서 차시 탭을 선택하고 **차시 시작**을 누르면 해당 차시가 시작되면서 클래스 코드와 STEP 번호가 포함된 전용 QR이 자동으로 열립니다. QR을 접은 뒤에는 차시 제어 영역의 **참여 QR 다시 띄우기**로 다시 열 수 있습니다. 학생은 코드를 따로 입력하지 않고 바로 입장합니다. 참여 중 다른 차시 탭이나 메인 화면으로 이동하면 확인창을 거쳐 QR과 학생 참여가 종료되며, 교사 화면을 새로고침하거나 닫을 때도 자동 종료됩니다. 수업이 다른 차시로 바뀐 뒤 예전 QR을 스캔하면 다른 활동을 열지 않고 해당 차시의 재시작을 기다립니다.

클래스 코드를 잊으면 로그인한 교사 화면의 **클래스 코드 찾기**에서 지역, 학교명, 학년, 반, 개설할 때 정한 힌트를 입력합니다. 힌트 원문은 저장하지 않고 단방향 해시로 보관합니다.

수업은 네 차시로 운영합니다.

1. **1차시 발견 · 언어 데이터 수집**: 교사가 주제를 입력하고 생각 나누기를 시작하면 학생이 같은 1차시 QR에서 찬성·반대와 짧은 이유를 제출합니다. 이어지는 수집 단계에서는 `유행어·신조어` 중 하나를 고르고 그 표현을 접한 출처를 함께 입력합니다. 같은 표현은 한 항목으로 합치되 제출별 출처는 모두 보존합니다.
2. **진단 · 맥락과 적절성**: 학생이 1차시 표현 하나를 선택합니다. 교사가 정한 표현별 최대 인원에 도달하면 해당 표현은 `마감` 처리됩니다. 학생은 대화 상대·장소·상황 중 두 가지 이상을 골라 적절한 경우와 그렇지 않은 경우의 맥락·예문·별점·평가 이유를 완성합니다.
3. **설계 · 진단에서 새 표현으로**: 학생이 2차시 진단 카드 하나를 선택하고 내용을 확인한 뒤 새 표현·뜻·이유·예문을 작성합니다. 등록된 설계안은 4차시 1:1 비교 항목으로 자동 연결됩니다.
4. **검증 · 기존 표현과 새 표현 1:1 비교**: 학생이 두 표현 중 맥락에 더 적합한 표현을 고르면 현재 학급 선택 결과가 사전에 즉시 반영됩니다. 교사 화면의 **우리 반 우리말 사전** 탭에서 표제어 형식으로 확인합니다.

## 권한 구조

- 학생: 가입 없이 클래스 입장, 현재 단계의 제출·평가만 가능
- 교사: 수업용 비밀번호로 입장, 클래스 개설·입장, 자기 클래스 자료 관리와 수업 단계 운영
- 시스템 관리자: 별도 Supabase 이메일 계정으로 모든 클래스와 다른 클래스의 자료 관리·삭제
- RLS 정책이 클래스 소속과 현재 수업 단계를 데이터베이스에서 다시 검사합니다.

## 데이터베이스 구조

모든 수업 자료는 `classes`를 기준으로 연결합니다. 지역·학교·학년·반·클래스 코드는 한 클래스에 한 번만 저장하고, 하위 자료에서는 외래키를 사용해 중복을 피합니다.

```text
classes (지역 → 학교 → 학년 → 반 → 클래스 코드)
├─ class_members / class_teachers
├─ opinion_responses (1차시 생각 나누기 찬반·이유)
├─ words (학생 언어 자료와 submit_count)
│  ├─ word_sources (제출별 수집 출처)
│  ├─ word_suggestions (리디자인 제안)
│  │  └─ ab_tests / ab_responses (기존·새 표현 1:1 검증)
│  └─ dictionary (우리말 사전 결과)
│     └─ dictionary_usage_logs (선택형 주간 실제 사용 기록)
├─ diagnostic_cards (학생이 만든 맥락·예문·별점 진단 카드)
└─ class_recovery (코드 찾기 힌트 해시, 직접 조회 불가)
```

클래스를 시스템 관리자가 삭제하면 외래키의 `on delete cascade`에 따라 해당 클래스의 하위 자료만 함께 삭제됩니다. 다른 클래스 자료에는 영향을 주지 않습니다.

시스템 관리자가 필요하면 **Authentication > Users**에서 계정을 만든 뒤 아래 쿼리로 권한을 등록합니다.

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'admin@example.com'
on conflict (user_id) do nothing;
```

## GitHub Pages 배포

저장소의 **Settings > Pages > Build and deployment > Source**를 **GitHub Actions**로 설정하고, Pages 워크플로의 `actions/upload-pages-artifact` 단계에서 배포 경로를 `site/`로 지정합니다. 이후 `main` 브랜치에 push하면 별도 빌드 없이 정적 파일이 배포됩니다.

```text
https://fromjuly31.github.io/Korean/
```

- 기본 화면: `/`
- 학생 입장: `?view=student&code=클래스코드`
- 교사 화면: `?view=teacher`
- 시스템 관리자: `?view=admin`

## 보안 메모

- 학생 식별값은 `localStorage.student_uuid`에 저장하며 Supabase 익명 인증 UUID와 동기화합니다. 이름·학번·이메일은 받지 않습니다.
- 교사 비밀번호는 `teacher_access_codes`에 단방향 해시로 저장하고, 관리자 비밀번호는 Supabase Auth가 관리합니다.
- 공용 기기에서는 교사 또는 관리자 권한으로 접속하지 않는 것을 권장합니다.
