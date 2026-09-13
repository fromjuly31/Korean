-- 2026-09 수업 흐름 개편
-- 기존 데이터를 지우지 않는 추가형 마이그레이션입니다.
-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요.

alter table public.classes
  add column if not exists diagnostic_word_capacity integer not null default 4;
alter table public.classes
  add column if not exists usage_tracking_enabled boolean not null default false;
alter table public.classes
  add column if not exists discussion_topic text not null default '';

alter table public.classes
  drop constraint if exists classes_current_stage_check;
alter table public.classes
  add constraint classes_current_stage_check
  check (current_stage in ('waiting', 'opinion', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'));
alter table public.classes
  drop constraint if exists classes_discussion_topic_check;
alter table public.classes
  add constraint classes_discussion_topic_check
  check (char_length(discussion_topic) <= 300);

alter table public.word_suggestions
  add column if not exists core_feature text not null default '진단 맥락 반영';
alter table public.words
  add column if not exists submit_count integer not null default 1;

create table if not exists public.opinion_responses (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  owner_id uuid not null,
  choice text not null check (choice in ('agree', 'disagree')),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, owner_id)
);

create index if not exists opinion_responses_class_id_idx
  on public.opinion_responses(class_id);

alter table public.opinion_responses enable row level security;

drop policy if exists opinion_responses_read on public.opinion_responses;
create policy opinion_responses_read on public.opinion_responses
for select to authenticated
using (
  owner_id = (select auth.uid())
  or public.can_manage_class(class_id)
);

revoke all on table public.opinion_responses from anon, authenticated;
grant select on table public.opinion_responses to authenticated;

-- 같은 표현을 여러 번 수집해도 출처는 제출 건별로 보존합니다.
create table if not exists public.word_sources (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.words(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  owner_id uuid not null,
  source text not null check (char_length(source) between 1 and 200),
  created_at timestamptz not null default now()
);

create index if not exists word_sources_word_id_idx on public.word_sources(word_id);
create index if not exists word_sources_class_id_idx on public.word_sources(class_id);

alter table public.word_sources enable row level security;
drop policy if exists word_sources_read on public.word_sources;
create policy word_sources_read on public.word_sources
for select to authenticated
using (public.can_manage_class(class_id) or public.is_class_member(class_id));

revoke all on table public.word_sources from anon, authenticated;
grant select on table public.word_sources to authenticated;

create or replace function public.normalize_korean_class_word(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(trim(coalesce(value, '')));
$$;

-- 학생 표현 저장 오류를 함께 복구합니다. 같은 표현은 새 행 대신 등록 횟수만 올리고 출처는 모두 보존합니다.
drop function if exists public.submit_word(uuid, text, text);
create or replace function public.submit_word(p_class_id uuid, p_word text, p_category text, p_source text)
returns table (id uuid, submit_count integer, duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_word text := trim(coalesce(p_word, ''));
  clean_source text := trim(coalesce(p_source, ''));
  normalized text := public.normalize_korean_class_word(p_word);
  found_id uuid;
  next_count integer;
  was_duplicate boolean := false;
begin
  if (select auth.uid()) is null or not public.is_class_member(p_class_id) then
    raise exception '이 클래스에 참여한 학생만 표현을 등록할 수 있습니다.';
  end if;
  if not exists (
    select 1 from public.classes c
    where c.id = p_class_id and c.is_active and c.current_stage = 'submit'
  ) then raise exception '지금은 언어 수집 시간이 아닙니다.'; end if;
  if p_category not in ('유행어', '신조어') then raise exception '유형을 올바르게 선택해 주세요.'; end if;
  if char_length(clean_word) not between 1 and 80 or normalized = '' then raise exception '표현을 입력해 주세요.'; end if;
  if char_length(clean_source) not between 1 and 200 then raise exception '수집 출처를 1~200자로 입력해 주세요.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_class_id::text || ':' || normalized, 0));
  select w.id, w.submit_count into found_id, next_count
  from public.words w
  where w.class_id = p_class_id and w.normalized_word = normalized
  order by w.created_at limit 1 for update;

  if found_id is not null then
    update public.words w set submit_count = w.submit_count + 1 where w.id = found_id
    returning w.submit_count into next_count;
    was_duplicate := true;
  else
    insert into public.words(class_id, owner_id, word, normalized_word, category, submit_count, approved)
    values (p_class_id, (select auth.uid()), clean_word, normalized, p_category, 1, false)
    returning words.id, words.submit_count into found_id, next_count;
  end if;

  insert into public.word_sources(word_id, class_id, owner_id, source)
  values (found_id, p_class_id, (select auth.uid()), clean_source);

  return query select found_id, next_count, was_duplicate;
end;
$$;

-- 1차시 ① 생각 나누기: 교사가 주제를 열고, 같은 QR에서 학생 응답을 받습니다.
create or replace function public.start_opinion_discussion(p_class_id uuid, p_topic text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_topic text := btrim(coalesce(p_topic, ''));
  previous_topic text;
begin
  if not public.can_manage_class(p_class_id) then
    raise exception '이 클래스의 생각 나누기를 시작할 권한이 없습니다.';
  end if;
  if char_length(clean_topic) not between 1 and 300 then
    raise exception '생각 나누기 주제를 1~300자로 입력해 주세요.';
  end if;

  select c.discussion_topic into previous_topic
  from public.classes c
  where c.id = p_class_id and c.is_active
  for update;
  if previous_topic is null then
    raise exception '클래스를 찾을 수 없습니다.';
  end if;

  if previous_topic is distinct from clean_topic then
    delete from public.opinion_responses where class_id = p_class_id;
  end if;

  update public.classes
  set discussion_topic = clean_topic,
      current_stage = 'opinion',
      current_task_id = null,
      updated_at = now()
  where id = p_class_id;
  return true;
end;
$$;

create or replace function public.submit_opinion_response(
  p_class_id uuid,
  p_choice text,
  p_reason text
)
returns table(response_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  clean_choice text := lower(btrim(coalesce(p_choice, '')));
  clean_reason text := btrim(coalesce(p_reason, ''));
  saved_id uuid;
begin
  if current_user_id is null or not public.is_class_member(p_class_id) then
    raise exception '참여 중인 학생만 생각을 나눌 수 있습니다.';
  end if;
  if not exists (
    select 1 from public.classes c
    where c.id = p_class_id and c.is_active and c.current_stage = 'opinion'
  ) then
    raise exception '지금은 생각 나누기 시간이 아닙니다.';
  end if;
  if clean_choice not in ('agree', 'disagree') then
    raise exception '찬성 또는 반대를 선택해 주세요.';
  end if;
  if char_length(clean_reason) not between 1 and 500 then
    raise exception '찬성 또는 반대 이유를 1~500자로 입력해 주세요.';
  end if;

  insert into public.opinion_responses(class_id, owner_id, choice, reason)
  values (p_class_id, current_user_id, clean_choice, clean_reason)
  on conflict (class_id, owner_id) do update set
    choice = excluded.choice,
    reason = excluded.reason,
    updated_at = now()
  returning id into saved_id;

  return query select saved_id;
end;
$$;

create table if not exists public.dictionary (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null unique references public.words(id) on delete cascade,
  suggestion_id uuid references public.word_suggestions(id) on delete set null,
  original_word text not null check (char_length(original_word) between 1 and 120),
  category text not null check (category in ('유행어', '신조어')),
  final_word text not null default '' check (char_length(final_word) <= 160),
  meaning text not null default '' check (char_length(meaning) <= 1200),
  caution text not null default '' check (char_length(caution) <= 1200),
  example_sentence text not null default '' check (char_length(example_sentence) <= 1200),
  approved boolean not null default false,
  updated_at timestamptz not null default now(),
  check (not approved or (char_length(final_word) > 0 and char_length(meaning) > 0))
);

-- 분류 체계를 유행어·신조어 두 가지로 통일합니다.
-- 기존 유행어는 유지하고, 이전 비속어·외래어 자료는 신조어로 합칩니다.
alter table public.words drop constraint if exists words_category_check;
alter table public.context_tasks drop constraint if exists context_tasks_category_check;
alter table public.word_suggestions drop constraint if exists word_suggestions_category_check;
alter table public.dictionary drop constraint if exists dictionary_category_check;

update public.words set category = case when category = '유행어' then '유행어' else '신조어' end;
update public.context_tasks set category = case when category = '유행어' then '유행어' else '신조어' end;
update public.word_suggestions set category = case when category = '유행어' then '유행어' else '신조어' end;
update public.dictionary set category = case when category = '유행어' then '유행어' else '신조어' end;

alter table public.words add constraint words_category_check check (category in ('유행어', '신조어'));
alter table public.context_tasks add constraint context_tasks_category_check check (category in ('유행어', '신조어'));
alter table public.word_suggestions add constraint word_suggestions_category_check check (category in ('유행어', '신조어'));
alter table public.dictionary add constraint dictionary_category_check check (category in ('유행어', '신조어'));

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

-- 일부 기존 설치본에는 기존 클래스 대시보드가 조회하는 사용성 응답 테이블이 없습니다.
create table if not exists public.usability_responses (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.context_tasks(id) on delete cascade,
  owner_id uuid not null,
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (test_id, owner_id)
);

create index if not exists usability_responses_test_id_idx
  on public.usability_responses(test_id);

alter table public.usability_responses enable row level security;

drop policy if exists usability_responses_read on public.usability_responses;
create policy usability_responses_read on public.usability_responses
for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1 from public.context_tasks tests
    where tests.id = usability_responses.test_id
      and (public.can_manage_class(tests.class_id) or public.is_class_member(tests.class_id))
  )
);

drop policy if exists usability_responses_submit on public.usability_responses;
create policy usability_responses_submit on public.usability_responses
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
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
    where tests.id = usability_responses.test_id
      and public.can_manage_class(tests.class_id)
  )
);

revoke all on table public.usability_responses from anon, authenticated;
grant select, insert, delete on table public.usability_responses to authenticated;

alter table public.classes
  drop constraint if exists classes_diagnostic_word_capacity_check;
alter table public.classes
  add constraint classes_diagnostic_word_capacity_check
  check (diagnostic_word_capacity between 1 and 50);

create table if not exists public.diagnostic_cards (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  owner_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'complete')),
  dimensions text[] not null default '{}',
  appropriate_partner text not null default '' check (char_length(appropriate_partner) <= 200),
  appropriate_place text not null default '' check (char_length(appropriate_place) <= 200),
  appropriate_situation text not null default '' check (char_length(appropriate_situation) <= 500),
  appropriate_example text not null default '' check (char_length(appropriate_example) <= 800),
  appropriate_rating smallint check (appropriate_rating between 1 and 5),
  inappropriate_partner text not null default '' check (char_length(inappropriate_partner) <= 200),
  inappropriate_place text not null default '' check (char_length(inappropriate_place) <= 200),
  inappropriate_situation text not null default '' check (char_length(inappropriate_situation) <= 500),
  inappropriate_example text not null default '' check (char_length(inappropriate_example) <= 800),
  inappropriate_rating smallint check (inappropriate_rating between 1 and 5),
  rating_reason text not null default '' check (char_length(rating_reason) <= 800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, owner_id)
);

