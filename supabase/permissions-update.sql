-- 클래스 코드 직접 설정·찾기와 교사/관리자 삭제 권한 업데이트
-- 기존 데이터를 지우지 않습니다. Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요.

create extension if not exists pgcrypto with schema extensions;

-- 찾기 힌트는 원문을 저장하지 않고 단방향 해시만 별도 보관합니다.
create table if not exists public.class_recovery (
  class_id uuid primary key references public.classes(id) on delete cascade,
  hint_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.context_examples
  add column if not exists intent text not null default '작성 의도 미입력'
  check (char_length(intent) between 1 and 600);

alter table public.context_tasks
  add column if not exists context_group_id uuid not null default gen_random_uuid();
alter table public.context_tasks
  add column if not exists context_title text not null default '공통 맥락'
  check (char_length(context_title) between 1 and 120);
create index if not exists context_tasks_context_group_id_idx
  on public.context_tasks(context_group_id);
create unique index if not exists context_tasks_group_word_uidx
  on public.context_tasks(context_group_id, word_id);

create table if not exists public.suggestion_ratings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  suggestion_id uuid not null references public.word_suggestions(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (owner_id, suggestion_id)
);

create table if not exists public.class_pledges (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  owner_id uuid not null,
  pledge text not null check (char_length(pledge) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (class_id, owner_id)
);

create index if not exists suggestion_ratings_suggestion_id_idx
  on public.suggestion_ratings(suggestion_id);
create index if not exists class_pledges_class_id_idx
  on public.class_pledges(class_id);

alter table public.classes drop constraint if exists classes_class_code_check;
alter table public.classes
  add constraint classes_class_code_check check (class_code ~ '^[A-Z0-9]{4,12}$');

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

revoke all on function public.create_class(text, text, text, text, text, text) from public;
revoke all on function public.recover_class_code(text, text, text, text, text) from public;
grant execute on function public.create_class(text, text, text, text, text, text) to authenticated;
grant execute on function public.recover_class_code(text, text, text, text, text) to authenticated;

alter table public.class_recovery enable row level security;
alter table public.suggestion_ratings enable row level security;
alter table public.class_pledges enable row level security;
revoke all on table public.class_recovery from anon, authenticated;
revoke all on table public.suggestion_ratings from anon, authenticated;
revoke all on table public.class_pledges from anon, authenticated;
grant select, insert, update, delete on table public.suggestion_ratings to authenticated;
grant select, insert, update, delete on table public.class_pledges to authenticated;
revoke insert on table public.classes from authenticated;

-- 1차시에는 같은 반의 수집 표현을 함께 보고 즉시 별점을 매깁니다.
drop policy if exists words_read on public.words;
create policy words_read on public.words
for select to authenticated
using (
  public.can_manage_class(class_id)
  or public.is_class_member(class_id)
);

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

-- 2차시는 선택한 여러 표현과 여러 맥락을 한꺼번에 학생에게 공개합니다.
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
        or (public.is_class_member(ct.class_id) and ct.active and c.current_stage = 'context')
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

-- 새 행을 반환할 때 개설 교사가 자신의 클래스를 바로 읽을 수 있게 합니다.
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
with check (
  teacher_id = (select auth.uid())
  and public.is_teacher()
);

-- 클래스 자체 삭제는 시스템 관리자만 가능합니다.
drop policy if exists classes_admin_delete on public.classes;
create policy classes_admin_delete on public.classes
for delete to authenticated
using (public.is_admin());

-- 교사는 자기 클래스 자료를, 관리자는 모든 클래스 자료를 삭제할 수 있습니다.
-- can_manage_class()는 클래스 담당 교사 또는 시스템 관리자일 때만 true입니다.
drop policy if exists words_admin_delete on public.words;
drop policy if exists words_manager_delete on public.words;
create policy words_manager_delete on public.words
for delete to authenticated
using (public.can_manage_class(class_id));

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

drop policy if exists context_tasks_admin_delete on public.context_tasks;
drop policy if exists context_tasks_manager_delete on public.context_tasks;
create policy context_tasks_manager_delete on public.context_tasks
for delete to authenticated
using (public.can_manage_class(class_id));

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

-- 3차시는 같은 반의 순화 제안과 별점을 함께 봅니다.
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

-- 4차시 다짐은 같은 반에서 읽고 한 사람당 하나씩 작성·수정합니다.
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

-- ================================================================
-- 2026 수업 흐름 개선: 수집 → 사용성 테스트 → 리디자인 → 출시
-- 기존 테이블과 자료를 유지하면서 필요한 열과 응답 테이블만 확장합니다.
-- ================================================================

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

create or replace function public.normalize_korean_class_word(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(trim(coalesce(value, '')));
$$;

-- 기존 자료도 새 중복 기준(공백·영문 대소문자 통일)에 맞춥니다.
update public.words
set normalized_word = lower(trim(word))
where normalized_word is distinct from lower(trim(word));

update public.classes
set current_stage = 'submit', current_task_id = null
where current_stage = 'rate';

alter table public.words
  add column if not exists submit_count integer not null default 1 check (submit_count > 0);
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

create table if not exists public.usability_responses (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.context_tasks(id) on delete cascade,
  owner_id uuid not null,
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (test_id, owner_id)
);

create table if not exists public.launch_votes (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.words(id) on delete cascade,
  suggestion_id uuid not null references public.word_suggestions(id) on delete cascade,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  unique (word_id, owner_id)
);

create index if not exists usability_responses_test_id_idx on public.usability_responses(test_id);
create index if not exists launch_votes_suggestion_id_idx on public.launch_votes(suggestion_id);

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
  update public.classes set current_stage = 'waiting', current_task_id = null where id = p_class_id;
  delete from public.class_pledges where class_id = p_class_id;
  delete from public.context_tasks where class_id = p_class_id;
  delete from public.words where class_id = p_class_id;
  return true;
end;
$$;

revoke all on function public.submit_word(uuid, text, text) from public;
revoke all on function public.reset_class_results(uuid) from public;
grant execute on function public.submit_word(uuid, text, text) to authenticated;
grant execute on function public.reset_class_results(uuid) to authenticated;

alter table public.usability_responses enable row level security;
alter table public.launch_votes enable row level security;
revoke all on table public.usability_responses from anon, authenticated;
revoke all on table public.launch_votes from anon, authenticated;
grant select, insert, delete on table public.usability_responses to authenticated;
grant select, insert, delete on table public.launch_votes to authenticated;

drop policy if exists usability_responses_read on public.usability_responses;
create policy usability_responses_read on public.usability_responses
for select to authenticated
using (
  owner_id = (select auth.uid()) or exists (
    select 1 from public.context_tasks tests
    where tests.id = usability_responses.test_id
      and (public.can_manage_class(tests.class_id) or public.is_class_member(tests.class_id))
  )
);

drop policy if exists usability_responses_submit on public.usability_responses;
create policy usability_responses_submit on public.usability_responses
for insert to authenticated
with check (
  owner_id = (select auth.uid()) and exists (
    select 1 from public.context_tasks tests
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
    where tests.id = usability_responses.test_id and public.can_manage_class(tests.class_id)
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
    where words.id = launch_votes.word_id and public.can_manage_class(words.class_id)
  )
);

-- 학생의 단어 등록은 중복 병합 RPC만 통과하도록 제한합니다.
drop policy if exists words_submit on public.words;
create policy words_submit on public.words
for insert to authenticated
with check (public.can_manage_class(class_id));

-- 1차시에서 수집된 모든 표현은 별도 승인 없이 3차시로 연결됩니다.
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

-- 학생은 제출 이후 기존 행을 수정하지 않습니다.
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
grant execute on function public.claim_teacher_access(text) to authenticated;

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


-- 교사는 teacher_access_codes에 등록된 수업용 비밀번호로 입장합니다.
