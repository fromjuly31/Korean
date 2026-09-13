-- 우리 반 우리말 사전: Supabase 초기 스키마
-- 새 Supabase 프로젝트의 SQL Editor에서 전체를 한 번 실행하세요.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.teachers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.teacher_access_codes (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  code_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.teacher_access_codes (label, code_hash)
values ('기본 교사 코드', extensions.crypt('school', extensions.gen_salt('bf')))
on conflict (label) do nothing;

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users(id) on delete cascade,
  region text not null check (char_length(region) between 1 and 80),
  school text not null check (char_length(school) between 1 and 160),
  grade text not null check (char_length(grade) between 1 and 20),
  class_name text not null check (char_length(class_name) between 1 and 40),
  class_code text not null unique check (class_code ~ '^[A-Z0-9]{4,12}$'),
  current_stage text not null default 'waiting'
    check (current_stage in ('waiting', 'opinion', 'submit', 'rate', 'context', 'wordmaking', 'dictionary')),
  current_task_id uuid,
  discussion_topic text not null default '' check (char_length(discussion_topic) <= 300),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.class_members (
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, user_id)
);

create table if not exists public.class_teachers (
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (class_id, user_id)
);

-- 찾기 힌트는 클래스 목록과 분리하고, 원문 대신 단방향 해시만 저장합니다.
create table if not exists public.class_recovery (
  class_id uuid primary key references public.classes(id) on delete cascade,
  hint_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.words (
  id uuid primary key default gen_random_uuid(),
  class_id uuid references public.classes(id) on delete cascade,
  owner_id uuid not null,
  word text not null check (char_length(word) between 1 and 80),
  normalized_word text not null check (char_length(normalized_word) between 1 and 80),
  category text not null check (category in ('비속어', '유행어', '외래어')),
  submit_count integer not null default 1 check (submit_count > 0),
  created_at timestamptz not null default now(),
  approved boolean not null default false
);

create table if not exists public.word_ratings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  word_id uuid not null references public.words(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (owner_id, word_id)
);

create table if not exists public.context_tasks (
  id uuid primary key default gen_random_uuid(),
  class_id uuid references public.classes(id) on delete cascade,
  context_group_id uuid not null default gen_random_uuid(),
  context_title text not null default '공통 맥락' check (char_length(context_title) between 1 and 120),
  word_id uuid not null references public.words(id) on delete cascade,
  word text not null check (char_length(word) between 1 and 80),
  category text not null check (category in ('비속어', '유행어', '외래어')),
  situation text not null check (char_length(situation) between 1 and 500),
  target text not null check (char_length(target) between 1 and 200),
  context text not null check (char_length(context) between 1 and 500),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2차시: 한 학생은 같은 사용성 테스트에 한 번만 응답합니다.
create table if not exists public.usability_responses (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.context_tasks(id) on delete cascade,
  owner_id uuid not null,
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (test_id, owner_id)
);

create table if not exists public.context_examples (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.context_tasks(id) on delete cascade,
  owner_id uuid not null,
  sentence text not null check (char_length(sentence) between 1 and 800),
  intent text not null check (char_length(intent) between 1 and 600),
  created_at timestamptz not null default now(),
  unique (owner_id, task_id)
);

create table if not exists public.example_ratings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  example_id uuid not null references public.context_examples(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (owner_id, example_id)
);

create table if not exists public.word_suggestions (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.words(id) on delete cascade,
  owner_id uuid not null,
  original_word text not null check (char_length(original_word) between 1 and 120),
  category text not null check (category in ('비속어', '유행어', '외래어')),
  suggestion_type text not null check (suggestion_type in ('기존 표현으로 바꾸기', '새로운 말 만들기')),
  meaning text not null default '의미 미입력' check (char_length(meaning) between 1 and 600),
  suggested_word text not null check (char_length(suggested_word) between 1 and 120),
  reason text not null check (char_length(reason) between 1 and 600),
  example_sentence text not null check (char_length(example_sentence) between 1 and 800),
  created_at timestamptz not null default now(),
  unique (owner_id, word_id)
);

create table if not exists public.suggestion_ratings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  suggestion_id uuid not null references public.word_suggestions(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  meaning_score smallint not null default 3 check (meaning_score between 1 and 5),
  natural_score smallint not null default 3 check (natural_score between 1 and 5),
  universal_score smallint not null default 3 check (universal_score between 1 and 5),
  memorable_score smallint not null default 3 check (memorable_score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (owner_id, suggestion_id)
);

-- 4차시: 같은 원래 표현에서는 후보 하나에만 출시 추천을 할 수 있습니다.
create table if not exists public.launch_votes (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.words(id) on delete cascade,
  suggestion_id uuid not null references public.word_suggestions(id) on delete cascade,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  unique (word_id, owner_id)
);

create table if not exists public.dictionary (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null unique references public.words(id) on delete cascade,
  suggestion_id uuid references public.word_suggestions(id) on delete set null,
  original_word text not null check (char_length(original_word) between 1 and 120),
  category text not null check (category in ('비속어', '유행어', '외래어')),
  final_word text not null default '' check (char_length(final_word) <= 160),
  meaning text not null default '' check (char_length(meaning) <= 1200),
  caution text not null default '' check (char_length(caution) <= 1200),
  example_sentence text not null default '' check (char_length(example_sentence) <= 1200),
  approved boolean not null default false,
  updated_at timestamptz not null default now(),
  check (not approved or (char_length(final_word) > 0 and char_length(meaning) > 0))
);

create table if not exists public.class_pledges (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  owner_id uuid not null,
  pledge text not null check (char_length(pledge) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (class_id, owner_id)
);

-- 기존 설치본을 클래스형 구조로 안전하게 확장합니다.
alter table public.words
  add column if not exists class_id uuid references public.classes(id) on delete cascade;
alter table public.words
  add column if not exists submit_count integer not null default 1 check (submit_count > 0);
alter table public.context_tasks
  add column if not exists class_id uuid references public.classes(id) on delete cascade;
alter table public.context_tasks
  add column if not exists context_group_id uuid not null default gen_random_uuid();
alter table public.context_tasks
  add column if not exists context_title text not null default '공통 맥락'
  check (char_length(context_title) between 1 and 120);
alter table public.context_examples
  add column if not exists intent text not null default '작성 의도 미입력'
  check (char_length(intent) between 1 and 600);
alter table public.word_suggestions
  add column if not exists meaning text not null default '의미 미입력'
  check (char_length(meaning) between 1 and 600);
alter table public.suggestion_ratings
  add column if not exists meaning_score smallint not null default 3 check (meaning_score between 1 and 5);
alter table public.suggestion_ratings
  add column if not exists natural_score smallint not null default 3 check (natural_score between 1 and 5);
alter table public.suggestion_ratings
  add column if not exists universal_score smallint not null default 3 check (universal_score between 1 and 5);
alter table public.suggestion_ratings
  add column if not exists memorable_score smallint not null default 3 check (memorable_score between 1 and 5);
alter table public.dictionary
  add column if not exists suggestion_id uuid references public.word_suggestions(id) on delete set null;

alter table public.classes drop constraint if exists classes_class_code_check;
alter table public.classes
  add constraint classes_class_code_check check (class_code ~ '^[A-Z0-9]{4,12}$');

create index if not exists words_normalized_word_idx on public.words(normalized_word);
create index if not exists words_class_id_idx on public.words(class_id);
create index if not exists words_approved_idx on public.words(approved);
create index if not exists word_ratings_word_id_idx on public.word_ratings(word_id);
create index if not exists context_tasks_active_idx on public.context_tasks(active);
create index if not exists context_tasks_class_id_idx on public.context_tasks(class_id);
create index if not exists context_tasks_context_group_id_idx on public.context_tasks(context_group_id);
create index if not exists usability_responses_test_id_idx on public.usability_responses(test_id);
create unique index if not exists context_tasks_group_word_uidx on public.context_tasks(context_group_id, word_id);
create index if not exists context_examples_task_id_idx on public.context_examples(task_id);
create index if not exists example_ratings_example_id_idx on public.example_ratings(example_id);
create index if not exists word_suggestions_word_id_idx on public.word_suggestions(word_id);
create index if not exists suggestion_ratings_suggestion_id_idx on public.suggestion_ratings(suggestion_id);
create index if not exists launch_votes_suggestion_id_idx on public.launch_votes(suggestion_id);
create index if not exists dictionary_approved_idx on public.dictionary(approved);
create index if not exists class_pledges_class_id_idx on public.class_pledges(class_id);
create index if not exists classes_teacher_id_idx on public.classes(teacher_id);
create index if not exists class_members_user_id_idx on public.class_members(user_id);
create index if not exists class_teachers_user_id_idx on public.class_teachers(user_id);

create or replace function public.normalize_korean_class_word(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(trim(coalesce(value, '')));
$$;

create or replace function public.set_normalized_word()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.word := trim(new.word);
  new.normalized_word := public.normalize_korean_class_word(new.word);
  if new.normalized_word = '' then
    raise exception '문자나 숫자가 포함된 표현을 입력해 주세요.';
  end if;
  return new;
end;
$$;

drop trigger if exists words_set_normalized_word on public.words;
create trigger words_set_normalized_word
before insert or update of word, normalized_word on public.words
for each row execute function public.set_normalized_word();

-- 이전 정규화 규칙으로 저장된 값도 공백·영문 대소문자를 통일합니다.
update public.words
set normalized_word = lower(trim(word))
where normalized_word is distinct from lower(trim(word));

-- 이전의 별점 전용 단계를 새 1차시 수집 단계로 합칩니다.
update public.classes
set current_stage = 'submit', current_task_id = null
where current_stage = 'rate';

create or replace function public.touch_rating_time()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists classes_touch_time on public.classes;
create trigger classes_touch_time
before update on public.classes
for each row execute function public.touch_updated_at();

drop trigger if exists word_ratings_touch_time on public.word_ratings;
create trigger word_ratings_touch_time
before update on public.word_ratings
for each row execute function public.touch_rating_time();

drop trigger if exists example_ratings_touch_time on public.example_ratings;
create trigger example_ratings_touch_time
before update on public.example_ratings
for each row execute function public.touch_rating_time();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.admins where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin() or exists (
    select 1 from public.teachers where user_id = (select auth.uid())
  );
$$;

create or replace function public.can_manage_class(target_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin() or exists (
    select 1
    from public.classes
    where id = target_class_id and teacher_id = (select auth.uid())
  ) or exists (
    select 1
    from public.class_teachers
    where class_id = target_class_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_class_member(target_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.class_members
    where class_id = target_class_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.join_class(p_code text)
returns table (
  id uuid,
  region text,
  school text,
  grade text,
  class_name text,
  class_code text,
  current_stage text,
  current_task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.classes%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception '로그인 세션을 확인할 수 없습니다.';
  end if;

  select * into target
  from public.classes c
  where c.class_code = upper(trim(p_code)) and c.is_active
  limit 1;

  if target.id is null then
    raise exception '클래스 코드를 확인해 주세요.';
  end if;

  insert into public.class_members (class_id, user_id)
  values (target.id, (select auth.uid()))
  on conflict (class_id, user_id) do nothing;

  return query
  select target.id, target.region, target.school, target.grade, target.class_name,
    target.class_code, target.current_stage, target.current_task_id;
end;
$$;

-- 학생은 words 행을 직접 수정하지 않고 이 함수로만 표현을 등록합니다.
-- 같은 반의 완전히 동일한 정규화 표현은 한 행의 submit_count로 합칩니다.
create or replace function public.submit_word(
  p_class_id uuid,
  p_word text,
  p_category text
)
returns table (id uuid, submit_count integer, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_word text := trim(coalesce(p_word, ''));
  normalized text := public.normalize_korean_class_word(p_word);
  found_id uuid;
  next_count integer;
begin
  if (select auth.uid()) is null or not public.is_class_member(p_class_id) then
    raise exception '이 클래스에 참여한 학생만 표현을 등록할 수 있습니다.';
  end if;
  if not exists (
    select 1 from public.classes
    where classes.id = p_class_id and classes.is_active and classes.current_stage = 'submit'
  ) then
    raise exception '지금은 언어 수집 시간이 아닙니다.';
  end if;
  if p_category not in ('비속어', '유행어', '외래어') then
    raise exception '유형을 올바르게 선택해 주세요.';
  end if;
  if char_length(clean_word) not between 1 and 80 or normalized = '' then
    raise exception '표현을 입력해 주세요.';
  end if;

  -- 같은 클래스·표현끼리 직렬화하여 동시에 눌러도 중복 행이 생기지 않게 합니다.
  perform pg_advisory_xact_lock(hashtextextended(p_class_id::text || ':' || normalized, 0));
  select words.id, words.submit_count into found_id, next_count
  from public.words
  where words.class_id = p_class_id and words.normalized_word = normalized
  order by words.created_at
  limit 1
  for update;

  if found_id is not null then
    update public.words
    set submit_count = words.submit_count + 1
    where words.id = found_id
    returning words.submit_count into next_count;
    return query select found_id, next_count, true;
    return;
  end if;

  insert into public.words (class_id, owner_id, word, normalized_word, category, submit_count, approved)
  values (p_class_id, (select auth.uid()), clean_word, normalized, p_category, 1, false)
  returning words.id, words.submit_count into found_id, next_count;
  return query select found_id, next_count, false;
end;
$$;

create or replace function public.claim_teacher_access(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception '로그인 세션을 확인할 수 없습니다.';
  end if;

  if not exists (
    select 1
    from public.teacher_access_codes
    where active and code_hash = extensions.crypt(lower(trim(p_code)), code_hash)
  ) then
    return false;
  end if;

  insert into public.teachers (user_id)
  values ((select auth.uid()))
  on conflict (user_id) do nothing;
  return true;
end;
$$;

create or replace function public.create_class(
  p_region text,
  p_school text,
  p_grade text,
  p_class_name text,
  p_class_code text,
  p_recovery_hint text
)
returns table (
  id uuid,
  region text,
  school text,
  grade text,
  class_name text,
  class_code text,
  current_stage text,
  current_task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.classes%rowtype;
  clean_region text := trim(coalesce(p_region, ''));
  clean_school text := trim(coalesce(p_school, ''));
  clean_grade text := trim(coalesce(p_grade, ''));
  clean_class_name text := trim(coalesce(p_class_name, ''));
  clean_class_code text := upper(regexp_replace(coalesce(p_class_code, ''), '\s+', '', 'g'));
  clean_hint text := lower(trim(coalesce(p_recovery_hint, '')));
begin
  if not public.is_teacher() then
    raise exception '교사 권한이 필요합니다.';
  end if;
  if char_length(clean_region) not between 1 and 80
    or char_length(clean_school) not between 1 and 160
    or char_length(clean_grade) not between 1 and 20
    or char_length(clean_class_name) not between 1 and 40 then
    raise exception '지역, 학교명, 학년, 반을 모두 올바르게 입력해 주세요.';
  end if;
  if clean_class_code !~ '^[A-Z0-9]{4,12}$' then
    raise exception '클래스 코드는 영문·숫자 4~12자리로 입력해 주세요.';
  end if;
  if char_length(clean_hint) not between 1 and 120 then
    raise exception '클래스 코드 찾기 힌트를 입력해 주세요.';
  end if;

  begin
    insert into public.classes (
      teacher_id, region, school, grade, class_name, class_code, current_stage
    ) values (
      (select auth.uid()), clean_region, clean_school, clean_grade,
      clean_class_name, clean_class_code, 'waiting'
    ) returning * into target;
  exception when unique_violation then
    raise exception using errcode = '23505', message = '이미 사용 중인 클래스 코드입니다.';
  end;

  insert into public.class_recovery (class_id, hint_hash)
  values (target.id, extensions.crypt(clean_hint, extensions.gen_salt('bf')));

  return query
  select target.id, target.region, target.school, target.grade, target.class_name,
    target.class_code, target.current_stage, target.current_task_id;
end;
$$;

create or replace function public.recover_class_code(
  p_region text,
  p_school text,
  p_grade text,
  p_class_name text,
  p_recovery_hint text
)
returns table (
  class_code text,
  region text,
  school text,
  grade text,
  class_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_teacher() then
    raise exception '교사 권한이 필요합니다.';
  end if;
  if trim(coalesce(p_region, '')) = ''
    or trim(coalesce(p_school, '')) = ''
    or trim(coalesce(p_grade, '')) = ''
    or trim(coalesce(p_class_name, '')) = ''
    or trim(coalesce(p_recovery_hint, '')) = '' then
    raise exception '학급 정보와 클래스 코드 찾기 힌트를 모두 입력해 주세요.';
  end if;

  return query
  select c.class_code, c.region, c.school, c.grade, c.class_name
  from public.classes c
  join public.class_recovery r on r.class_id = c.id
  where c.is_active
    and lower(trim(c.region)) = lower(trim(p_region))
    and lower(trim(c.school)) = lower(trim(p_school))
    and lower(trim(c.grade)) = lower(trim(p_grade))
    and lower(trim(c.class_name)) = lower(trim(p_class_name))
    and r.hint_hash = extensions.crypt(lower(trim(p_recovery_hint)), r.hint_hash)
  order by c.created_at desc
  limit 10;
end;
$$;

create or replace function public.enter_teacher_class(p_code text)
returns table (
  id uuid,
  region text,
  school text,
  grade text,
  class_name text,
  class_code text,
  current_stage text,
  current_task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.classes%rowtype;
begin
  if not public.is_teacher() then
    raise exception '교사 권한이 필요합니다.';
  end if;

  select * into target
  from public.classes c
  where c.class_code = upper(trim(p_code)) and c.is_active
  limit 1;

  if target.id is null then
    raise exception '클래스 코드를 확인해 주세요.';
  end if;

  insert into public.class_teachers (class_id, user_id)
  values (target.id, (select auth.uid()))
  on conflict (class_id, user_id) do nothing;

  return query
  select target.id, target.region, target.school, target.grade, target.class_name,
    target.class_code, target.current_stage, target.current_task_id;
end;
$$;

create or replace function public.reset_class_results(p_class_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_class(p_class_id) then
    raise exception '이 클래스의 결과를 초기화할 권한이 없습니다.';
  end if;
  update public.classes
  set current_stage = 'waiting', current_task_id = null
  where id = p_class_id;
  delete from public.class_pledges where class_id = p_class_id;
  delete from public.context_tasks where class_id = p_class_id;
  delete from public.words where class_id = p_class_id;
  return true;
end;
$$;

revoke all on function public.is_teacher() from public;
revoke all on function public.can_manage_class(uuid) from public;
revoke all on function public.is_class_member(uuid) from public;
revoke all on function public.join_class(text) from public;
revoke all on function public.submit_word(uuid, text, text) from public;
revoke all on function public.claim_teacher_access(text) from public;
revoke all on function public.create_class(text, text, text, text, text, text) from public;
revoke all on function public.recover_class_code(text, text, text, text, text) from public;
revoke all on function public.enter_teacher_class(text) from public;
revoke all on function public.reset_class_results(uuid) from public;
grant execute on function public.is_teacher() to authenticated;
grant execute on function public.can_manage_class(uuid) to authenticated;
grant execute on function public.is_class_member(uuid) to authenticated;
grant execute on function public.join_class(text) to authenticated;
grant execute on function public.submit_word(uuid, text, text) to authenticated;
grant execute on function public.claim_teacher_access(text) to authenticated;
grant execute on function public.create_class(text, text, text, text, text, text) to authenticated;
grant execute on function public.recover_class_code(text, text, text, text, text) to authenticated;
grant execute on function public.enter_teacher_class(text) to authenticated;
grant execute on function public.reset_class_results(uuid) to authenticated;

alter table public.admins enable row level security;
alter table public.teachers enable row level security;
alter table public.teacher_access_codes enable row level security;
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.class_teachers enable row level security;
alter table public.class_recovery enable row level security;
alter table public.words enable row level security;
alter table public.word_ratings enable row level security;
alter table public.context_tasks enable row level security;
alter table public.usability_responses enable row level security;
alter table public.context_examples enable row level security;
alter table public.example_ratings enable row level security;
alter table public.word_suggestions enable row level security;
alter table public.suggestion_ratings enable row level security;
alter table public.launch_votes enable row level security;
alter table public.dictionary enable row level security;
alter table public.class_pledges enable row level security;

drop policy if exists admins_read_self on public.admins;
create policy admins_read_self on public.admins
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists teachers_read_self on public.teachers;
create policy teachers_read_self on public.teachers
for select to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists classes_read on public.classes;
create policy classes_read on public.classes
for select to authenticated
using (
  teacher_id = (select auth.uid())
  or public.can_manage_class(id)
  or public.is_class_member(id)
);

drop policy if exists classes_teacher_insert on public.classes;
create policy classes_teacher_insert on public.classes
for insert to authenticated
with check (teacher_id = (select auth.uid()) and public.is_teacher());

drop policy if exists classes_manager_update on public.classes;
create policy classes_manager_update on public.classes
for update to authenticated
using (public.can_manage_class(id))
with check (public.can_manage_class(id));

drop policy if exists classes_admin_delete on public.classes;
create policy classes_admin_delete on public.classes
for delete to authenticated
using (public.is_admin());

drop policy if exists class_members_read on public.class_members;
create policy class_members_read on public.class_members
for select to authenticated
using (user_id = (select auth.uid()) or public.can_manage_class(class_id));

drop policy if exists class_teachers_read on public.class_teachers;
create policy class_teachers_read on public.class_teachers
for select to authenticated
using (user_id = (select auth.uid()) or public.can_manage_class(class_id));

drop policy if exists words_read on public.words;
create policy words_read on public.words
for select to authenticated
using (
  public.can_manage_class(class_id)
  or public.is_class_member(class_id)
);

drop policy if exists words_submit on public.words;
create policy words_submit on public.words
for insert to authenticated
with check (public.can_manage_class(class_id));

drop policy if exists words_admin_update on public.words;
create policy words_admin_update on public.words
for update to authenticated
using (public.can_manage_class(class_id))
with check (public.can_manage_class(class_id));

drop policy if exists words_admin_delete on public.words;
drop policy if exists words_manager_delete on public.words;
create policy words_manager_delete on public.words
for delete to authenticated
using (public.can_manage_class(class_id));

drop policy if exists word_ratings_read on public.word_ratings;
create policy word_ratings_read on public.word_ratings
for select to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = word_ratings.word_id
      and (public.can_manage_class(words.class_id)
        or public.is_class_member(words.class_id))
  )
);

drop policy if exists word_ratings_submit on public.word_ratings;
create policy word_ratings_submit on public.word_ratings
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.words
    join public.classes on classes.id = words.class_id
    where words.id = word_ratings.word_id
      and public.is_class_member(words.class_id)
      and classes.current_stage in ('submit', 'rate')
  )
);

drop policy if exists word_ratings_update_own on public.word_ratings;
create policy word_ratings_update_own on public.word_ratings
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.words
    join public.classes on classes.id = words.class_id
    where words.id = word_ratings.word_id
      and public.is_class_member(words.class_id)
      and classes.current_stage in ('submit', 'rate')
  )
);

drop policy if exists word_ratings_manager_delete on public.word_ratings;
create policy word_ratings_manager_delete on public.word_ratings
for delete to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = word_ratings.word_id
      and public.can_manage_class(words.class_id)
  )
);

drop policy if exists context_tasks_read on public.context_tasks;
create policy context_tasks_read on public.context_tasks
for select to authenticated
using (
  public.can_manage_class(class_id)
  or (
    active
    and public.is_class_member(class_id)
    and exists (
      select 1 from public.classes
      where classes.id = context_tasks.class_id
        and classes.current_stage = 'context'
    )
  )
);

drop policy if exists context_tasks_admin_insert on public.context_tasks;
create policy context_tasks_admin_insert on public.context_tasks
for insert to authenticated
with check (public.can_manage_class(class_id));

drop policy if exists context_tasks_admin_update on public.context_tasks;
create policy context_tasks_admin_update on public.context_tasks
for update to authenticated
using (public.can_manage_class(class_id))
with check (public.can_manage_class(class_id));

drop policy if exists context_tasks_admin_delete on public.context_tasks;
drop policy if exists context_tasks_manager_delete on public.context_tasks;
create policy context_tasks_manager_delete on public.context_tasks
for delete to authenticated
using (public.can_manage_class(class_id));

drop policy if exists usability_responses_read on public.usability_responses;
create policy usability_responses_read on public.usability_responses
for select to authenticated
using (
  owner_id = (select auth.uid()) or exists (
    select 1
    from public.context_tasks tests
    where tests.id = usability_responses.test_id
      and (public.can_manage_class(tests.class_id) or public.is_class_member(tests.class_id))
  )
);

drop policy if exists usability_responses_submit on public.usability_responses;
create policy usability_responses_submit on public.usability_responses
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.context_tasks tests
    join public.classes on classes.id = tests.class_id
    where tests.id = usability_responses.test_id
      and tests.active
      and public.is_class_member(tests.class_id)
      and classes.current_stage = 'context'
  )
);

drop policy if exists usability_responses_manager_delete on public.usability_responses;
create policy usability_responses_manager_delete on public.usability_responses
for delete to authenticated
using (
  exists (
    select 1 from public.context_tasks tests
    where tests.id = usability_responses.test_id
      and public.can_manage_class(tests.class_id)
  )
);

drop policy if exists context_examples_read on public.context_examples;
create policy context_examples_read on public.context_examples
for select to authenticated
using (
  owner_id = (select auth.uid()) or exists (
    select 1
    from public.context_tasks
    join public.classes on classes.id = context_tasks.class_id
    where context_tasks.id = context_examples.task_id
      and (
        public.can_manage_class(context_tasks.class_id)
        or (
          public.is_class_member(context_tasks.class_id)
          and context_tasks.active
          and classes.current_stage = 'context'
        )
      )
  )
);

drop policy if exists context_examples_submit on public.context_examples;
create policy context_examples_submit on public.context_examples
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.context_tasks
    join public.classes on classes.id = context_tasks.class_id
    where context_tasks.id = context_examples.task_id
      and context_tasks.active
      and public.is_class_member(context_tasks.class_id)
      and classes.current_stage = 'context'
  )
);

drop policy if exists context_examples_update_own on public.context_examples;
create policy context_examples_update_own on public.context_examples
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.context_tasks
    join public.classes on classes.id = context_tasks.class_id
    where context_tasks.id = context_examples.task_id
      and context_tasks.active
      and public.is_class_member(context_tasks.class_id)
      and classes.current_stage = 'context'
  )
);

drop policy if exists context_examples_manager_delete on public.context_examples;
create policy context_examples_manager_delete on public.context_examples
for delete to authenticated
using (
  exists (
    select 1 from public.context_tasks
    where context_tasks.id = context_examples.task_id
      and public.can_manage_class(context_tasks.class_id)
  )
);

drop policy if exists example_ratings_read on public.example_ratings;
create policy example_ratings_read on public.example_ratings
for select to authenticated
using (
  exists (
    select 1
    from public.context_examples ce
    join public.context_tasks ct on ct.id = ce.task_id
    join public.classes c on c.id = ct.class_id
    where ce.id = example_ratings.example_id
      and (
        public.can_manage_class(ct.class_id)
        or (public.is_class_member(ct.class_id) and ct.active
          and c.current_stage = 'context')
      )
  )
);

drop policy if exists example_ratings_submit on public.example_ratings;
create policy example_ratings_submit on public.example_ratings
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.context_examples ce
    join public.context_tasks ct on ct.id = ce.task_id
    join public.classes c on c.id = ct.class_id
    where ce.id = example_ratings.example_id
      and ce.owner_id <> (select auth.uid())
      and ct.active
      and public.is_class_member(ct.class_id)
      and c.current_stage = 'context'
  )
);