alter table public.word_suggestions
  add column if not exists diagnostic_card_id uuid references public.diagnostic_cards(id) on delete set null;

create index if not exists diagnostic_cards_class_id_idx on public.diagnostic_cards(class_id);
create index if not exists diagnostic_cards_word_id_idx on public.diagnostic_cards(word_id);
create index if not exists diagnostic_cards_status_idx on public.diagnostic_cards(status);
create index if not exists word_suggestions_diagnostic_card_id_idx on public.word_suggestions(diagnostic_card_id);

alter table public.diagnostic_cards enable row level security;
alter table public.dictionary enable row level security;
alter table public.ab_tests enable row level security;
alter table public.ab_responses enable row level security;
alter table public.dictionary_usage_logs enable row level security;

drop policy if exists diagnostic_cards_read on public.diagnostic_cards;
create policy diagnostic_cards_read on public.diagnostic_cards
for select to authenticated
using (
  owner_id = (select auth.uid())
  or public.can_manage_class(class_id)
  or public.is_class_member(class_id)
);

drop policy if exists diagnostic_cards_manager_delete on public.diagnostic_cards;
create policy diagnostic_cards_manager_delete on public.diagnostic_cards
for delete to authenticated
using (public.can_manage_class(class_id));

revoke all on table public.diagnostic_cards from anon, authenticated;
grant select, delete on table public.diagnostic_cards to authenticated;

