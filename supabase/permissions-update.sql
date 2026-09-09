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
        or (words.approved and public.is_class_member(words.class_id))
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
        or (w.approved and public.is_class_member(w.class_id))
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
      and w.approved
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
      and w.approved
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