drop policy if exists example_ratings_update_own on public.example_ratings;
create policy example_ratings_update_own on public.example_ratings
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.context_examples ce
    join public.context_tasks ct on ct.id = ce.task_id
    join public.classes c on c.id = ct.class_id
    where ce.id = example_ratings.example_id
      and ce.owner_id <> (select auth.uid())
      and ct.active
      and public.is_class_member(ct.class_id)
      and c.current_stage = 'context'
  )
);

drop policy if exists example_ratings_manager_delete on public.example_ratings;
create policy example_ratings_manager_delete on public.example_ratings
for delete to authenticated
using (
  exists (
    select 1
    from public.context_examples manager_examples
    join public.context_tasks manager_tasks on manager_tasks.id = manager_examples.task_id
    where manager_examples.id = example_ratings.example_id
      and public.can_manage_class(manager_tasks.class_id)
  )
);

drop policy if exists word_suggestions_read on public.word_suggestions;
create policy word_suggestions_read on public.word_suggestions
for select to authenticated
using (
  owner_id = (select auth.uid()) or exists (
    select 1 from public.words
    where words.id = word_suggestions.word_id
      and (
        public.can_manage_class(words.class_id)
        or public.is_class_member(words.class_id)
      )
  )
);

drop policy if exists word_suggestions_submit on public.word_suggestions;
create policy word_suggestions_submit on public.word_suggestions
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.words
    join public.classes on classes.id = words.class_id
    where words.id = word_suggestions.word_id
      and public.is_class_member(words.class_id)
      and classes.current_stage = 'wordmaking'
  )
);