drop policy if exists dictionary_authenticated_read on public.dictionary;
create policy dictionary_authenticated_read on public.dictionary
for select to authenticated
using (
  exists (
    select 1 from public.words w
    where w.id = dictionary.word_id
      and (public.can_manage_class(w.class_id) or (dictionary.approved and public.is_class_member(w.class_id)))
  )
);

drop policy if exists ab_tests_read on public.ab_tests;
create policy ab_tests_read on public.ab_tests
for select to authenticated
using (public.can_manage_class(class_id) or public.is_class_member(class_id));

drop policy if exists ab_responses_read on public.ab_responses;
create policy ab_responses_read on public.ab_responses
for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1 from public.ab_tests t
    where t.id = ab_responses.ab_test_id
      and (public.can_manage_class(t.class_id) or public.is_class_member(t.class_id))
  )
);

drop policy if exists dictionary_usage_logs_read on public.dictionary_usage_logs;
create policy dictionary_usage_logs_read on public.dictionary_usage_logs
for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1 from public.dictionary d join public.words w on w.id = d.word_id
    where d.id = dictionary_usage_logs.dictionary_id and public.can_manage_class(w.class_id)
  )
);

revoke all on table public.dictionary from anon, authenticated;
revoke all on table public.ab_tests from anon, authenticated;
revoke all on table public.ab_responses from anon, authenticated;
revoke all on table public.dictionary_usage_logs from anon, authenticated;
grant select, insert, update, delete on table public.dictionary to authenticated;
grant select, insert, update, delete on table public.ab_tests to authenticated;
grant select, insert, delete on table public.ab_responses to authenticated;
grant select, insert, delete on table public.dictionary_usage_logs to authenticated;

-- 단어 선택은 행 잠금 안에서 정원을 확인하므로 동시에 눌러도 초과 배정되지 않습니다.
create or replace function public.claim_diagnostic_word(p_class_id uuid, p_word_id uuid)
returns table(card_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_capacity integer;
  target_stage text;
  existing_card uuid;
  selected_count integer;
begin
  if current_user_id is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select c.diagnostic_word_capacity, c.current_stage
    into target_capacity, target_stage
  from public.classes c
  where c.id = p_class_id
  for update;

  if target_capacity is null or not public.is_class_member(p_class_id) then
    raise exception '참여 중인 클래스를 확인할 수 없습니다.';
  end if;
  if target_stage <> 'context' then
    raise exception '지금은 2차시 진단 시간이 아닙니다.';
  end if;
  if not exists (select 1 from public.words w where w.id = p_word_id and w.class_id = p_class_id) then
    raise exception '선택할 표현을 찾을 수 없습니다.';
  end if;

  select dc.id into existing_card
  from public.diagnostic_cards dc
  where dc.class_id = p_class_id and dc.owner_id = current_user_id;
  if existing_card is not null then
    return query select existing_card;
    return;
  end if;

  select count(*)::integer into selected_count
  from public.diagnostic_cards dc
  where dc.class_id = p_class_id and dc.word_id = p_word_id;
  if selected_count >= target_capacity then
    raise exception '이 표현은 선택이 마감되었습니다. 다른 표현을 골라 주세요.';
  end if;

  insert into public.diagnostic_cards(class_id, word_id, owner_id)
  values (p_class_id, p_word_id, current_user_id)
  returning id into existing_card;
  return query select existing_card;
end;
$$;

create or replace function public.save_diagnostic_card(
  p_card_id uuid,
  p_dimensions text[],
  p_appropriate_partner text,
  p_appropriate_place text,
  p_appropriate_situation text,
  p_appropriate_example text,
  p_appropriate_rating smallint,
  p_inappropriate_partner text,
  p_inappropriate_place text,
  p_inappropriate_situation text,
  p_inappropriate_example text,
  p_inappropriate_rating smallint,
  p_rating_reason text
)
returns table(card_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_class_id uuid;
  selected_dimensions text[];
  dimension_name text;
begin
  select dc.class_id into target_class_id
  from public.diagnostic_cards dc
  where dc.id = p_card_id and dc.owner_id = current_user_id;

  if target_class_id is null then raise exception '작성 중인 진단 카드를 찾을 수 없습니다.'; end if;
  if not exists (
    select 1 from public.classes c
    where c.id = target_class_id and c.current_stage = 'context'
      and public.is_class_member(c.id)
  ) then raise exception '지금은 2차시 진단을 제출할 수 없습니다.'; end if;

  select array_agg(distinct dimension_value) into selected_dimensions
  from unnest(coalesce(p_dimensions, '{}')) as dimensions(dimension_value)
  where dimension_value in ('partner', 'place', 'situation');
  if coalesce(array_length(selected_dimensions, 1), 0) < 2 then
    raise exception '대화 상대, 장소, 상황 중 두 가지 이상을 선택해 주세요.';
  end if;

  foreach dimension_name in array selected_dimensions loop
    if dimension_name = 'partner' and
      (char_length(btrim(coalesce(p_appropriate_partner, ''))) = 0 or char_length(btrim(coalesce(p_inappropriate_partner, ''))) = 0) then
      raise exception '적절한 경우와 그렇지 않은 경우의 대화 상대를 모두 적어 주세요.';
    elsif dimension_name = 'place' and
      (char_length(btrim(coalesce(p_appropriate_place, ''))) = 0 or char_length(btrim(coalesce(p_inappropriate_place, ''))) = 0) then
      raise exception '적절한 경우와 그렇지 않은 경우의 대화 장소를 모두 적어 주세요.';
    elsif dimension_name = 'situation' and
      (char_length(btrim(coalesce(p_appropriate_situation, ''))) = 0 or char_length(btrim(coalesce(p_inappropriate_situation, ''))) = 0) then
      raise exception '적절한 경우와 그렇지 않은 경우의 대화 상황을 모두 적어 주세요.';
    end if;
  end loop;

  if char_length(btrim(coalesce(p_appropriate_example, ''))) = 0 or
     char_length(btrim(coalesce(p_inappropriate_example, ''))) = 0 then
    raise exception '두 경우의 예문을 모두 적어 주세요.';
  end if;
  if p_appropriate_rating not between 1 and 5 or p_inappropriate_rating not between 1 and 5 then
    raise exception '두 예문의 별점을 모두 선택해 주세요.';
  end if;
  if char_length(btrim(coalesce(p_rating_reason, ''))) = 0 then
    raise exception '별점을 준 이유를 적어 주세요.';
  end if;

  update public.diagnostic_cards set
    status = 'complete', dimensions = selected_dimensions,
    appropriate_partner = left(btrim(coalesce(p_appropriate_partner, '')), 200),
    appropriate_place = left(btrim(coalesce(p_appropriate_place, '')), 200),
    appropriate_situation = left(btrim(coalesce(p_appropriate_situation, '')), 500),
    appropriate_example = left(btrim(p_appropriate_example), 800),
    appropriate_rating = p_appropriate_rating,
    inappropriate_partner = left(btrim(coalesce(p_inappropriate_partner, '')), 200),
    inappropriate_place = left(btrim(coalesce(p_inappropriate_place, '')), 200),
    inappropriate_situation = left(btrim(coalesce(p_inappropriate_situation, '')), 500),
    inappropriate_example = left(btrim(p_inappropriate_example), 800),
    inappropriate_rating = p_inappropriate_rating,
    rating_reason = left(btrim(p_rating_reason), 800), updated_at = now()
  where id = p_card_id and owner_id = current_user_id;

  return query select p_card_id;
end;
$$;

create or replace function public.submit_diagnostic_redesign(
  p_card_id uuid,
  p_suggested_word text,
  p_meaning text,
  p_reason text,
  p_example_sentence text
)
returns table(suggestion_id uuid, test_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  card_row record;
  word_row record;
  new_suggestion_id uuid;
  new_test_id uuid;
begin
  select dc.* into card_row
  from public.diagnostic_cards dc
  where dc.id = p_card_id and dc.status = 'complete';
  if card_row.id is null then raise exception '선택한 진단 카드를 찾을 수 없습니다.'; end if;
  if not public.is_class_member(card_row.class_id) or not exists (
    select 1 from public.classes c where c.id = card_row.class_id and c.current_stage = 'wordmaking'
  ) then raise exception '지금은 3차시 설계안을 제출할 수 없습니다.'; end if;
  if char_length(btrim(coalesce(p_suggested_word, ''))) not between 1 and 120 then raise exception '새 표현을 입력해 주세요.'; end if;
  if char_length(btrim(coalesce(p_meaning, ''))) not between 1 and 600 then raise exception '새 표현의 뜻을 입력해 주세요.'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 600 then raise exception '바꾼 이유를 입력해 주세요.'; end if;
  if char_length(btrim(coalesce(p_example_sentence, ''))) not between 1 and 800 then raise exception '새 예문을 입력해 주세요.'; end if;
  if exists (
    select 1 from public.word_suggestions ws
    where ws.owner_id = current_user_id and ws.diagnostic_card_id = p_card_id
  ) then raise exception '이 진단 카드에는 이미 새 표현을 설계했습니다.'; end if;

  select w.* into word_row from public.words w where w.id = card_row.word_id and w.class_id = card_row.class_id;
  if word_row.id is null then raise exception '원래 표현을 찾을 수 없습니다.'; end if;

  insert into public.word_suggestions(
    owner_id, word_id, diagnostic_card_id, original_word, category, suggestion_type,
    meaning, core_feature, suggested_word, reason, example_sentence
  ) values (
    current_user_id, word_row.id, card_row.id, word_row.word, word_row.category, '새로운 말 만들기',
    left(btrim(p_meaning),600), array_to_string(card_row.dimensions, ' · '),
    left(btrim(p_suggested_word),120), left(btrim(p_reason),600), left(btrim(p_example_sentence),800)
  ) returning id into new_suggestion_id;

  insert into public.ab_tests(class_id, word_id, suggestion_id, active)
  values (card_row.class_id, word_row.id, new_suggestion_id, true)
  returning id into new_test_id;

  return query select new_suggestion_id, new_test_id;
end;
$$;

-- 3차시 설계안을 학생이 등록하면 4차시의 1:1 비교 항목도 자동으로 준비합니다.
drop policy if exists ab_tests_student_insert on public.ab_tests;
create policy ab_tests_student_insert on public.ab_tests
for insert to authenticated
with check (
  public.is_class_member(class_id)
  and exists (
    select 1
    from public.word_suggestions ws
    join public.words w on w.id = ws.word_id
    join public.classes c on c.id = w.class_id
    where ws.id = ab_tests.suggestion_id
      and ws.owner_id = (select auth.uid())
      and w.id = ab_tests.word_id
      and w.class_id = ab_tests.class_id
      and c.current_stage = 'wordmaking'
  )
);

-- 한 번의 1:1 선택을 저장하고 현재 다수 선택을 학급 사전에 즉시 반영합니다.
create or replace function public.submit_comparison_vote(p_test_id uuid, p_choice text)
returns table(winner text, original_votes integer, redesign_votes integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  test_row record;
  word_row record;
  suggestion_row record;
  a_count integer;
  b_count integer;
  best_suggestion_id uuid;
  best_margin integer;
  winner_word text;
begin
  if upper(coalesce(p_choice, '')) not in ('A', 'B') then
    raise exception '두 표현 중 하나를 선택해 주세요.';
  end if;

  select t.* into test_row from public.ab_tests t where t.id = p_test_id and t.active;
  if test_row.id is null then raise exception '진행 중인 비교를 찾을 수 없습니다.'; end if;
  if not public.is_class_member(test_row.class_id) or not exists (
    select 1 from public.classes c where c.id = test_row.class_id and c.current_stage = 'dictionary'
  ) then raise exception '지금은 4차시 검증에 참여할 수 없습니다.'; end if;
  if exists (select 1 from public.ab_responses r where r.ab_test_id = p_test_id and r.owner_id = current_user_id) then
    raise exception '이미 선택한 비교입니다.';
  end if;

  insert into public.ab_responses(
    ab_test_id, owner_id, clarity_choice, natural_choice, universal_choice, usage_choice
  ) values (
    p_test_id, current_user_id, upper(p_choice), upper(p_choice), upper(p_choice), upper(p_choice)
  );

  select count(*) filter (where r.usage_choice = 'A')::integer,
         count(*) filter (where r.usage_choice = 'B')::integer
    into a_count, b_count
  from public.ab_responses r where r.ab_test_id = p_test_id;

  select t.suggestion_id,
         coalesce(sum(case when r.usage_choice = 'B' then 1 when r.usage_choice = 'A' then -1 else 0 end), 0)::integer
    into best_suggestion_id, best_margin
  from public.ab_tests t
  left join public.ab_responses r on r.ab_test_id = t.id
  where t.word_id = test_row.word_id and t.active
  group by t.suggestion_id
  order by coalesce(sum(case when r.usage_choice = 'B' then 1 when r.usage_choice = 'A' then -1 else 0 end), 0) desc,
           count(*) filter (where r.usage_choice = 'B') desc
  limit 1;

  select w.* into word_row from public.words w where w.id = test_row.word_id;
  select ws.* into suggestion_row from public.word_suggestions ws where ws.id = best_suggestion_id;
  if word_row.id is null or suggestion_row.id is null then raise exception '비교할 표현 정보를 찾을 수 없습니다.'; end if;

  if best_margin > 0 then
    winner_word := suggestion_row.suggested_word;
    insert into public.dictionary(
      word_id, suggestion_id, original_word, category, final_word, meaning, example_sentence, approved, updated_at
    ) values (
      word_row.id, suggestion_row.id, word_row.word, word_row.category, suggestion_row.suggested_word,
      coalesce(nullif(suggestion_row.meaning, ''), '우리 반 검증을 거친 표현'),
      coalesce(suggestion_row.example_sentence, ''), true, now()
    ) on conflict (word_id) do update set
      suggestion_id = excluded.suggestion_id, final_word = excluded.final_word,
      meaning = excluded.meaning, example_sentence = excluded.example_sentence,
      approved = true, updated_at = now();
  else
    winner_word := word_row.word;
    insert into public.dictionary(
      word_id, suggestion_id, original_word, category, final_word, meaning, example_sentence, approved, updated_at
    ) values (
      word_row.id, null, word_row.word, word_row.category, word_row.word,
      '우리 반 검증에서 더 적합하다고 선택한 기존 표현', '', true, now()
    ) on conflict (word_id) do update set
      suggestion_id = null, final_word = excluded.final_word, meaning = excluded.meaning,
      example_sentence = '', approved = true, updated_at = now();
  end if;

  return query select winner_word, a_count, b_count;
end;
$$;

revoke all on function public.claim_diagnostic_word(uuid, uuid) from public;
revoke all on function public.save_diagnostic_card(uuid, text[], text, text, text, text, smallint, text, text, text, text, smallint, text) from public;
revoke all on function public.submit_diagnostic_redesign(uuid, text, text, text, text) from public;
revoke all on function public.submit_comparison_vote(uuid, text) from public;
revoke all on function public.start_opinion_discussion(uuid, text) from public;
revoke all on function public.submit_opinion_response(uuid, text, text) from public;
grant execute on function public.claim_diagnostic_word(uuid, uuid) to authenticated;
revoke all on function public.submit_word(uuid, text, text, text) from public;
grant execute on function public.submit_word(uuid, text, text, text) to authenticated;
grant execute on function public.save_diagnostic_card(uuid, text[], text, text, text, text, smallint, text, text, text, text, smallint, text) to authenticated;
grant execute on function public.submit_diagnostic_redesign(uuid, text, text, text, text) to authenticated;
grant execute on function public.submit_comparison_vote(uuid, text) to authenticated;
grant execute on function public.start_opinion_discussion(uuid, text) to authenticated;
grant execute on function public.submit_opinion_response(uuid, text, text) to authenticated;

-- 일부 기존 설치본에 빠진 결과 초기화 RPC도 함께 복구합니다.
-- words를 지우면 진단 카드, 설계안, 비교, 사전 자료는 외래 키 cascade로 함께 정리됩니다.
create or replace function public.reset_class_results(p_class_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_manage_class(p_class_id) then
    raise exception '이 클래스의 결과를 초기화할 권한이 없습니다.';
  end if;

  update public.classes
  set current_stage = 'waiting', current_task_id = null, discussion_topic = '', updated_at = now()
  where id = p_class_id;
  delete from public.opinion_responses where class_id = p_class_id;
  delete from public.class_pledges where class_id = p_class_id;
  delete from public.context_tasks where class_id = p_class_id;
  delete from public.words where class_id = p_class_id;
  return true;
end;
$$;

revoke all on function public.reset_class_results(uuid) from public;
grant execute on function public.reset_class_results(uuid) to authenticated;

-- Realtime에서 교사 화면이 학생 진단·설계·검증을 즉시 받을 수 있게 합니다.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'opinion_responses'
  ) then
    alter publication supabase_realtime add table public.opinion_responses;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'diagnostic_cards'
  ) then
    alter publication supabase_realtime add table public.diagnostic_cards;
  end if;
end;
$$;

notify pgrst, 'reload schema';