drop policy if exists word_suggestions_update_own on public.word_suggestions;
create policy word_suggestions_update_own on public.word_suggestions
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.words
    join public.classes on classes.id = words.class_id
    where words.id = word_suggestions.word_id
      and public.is_class_member(words.class_id)
      and classes.current_stage = 'wordmaking'
  )
);

drop policy if exists word_suggestions_manager_delete on public.word_suggestions;
create policy word_suggestions_manager_delete on public.word_suggestions
for delete to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = word_suggestions.word_id
      and public.can_manage_class(words.class_id)
  )
);

drop policy if exists suggestion_ratings_read on public.suggestion_ratings;
create policy suggestion_ratings_read on public.suggestion_ratings
for select to authenticated
using (
  exists (
    select 1
    from public.word_suggestions ws
    join public.words w on w.id = ws.word_id
    where ws.id = suggestion_ratings.suggestion_id
      and (
        public.can_manage_class(w.class_id)
        or public.is_class_member(w.class_id)
      )
  )
);

drop policy if exists suggestion_ratings_submit on public.suggestion_ratings;
create policy suggestion_ratings_submit on public.suggestion_ratings
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.word_suggestions ws
    join public.words w on w.id = ws.word_id
    join public.classes c on c.id = w.class_id
    where ws.id = suggestion_ratings.suggestion_id
      and ws.owner_id <> (select auth.uid())
      and public.is_class_member(w.class_id)
      and c.current_stage = 'wordmaking'
  )
);

drop policy if exists suggestion_ratings_update_own on public.suggestion_ratings;
create policy suggestion_ratings_update_own on public.suggestion_ratings
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.word_suggestions ws
    join public.words w on w.id = ws.word_id
    join public.classes c on c.id = w.class_id
    where ws.id = suggestion_ratings.suggestion_id
      and ws.owner_id <> (select auth.uid())
      and public.is_class_member(w.class_id)
      and c.current_stage = 'wordmaking'
  )
);

drop policy if exists suggestion_ratings_manager_delete on public.suggestion_ratings;
create policy suggestion_ratings_manager_delete on public.suggestion_ratings
for delete to authenticated
using (
  exists (
    select 1
    from public.word_suggestions ws
    join public.words w on w.id = ws.word_id
    where ws.id = suggestion_ratings.suggestion_id
      and public.can_manage_class(w.class_id)
  )
);

drop policy if exists launch_votes_read on public.launch_votes;
create policy launch_votes_read on public.launch_votes
for select to authenticated
using (
  owner_id = (select auth.uid()) or exists (
    select 1 from public.words
    where words.id = launch_votes.word_id
      and (public.can_manage_class(words.class_id) or public.is_class_member(words.class_id))
  )
);

drop policy if exists launch_votes_submit on public.launch_votes;
create policy launch_votes_submit on public.launch_votes
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1
    from public.word_suggestions suggestions
    join public.words on words.id = suggestions.word_id
    join public.classes on classes.id = words.class_id
    where suggestions.id = launch_votes.suggestion_id
      and suggestions.word_id = launch_votes.word_id
      and public.is_class_member(words.class_id)
      and classes.current_stage = 'dictionary'
  )
);

drop policy if exists launch_votes_manager_delete on public.launch_votes;
create policy launch_votes_manager_delete on public.launch_votes
for delete to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = launch_votes.word_id
      and public.can_manage_class(words.class_id)
  )
);

drop policy if exists dictionary_public_read on public.dictionary;
create policy dictionary_public_read on public.dictionary
for select to anon
using (false);

drop policy if exists dictionary_authenticated_read on public.dictionary;
create policy dictionary_authenticated_read on public.dictionary
for select to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = dictionary.word_id
      and (public.can_manage_class(words.class_id)
        or (dictionary.approved and public.is_class_member(words.class_id)))
  )
);

drop policy if exists dictionary_admin_insert on public.dictionary;
create policy dictionary_admin_insert on public.dictionary
for insert to authenticated
with check (
  exists (
    select 1 from public.words
    where words.id = dictionary.word_id and public.can_manage_class(words.class_id)
  )
);

drop policy if exists dictionary_admin_update on public.dictionary;
create policy dictionary_admin_update on public.dictionary
for update to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = dictionary.word_id and public.can_manage_class(words.class_id)
  )
)
with check (
  exists (
    select 1 from public.words
    where words.id = dictionary.word_id and public.can_manage_class(words.class_id)
  )
);

drop policy if exists dictionary_admin_delete on public.dictionary;
drop policy if exists dictionary_manager_delete on public.dictionary;
create policy dictionary_manager_delete on public.dictionary
for delete to authenticated
using (
  exists (
    select 1 from public.words
    where words.id = dictionary.word_id
      and public.can_manage_class(words.class_id)
  )
);

drop policy if exists class_pledges_read on public.class_pledges;
create policy class_pledges_read on public.class_pledges
for select to authenticated
using (
  public.can_manage_class(class_id)
  or public.is_class_member(class_id)
);

drop policy if exists class_pledges_submit on public.class_pledges;
create policy class_pledges_submit on public.class_pledges
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and public.is_class_member(class_id)
  and exists (
    select 1 from public.classes
    where classes.id = class_pledges.class_id
      and classes.current_stage = 'dictionary'
  )
);

drop policy if exists class_pledges_update_own on public.class_pledges;
create policy class_pledges_update_own on public.class_pledges
for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and public.is_class_member(class_id)
  and exists (
    select 1 from public.classes
    where classes.id = class_pledges.class_id
      and classes.current_stage = 'dictionary'
  )
);

drop policy if exists class_pledges_manager_delete on public.class_pledges;
create policy class_pledges_manager_delete on public.class_pledges
for delete to authenticated
using (public.can_manage_class(class_id));

revoke all on table public.admins from anon, authenticated;
revoke all on table public.teachers from anon, authenticated;
revoke all on table public.teacher_access_codes from anon, authenticated;
revoke all on table public.classes from anon, authenticated;
revoke all on table public.class_members from anon, authenticated;
revoke all on table public.class_teachers from anon, authenticated;
revoke all on table public.class_recovery from anon, authenticated;
revoke all on table public.words from anon, authenticated;
revoke all on table public.word_ratings from anon, authenticated;
revoke all on table public.context_tasks from anon, authenticated;
revoke all on table public.usability_responses from anon, authenticated;
revoke all on table public.context_examples from anon, authenticated;
revoke all on table public.example_ratings from anon, authenticated;
revoke all on table public.word_suggestions from anon, authenticated;
revoke all on table public.suggestion_ratings from anon, authenticated;
revoke all on table public.launch_votes from anon, authenticated;
revoke all on table public.dictionary from anon, authenticated;
revoke all on table public.class_pledges from anon, authenticated;

grant select on table public.admins to authenticated;
grant select on table public.teachers to authenticated;
grant select, update, delete on table public.classes to authenticated;
grant select on table public.class_members to authenticated;
grant select on table public.class_teachers to authenticated;
grant select, insert, update, delete on table public.words to authenticated;
grant select, insert, update, delete on table public.word_ratings to authenticated;
grant select, insert, update, delete on table public.context_tasks to authenticated;
grant select, insert, delete on table public.usability_responses to authenticated;
grant select, insert, update, delete on table public.context_examples to authenticated;
grant select, insert, update, delete on table public.example_ratings to authenticated;
grant select, insert, update, delete on table public.word_suggestions to authenticated;
grant select, insert, update, delete on table public.suggestion_ratings to authenticated;
grant select, insert, delete on table public.launch_votes to authenticated;
grant select, insert, update, delete on table public.dictionary to authenticated;
grant select, insert, update, delete on table public.class_pledges to authenticated;

-- 학생 활동은 한 번 제출 후 수정하지 않습니다. 교사 관리 정책은 그대로 유지됩니다.
drop policy if exists word_ratings_submit on public.word_ratings;
drop policy if exists context_examples_submit on public.context_examples;
drop policy if exists example_ratings_submit on public.example_ratings;
drop policy if exists class_pledges_submit on public.class_pledges;
drop policy if exists word_ratings_update_own on public.word_ratings;
drop policy if exists context_examples_update_own on public.context_examples;
drop policy if exists example_ratings_update_own on public.example_ratings;
drop policy if exists word_suggestions_update_own on public.word_suggestions;
drop policy if exists suggestion_ratings_update_own on public.suggestion_ratings;
drop policy if exists class_pledges_update_own on public.class_pledges;

-- ================================================================
-- 4차시 검증 확장: 블라인드 A/B 테스트 · 사전 · 선택형 실제 사용 기록
-- 기존 출시 추천 기록은 보존하고 새 검증 데이터만 별도 테이블에 저장합니다.
-- ================================================================

alter table public.classes
  add column if not exists usage_tracking_enabled boolean not null default false;
alter table public.word_suggestions
  add column if not exists core_feature text not null default '핵심 특징 미입력'
  check (char_length(core_feature) between 1 and 600);
alter table public.suggestion_ratings
  add column if not exists clarity_score smallint;

update public.suggestion_ratings
set clarity_score = memorable_score
where clarity_score is null;

alter table public.suggestion_ratings alter column clarity_score set default 3;
alter table public.suggestion_ratings alter column clarity_score set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'suggestion_ratings_clarity_score_check'
      and conrelid = 'public.suggestion_ratings'::regclass
  ) then
    alter table public.suggestion_ratings
      add constraint suggestion_ratings_clarity_score_check check (clarity_score between 1 and 5);
  end if;
end;
$$;

create table if not exists public.ab_tests (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  suggestion_id uuid not null unique references public.word_suggestions(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.ab_responses (
  id uuid primary key default gen_random_uuid(),
  ab_test_id uuid not null references public.ab_tests(id) on delete cascade,
  owner_id uuid not null,
  clarity_choice text not null check (clarity_choice in ('A', 'SAME', 'B')),
  natural_choice text not null check (natural_choice in ('A', 'SAME', 'B')),
  universal_choice text not null check (universal_choice in ('A', 'SAME', 'B')),
  usage_choice text not null check (usage_choice in ('A', 'SAME', 'B')),
  created_at timestamptz not null default now(),
  unique (ab_test_id, owner_id)
);

create table if not exists public.dictionary_usage_logs (
  id uuid primary key default gen_random_uuid(),
  dictionary_id uuid not null references public.dictionary(id) on delete cascade,
  owner_id uuid not null,
  week_start date not null,
  usage_context text not null default '' check (char_length(usage_context) <= 400),
  created_at timestamptz not null default now(),
  unique (dictionary_id, owner_id, week_start)
);

create index if not exists ab_tests_class_id_idx on public.ab_tests(class_id);
create index if not exists ab_tests_word_id_idx on public.ab_tests(word_id);
create index if not exists ab_responses_test_id_idx on public.ab_responses(ab_test_id);
create index if not exists dictionary_usage_logs_dictionary_id_idx on public.dictionary_usage_logs(dictionary_id);
create index if not exists dictionary_usage_logs_week_start_idx on public.dictionary_usage_logs(week_start);

alter table public.ab_tests enable row level security;
alter table public.ab_responses enable row level security;
alter table public.dictionary_usage_logs enable row level security;

drop policy if exists ab_tests_read on public.ab_tests;
create policy ab_tests_read on public.ab_tests
for select to authenticated
using (public.can_manage_class(class_id) or public.is_class_member(class_id));

drop policy if exists ab_tests_manager_insert on public.ab_tests;
create policy ab_tests_manager_insert on public.ab_tests
for insert to authenticated
with check (
  public.can_manage_class(class_id)
  and exists (
    select 1
    from public.word_suggestions suggestions
    join public.words on words.id = suggestions.word_id
    where suggestions.id = ab_tests.suggestion_id
      and words.id = ab_tests.word_id
      and words.class_id = ab_tests.class_id
  )
);

drop policy if exists ab_tests_manager_update on public.ab_tests;
create policy ab_tests_manager_update on public.ab_tests
for update to authenticated
using (public.can_manage_class(class_id))
with check (public.can_manage_class(class_id));

drop policy if exists ab_tests_manager_delete on public.ab_tests;
create policy ab_tests_manager_delete on public.ab_tests
for delete to authenticated
using (public.can_manage_class(class_id));

drop policy if exists ab_responses_read on public.ab_responses;
create policy ab_responses_read on public.ab_responses
for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1 from public.ab_tests
    where ab_tests.id = ab_responses.ab_test_id
      and (public.can_manage_class(ab_tests.class_id) or public.is_class_member(ab_tests.class_id))
  )
);

drop policy if exists ab_responses_submit on public.ab_responses;
create policy ab_responses_submit on public.ab_responses
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1
    from public.ab_tests
    join public.classes on classes.id = ab_tests.class_id
    where ab_tests.id = ab_responses.ab_test_id
      and ab_tests.active
      and classes.current_stage = 'dictionary'
      and public.is_class_member(ab_tests.class_id)
  )
);

drop policy if exists ab_responses_manager_delete on public.ab_responses;
create policy ab_responses_manager_delete on public.ab_responses
for delete to authenticated
using (
  exists (
    select 1 from public.ab_tests
    where ab_tests.id = ab_responses.ab_test_id
      and public.can_manage_class(ab_tests.class_id)
  )
);

drop policy if exists dictionary_usage_logs_read on public.dictionary_usage_logs;
create policy dictionary_usage_logs_read on public.dictionary_usage_logs
for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1
    from public.dictionary
    join public.words on words.id = dictionary.word_id
    where dictionary.id = dictionary_usage_logs.dictionary_id
      and public.can_manage_class(words.class_id)
  )
);

drop policy if exists dictionary_usage_logs_submit on public.dictionary_usage_logs;
create policy dictionary_usage_logs_submit on public.dictionary_usage_logs
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1
    from public.dictionary
    join public.words on words.id = dictionary.word_id
    join public.classes on classes.id = words.class_id
    where dictionary.id = dictionary_usage_logs.dictionary_id
      and dictionary.approved
      and classes.usage_tracking_enabled
      and public.is_class_member(words.class_id)
  )
);

drop policy if exists dictionary_usage_logs_manager_delete on public.dictionary_usage_logs;
create policy dictionary_usage_logs_manager_delete on public.dictionary_usage_logs
for delete to authenticated
using (
  exists (
    select 1
    from public.dictionary
    join public.words on words.id = dictionary.word_id
    where dictionary.id = dictionary_usage_logs.dictionary_id
      and public.can_manage_class(words.class_id)
  )
);

revoke all on table public.ab_tests from anon, authenticated;
revoke all on table public.ab_responses from anon, authenticated;
revoke all on table public.dictionary_usage_logs from anon, authenticated;
grant select, insert, update, delete on table public.ab_tests to authenticated;
grant select, insert, delete on table public.ab_responses to authenticated;
grant select, insert, delete on table public.dictionary_usage_logs to authenticated;


-- 1) Authentication > Users에서 관리자 이메일/비밀번호 계정을 먼저 만드세요.
-- 2) 아래 이메일을 실제 관리자 이메일로 바꾼 뒤 이 한 문장만 실행하세요.
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'admin@example.com'
-- on conflict (user_id) do nothing;

-- 기본 교사 비밀번호는 위 teacher_access_codes 초기값인 school입니다.
-- 운영 전에는 반드시 code_hash를 새 비밀번호의 crypt 해시로 바꾸세요.
