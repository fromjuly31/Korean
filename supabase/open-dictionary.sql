-- 공개 학급 우리말 순화어 사전: 새/기존 Supabase SQL Editor에서 이 파일 전체 실행.
-- 기존 수업 테이블은 변경하거나 삭제하지 않습니다. 재실행해도 자료를 보존합니다.
begin;
create schema if not exists dictionary_reader;
-- Nicknames are safe display data, never authorization claims. No email or real display name is read.
-- The invoker helper is called only by the existing restricted reader RPCs.
create or replace function dictionary_reader.author_name(p_user_id uuid) returns text
language sql stable security invoker set search_path='' as $$
  select coalesce(nullif(u.raw_app_meta_data->>'dictionary_nickname',''),
    (array['다정한','느긋한','반짝이는','씩씩한','포근한','명랑한','수줍은','산뜻한','꿈꾸는','행복한'])
      [1+(('x'||substr(md5(p_user_id::text),1,4))::bit(16)::integer%10)] ||
    (array['수달','고양이','고래','토끼','고슴도치','다람쥐','나무','구름','별','연필','책갈피','해바라기'])
      [1+(('x'||substr(md5(p_user_id::text),5,4))::bit(16)::integer%12)] ||
    lpad(((('x'||substr(md5(p_user_id::text),9,4))::bit(16)::integer%1000)::text),3,'0'))
  from auth.users u where u.id=p_user_id;
$$;
revoke all on function dictionary_reader.author_name(uuid) from public,anon,authenticated;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.dictionary_settings (
  id boolean primary key default true check (id),
  admin_password_hash text not null,
  write_limit_bytes bigint not null default 450000000 check (write_limit_bytes between 1 and 450000000),
  writes_enabled boolean not null default true
);
insert into public.dictionary_settings(id, admin_password_hash)
values(true, extensions.crypt('admin123', extensions.gen_salt('bf')))
on conflict(id) do nothing;

create table if not exists public.dictionary_admin_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null default '-infinity',
  failed_attempts integer not null default 0,
  locked_until timestamptz not null default '-infinity'
);
create table if not exists public.class_dictionaries (
  id uuid primary key default gen_random_uuid(),
  school text not null check(char_length(trim(school)) between 1 and 80),
  grade text not null check(char_length(trim(grade)) between 1 and 20),
  class_name text not null check(char_length(trim(class_name)) between 1 and 40),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(school, grade, class_name)
);
create table if not exists public.dictionary_words (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.class_dictionaries(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  word text not null check(char_length(trim(word)) between 1 and 80),
  category text not null check(category in ('비속어','유행어','외래어','신조어','기타')),
  meaning text not null check(char_length(trim(meaning)) between 1 and 600),
  reason text not null check(char_length(trim(reason)) between 1 and 600),
  created_at timestamptz not null default now()
);
-- 서로 다른 학생은 같은 표현을 각자의 뜻풀이로 등록할 수 있습니다.
-- 같은 학생의 재등록과 저장 재시도만 중복으로 막습니다.
drop index if exists public.dictionary_words_unique;
create unique index if not exists dictionary_words_owner_unique on public.dictionary_words(class_id, owner_id, lower(trim(word)));
create index if not exists dictionary_words_group_idx on public.dictionary_words(class_id,lower(trim(word)));
create table if not exists public.dictionary_word_ratings (
  word_id uuid not null references public.dictionary_words(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  rating smallint not null check(rating between 1 and 5),
  primary key(word_id, owner_id)
);
create table if not exists public.dictionary_revisions (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.dictionary_words(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  word text not null check(char_length(trim(word)) between 1 and 80),
  meaning text not null check(char_length(trim(meaning)) between 1 and 600),
  reason text not null check(char_length(trim(reason)) between 1 and 600),
  example text not null check(char_length(trim(example)) between 1 and 600),
  selected boolean not null default false,
  selected_by uuid references auth.users(id),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  unique(word_id, owner_id)
);
create table if not exists public.dictionary_revision_ratings (
  revision_id uuid not null references public.dictionary_revisions(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  rating smallint not null check(rating between 1 and 5),
  primary key(revision_id, owner_id)
);
create index if not exists dictionary_words_class_idx on public.dictionary_words(class_id, created_at);
create index if not exists dictionary_revisions_word_idx on public.dictionary_revisions(word_id);

-- API는 아래 제한된 RPC만 사용합니다. 직접 테이블 변경으로 비밀번호·평점·용량 검사를 우회할 수 없습니다.
alter table public.dictionary_settings enable row level security;
alter table public.dictionary_admin_sessions enable row level security;
alter table public.class_dictionaries enable row level security;
alter table public.dictionary_words enable row level security;
alter table public.dictionary_word_ratings enable row level security;
alter table public.dictionary_revisions enable row level security;
alter table public.dictionary_revision_ratings enable row level security;
revoke all on public.dictionary_settings, public.dictionary_admin_sessions, public.class_dictionaries,
  public.dictionary_words, public.dictionary_word_ratings, public.dictionary_revisions,
  public.dictionary_revision_ratings from anon, authenticated;

create or replace function public.dictionary_require_user() returns uuid
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception '접속 정보가 만료되었습니다. 새로고침해 주세요.'; end if;
  return auth.uid();
end; $$;

create or replace function public.dictionary_is_admin() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.dictionary_admin_sessions where user_id=auth.uid() and expires_at>now());
$$;

create or replace function public.dictionary_admin_login(p_password text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare session_row public.dictionary_admin_sessions%rowtype; stored_hash text;
begin
  perform public.dictionary_require_user();
  insert into public.dictionary_admin_sessions(user_id) values(auth.uid()) on conflict do nothing;
  select * into session_row from public.dictionary_admin_sessions where user_id=auth.uid() for update;
  if session_row.locked_until>now() then return false; end if;
  select admin_password_hash into stored_hash from public.dictionary_settings where id;
  if p_password is not null and char_length(p_password)<=100 and extensions.crypt(p_password,stored_hash)=stored_hash then
    update public.dictionary_admin_sessions set expires_at=now()+interval '8 hours',failed_attempts=0,locked_until='-infinity' where user_id=auth.uid();
    return true;
  end if;
  update public.dictionary_admin_sessions set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
    locked_until=case when failed_attempts>=4 then now()+interval '15 minutes' else '-infinity' end where user_id=auth.uid();
  return false;
end; $$;

create or replace function public.dictionary_admin_logout() returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin delete from public.dictionary_admin_sessions where user_id=auth.uid(); return true; end; $$;

-- 500 MB 무료 DB 한도보다 낮은 450 MB에서 저장을 차단합니다.
-- 서버의 실제 DB 크기를 매 쓰기마다 검사하며, 동시 쓰기는 같은 잠금으로 직렬화합니다.
-- 관리자의 로그인·삭제는 용량 제한과 무관하게 가능하도록 이 트리거 대상에서 제외합니다.
create or replace function public.dictionary_guard_write() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare capacity bigint; enabled boolean;
begin
  perform pg_advisory_xact_lock(91020261106);
  select write_limit_bytes,writes_enabled into capacity,enabled from public.dictionary_settings where id;
  if capacity is null or not coalesce(enabled,false) or pg_database_size(current_database())+pg_column_size(new)+65536>=capacity then
    raise exception using errcode='P0001',message='무료 저장 용량 보호 한도에 도달해 저장을 중단했습니다. 관리자에게 자료 정리를 요청해 주세요.';
  end if;
  return new;
end; $$;
do $$ declare table_name text; begin
  foreach table_name in array array['class_dictionaries','dictionary_words','dictionary_word_ratings','dictionary_revisions','dictionary_revision_ratings'] loop
    execute format('drop trigger if exists dictionary_capacity_guard on public.%I',table_name);
    execute format('create trigger dictionary_capacity_guard before insert or update on public.%I for each row execute function public.dictionary_guard_write()',table_name);
  end loop;
end $$;

create or replace function public.dictionary_usage() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('databaseBytes',pg_database_size(current_database()),'writeLimitBytes',write_limit_bytes,
    'writeBlocked',not writes_enabled or pg_database_size(current_database())+65536>=write_limit_bytes)
  from public.dictionary_settings where id;
$$;

-- Free titles replace school/class inputs; legacy columns remain for older clients.
alter table public.class_dictionaries add column if not exists title text
  check(char_length(trim(title)) between 1 and 80);
update public.class_dictionaries set title=concat_ws(' ',school,
  regexp_replace(grade,'\s*학년$','')||'학년',regexp_replace(class_name,'\s*반$','')||'반') where title is null;
alter table public.class_dictionaries alter column title set not null,
  alter column school drop not null,alter column grade drop not null,alter column class_name drop not null;
-- A proposal keeps the nickname chosen at submission, even if later proposals use a different one.
alter table public.dictionary_revisions add column if not exists author_nickname text
  check(char_length(trim(author_nickname)) between 1 and 20);
update public.dictionary_revisions set author_nickname=dictionary_reader.author_name(owner_id) where author_nickname is null;

create or replace view public.dictionary_revision_summary as
select r.id,r.word_id,r.owner_id,r.word,r.meaning,r.reason,r.example,r.selected,r.selected_by,r.selected_at,r.created_at,
  w.class_id,w.word as original_word,w.category,
  coalesce((select avg(rating) from public.dictionary_revision_ratings where revision_id=r.id),0) as average_rating,
  (select count(*)::integer from public.dictionary_revision_ratings where revision_id=r.id) as rating_count,
  (select rating from public.dictionary_revision_ratings where revision_id=r.id and owner_id=auth.uid()) as my_rating,
  r.author_nickname
from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id;
revoke all on public.dictionary_revision_summary from anon,authenticated;

create or replace function public.dictionary_list_classes(p_search text default '',p_offset integer default 0) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('classes',coalesce((select jsonb_agg(to_jsonb(c)) from (
    select d.id,d.title,(select count(*) from public.dictionary_words where class_id=d.id) as word_count
    from public.class_dictionaries d where title ilike '%'||left(p_search,100)||'%'
    order by title,id limit 50 offset greatest(0,least(p_offset,100000))
  ) c),'[]'::jsonb),'total',(select count(*) from public.class_dictionaries where title ilike '%'||left(p_search,100)||'%'));
$$;

create or replace function public.dictionary_create(p_title text,p_id uuid default gen_random_uuid()) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  if not dictionary_reader.can_approve() then raise exception '새 사전은 교사 화면에서 만들어 주세요.'; end if;
  if p_title is null or char_length(trim(p_title)) not between 1 and 80 then raise exception '사전 제목은 1~80자로 입력해 주세요.'; end if;
  insert into public.class_dictionaries(id,title,created_by) values(p_id,trim(p_title),auth.uid()) on conflict(id) do nothing;
  select * into result from public.class_dictionaries where id=p_id and created_by=auth.uid();
  if result.id is null then raise exception '다른 작성자의 사전입니다. 새 사전을 만들어 주세요.'; end if;
  return jsonb_build_object('id',result.id,'title',result.title);
end; $$;

create or replace function public.dictionary_create_class(p_school text,p_grade text,p_class_name text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  -- 이미 있는 학급은 새로 만들지 않고 바로 입장합니다.
  select * into result from public.class_dictionaries where school=trim(p_school) and grade=trim(p_grade) and class_name=trim(p_class_name);
  if result.id is null then
    insert into public.class_dictionaries(school,grade,class_name,title,created_by) values(trim(p_school),trim(p_grade),trim(p_class_name),concat_ws(' ',trim(p_school),trim(p_grade),trim(p_class_name)),auth.uid())
    on conflict(school,grade,class_name) do update set school=excluded.school returning * into result;
  end if;
  return jsonb_build_object('id',result.id,'school',result.school,'grade',result.grade,'class_name',result.class_name);
end; $$;

create table if not exists public.dictionary_student_links (
  class_id uuid primary key references public.class_dictionaries(id) on delete cascade,
  join_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now()
);
create table if not exists public.dictionary_student_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.class_dictionaries(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(user_id,class_id)
);
alter table public.dictionary_student_links enable row level security;
alter table public.dictionary_student_sessions enable row level security;
revoke all on public.dictionary_student_links,public.dictionary_student_sessions from anon,authenticated;
drop trigger if exists dictionary_capacity_guard on public.dictionary_student_links;
create trigger dictionary_capacity_guard before insert or update on public.dictionary_student_links for each row execute function public.dictionary_guard_write();
drop trigger if exists dictionary_capacity_guard on public.dictionary_student_sessions;
create trigger dictionary_capacity_guard before insert or update on public.dictionary_student_sessions for each row execute function public.dictionary_guard_write();

alter table public.dictionary_student_sessions add column if not exists nickname text check(char_length(trim(nickname)) between 1 and 20);
create or replace function dictionary_reader.student_name(p_user_id uuid,p_class_id uuid) returns text
language sql stable security invoker set search_path='' as $$
 select coalesce((select nickname from public.dictionary_student_sessions where user_id=p_user_id and class_id=p_class_id),dictionary_reader.author_name(p_user_id));
$$;
revoke all on function dictionary_reader.student_name(uuid,uuid) from public,anon,authenticated;

create or replace function public.dictionary_enter_student(p_class_id uuid,p_token uuid,p_nickname text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare chosen_name text; room_title text;
begin
 perform public.dictionary_require_user();
 perform pg_advisory_xact_lock(91020261106);
 select d.title into room_title from public.dictionary_student_links l join public.class_dictionaries d on d.id=l.class_id where l.class_id=p_class_id and l.join_token=p_token;
 if room_title is null then raise exception '학생 입장 링크를 확인해 주세요. 교사가 공유한 QR이나 링크로 입장할 수 있어요.'; end if;
 select nickname into chosen_name from public.dictionary_student_sessions where user_id=auth.uid() and nickname is not null order by joined_at,class_id limit 1;
 if chosen_name is null then
   if p_nickname is null then return jsonb_build_object('needsNickname',true,'class',jsonb_build_object('id',p_class_id,'title',room_title)); end if;
   if char_length(trim(p_nickname)) not between 1 and 20 then raise exception '닉네임은 1~20자로 입력해 주세요.'; end if;
   chosen_name=trim(p_nickname);
 end if;
 if not exists(select 1 from public.dictionary_student_sessions where user_id=auth.uid() and class_id=p_class_id and nickname is not null) then
   insert into public.dictionary_student_sessions(user_id,class_id,nickname) values(auth.uid(),p_class_id,chosen_name)
   on conflict(user_id,class_id) do update set nickname=excluded.nickname;
 end if;
 return jsonb_build_object('ready',true,'nickname',chosen_name,'class',jsonb_build_object('id',p_class_id,'title',room_title));
end; $$;
revoke all on function public.dictionary_enter_student(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dictionary_enter_student(uuid,uuid,text) to authenticated;

-- Student enrollment is server-owned. The student's separate browser session cannot approve.
create or replace function dictionary_reader.can_approve() returns boolean
language sql stable security invoker set search_path='' as $$
  select auth.uid() is not null and (public.dictionary_is_admin()
    or not exists(select 1 from public.dictionary_student_sessions where user_id=auth.uid()));
$$;
revoke all on function dictionary_reader.can_approve() from public,anon,authenticated;

create or replace function dictionary_reader.require_contributor(p_class_id uuid) returns void
language plpgsql stable security invoker set search_path='' as $$
begin
  if not dictionary_reader.can_approve() and not exists(select 1 from public.dictionary_student_sessions where user_id=auth.uid() and class_id=p_class_id)
    then raise exception '이 사전의 학생 입장 링크로 먼저 입장해 주세요.'; end if;
end; $$;
revoke all on function dictionary_reader.require_contributor(uuid) from public,anon,authenticated;

create or replace function public.dictionary_student_link(p_class_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dictionary_student_links%rowtype;
begin
  perform public.dictionary_require_user();
  if not dictionary_reader.can_approve() then raise exception '학생 입장 링크는 교사 화면에서 확인해 주세요.'; end if;
  if not exists(select 1 from public.class_dictionaries where id=p_class_id) then raise exception '삭제되었거나 없는 사전입니다.'; end if;
  select * into result from public.dictionary_student_links where class_id=p_class_id;
  if result.class_id is null then
    insert into public.dictionary_student_links(class_id) values(p_class_id) on conflict(class_id) do nothing;
    select * into result from public.dictionary_student_links where class_id=p_class_id;
  end if;
  return jsonb_build_object('class_id',result.class_id,'token',result.join_token);
end; $$;

create or replace function public.dictionary_join_student(p_class_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.dictionary_require_user();
  if not exists(select 1 from public.dictionary_student_links where class_id=p_class_id and join_token=p_token) then raise exception '학생 입장 링크를 확인해 주세요. 교사가 공유한 QR이나 링크로 입장할 수 있어요.'; end if;
  if not exists(select 1 from public.dictionary_student_sessions where user_id=auth.uid() and class_id=p_class_id) then
    insert into public.dictionary_student_sessions(user_id,class_id) values(auth.uid(),p_class_id) on conflict do nothing;
  end if;
  return true;
end; $$;

create or replace function dictionary_reader.require_admin() returns void
language plpgsql stable security invoker set search_path='' as $$
begin
  if not public.dictionary_is_admin() then raise exception '관리자 로그인이 필요합니다.'; end if;
end; $$;
revoke all on function dictionary_reader.require_admin() from public,anon,authenticated;

create or replace function public.dictionary_admin_get_item(p_kind text,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  perform dictionary_reader.require_admin();
  if p_kind='word' then
    select jsonb_build_object('id',id,'word',word,'category',category,'meaning',meaning,'reason',reason,
      'revision_count',(select count(*) from public.dictionary_revisions where word_id=p_id)) into result from public.dictionary_words where id=p_id;
  elsif p_kind='revision' then
    select jsonb_build_object('id',id,'word',word,'meaning',meaning,'reason',reason,'example',example,
      'nickname',coalesce(author_nickname,dictionary_reader.author_name(owner_id))) into result from public.dictionary_revisions where id=p_id;
  else raise exception '지원하지 않는 항목입니다.'; end if;
  if result is null then raise exception '삭제되었거나 없는 단어입니다.'; end if;
  return result;
end; $$;

create or replace function public.dictionary_admin_update_word(p_id uuid,p_word text,p_category text,p_meaning text,p_reason text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform dictionary_reader.require_admin();
  update public.dictionary_words set word=trim(p_word),category=p_category,meaning=trim(p_meaning),reason=trim(p_reason) where id=p_id;
  if not found then raise exception '삭제되었거나 없는 표현입니다.'; end if;
  return true;
exception when unique_violation then raise exception '이 작성자가 이미 등록한 같은 표현이 있습니다.';
end; $$;

create or replace function public.dictionary_admin_update_revision(p_id uuid,p_word text,p_meaning text,p_reason text,p_example text,p_nickname text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform dictionary_reader.require_admin();
  if p_nickname is null or char_length(trim(p_nickname)) not between 1 and 20 then raise exception '닉네임은 1~20자로 입력해 주세요.'; end if;
  if exists(select 1 from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id where r.id=p_id and lower(trim(w.word))=lower(trim(p_word))) then raise exception '원래 표현과 다른 순화어를 입력해 주세요.'; end if;
  update public.dictionary_revisions set word=trim(p_word),meaning=trim(p_meaning),reason=trim(p_reason),example=trim(p_example),author_nickname=trim(p_nickname) where id=p_id;
  if not found then raise exception '삭제되었거나 없는 순화어입니다.'; end if;
  return true;
end; $$;

create or replace function public.dictionary_admin_delete_item(p_kind text,p_id uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform dictionary_reader.require_admin();
  if p_kind='word' then delete from public.dictionary_words where id=p_id;
  elsif p_kind='revision' then delete from public.dictionary_revisions where id=p_id;
  else raise exception '지원하지 않는 항목입니다.'; end if;
  if not found then raise exception '이미 삭제되었거나 없는 단어입니다.'; end if;
  return true;
end; $$;

revoke all on function public.dictionary_student_link(uuid),public.dictionary_join_student(uuid,uuid),
  public.dictionary_admin_get_item(text,uuid),public.dictionary_admin_update_word(uuid,text,text,text,text),
  public.dictionary_admin_update_revision(uuid,text,text,text,text,text),public.dictionary_admin_delete_item(text,uuid) from public,anon,authenticated;
grant execute on function public.dictionary_student_link(uuid),public.dictionary_join_student(uuid,uuid),
  public.dictionary_admin_get_item(text,uuid),public.dictionary_admin_update_word(uuid,text,text,text,text),
  public.dictionary_admin_update_revision(uuid,text,text,text,text,text),public.dictionary_admin_delete_item(text,uuid) to authenticated;


create or replace function dictionary_reader.word_groups(p_class_id uuid,p_mode text,p_search text,p_offset integer) returns jsonb
language sql stable security invoker set search_path='' as $$
  with originals as materialized (
    select w.*,lower(trim(w.word)) original_key from public.dictionary_words w where w.class_id=p_class_id
  ), ranked as materialized (
    select r.*,lower(trim(r.original_word)) original_key,
      max(r.average_rating) filter(where r.rating_count>0) over(partition by lower(trim(r.original_word))) highest_rating
    from public.dictionary_revision_summary r where r.class_id=p_class_id
  ), candidates as materialized (
    select * from ranked where p_mode='refine'
      or (p_mode='approval_approved' and selected)
      or (p_mode='approval_pending' and not selected and rating_count>0 and average_rating=highest_rating)
  ), grouped as (
    select original_key,(array_agg(id order by created_at,id))[1] id,
      jsonb_agg(jsonb_build_object('id',id,'word',word,'category',category,'meaning',meaning,'reason',reason,
        'author_name',dictionary_reader.student_name(owner_id,p_class_id),'mine',owner_id=auth.uid()) order by created_at,id) originals,
      count(*)::integer original_count,
      (select count(*) from public.dictionary_word_ratings v join originals o on o.id=v.word_id where o.original_key=w.original_key) rating_count
    from originals w group by original_key
  ), matching as (
    select * from grouped g where (p_mode='refine' or exists(select 1 from candidates c where c.original_key=g.original_key))
      and (exists(select 1 from originals o where o.original_key=g.original_key and concat_ws(' ',o.word,o.meaning) ilike '%'||left(coalesce(p_search,''),100)||'%')
        or exists(select 1 from candidates c where c.original_key=g.original_key and concat_ws(' ',c.word,c.meaning) ilike '%'||left(coalesce(p_search,''),100)||'%'))
  ), page as (
    select * from matching order by original_key,id limit 25 offset greatest(0,least(coalesce(p_offset,0),100000))
  )
  select jsonb_build_object('total',(select count(*) from matching),
    'pendingCount',(select count(*) from ranked where not selected and rating_count>0 and average_rating=highest_rating),
    'approvedCount',(select count(*) from ranked where selected),'published','[]'::jsonb,
    'words',coalesce((select jsonb_agg(jsonb_build_object(
      'id',g.id,'word',g.originals->0->>'word','category',g.originals->0->>'category',
      'meaning',g.originals->0->>'meaning','reason',g.originals->0->>'reason',
      'author_name',g.originals->0->>'author_name','originals',g.originals,'original_count',g.original_count,'rating_count',g.rating_count,
      'revisions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'word',r.word,'meaning',r.meaning,'reason',r.reason,'example',r.example,
        'author_name',coalesce(r.author_nickname,dictionary_reader.author_name(r.owner_id)),'mine',r.owner_id=auth.uid(),
        'average_rating',r.average_rating,'rating_count',r.rating_count,'my_rating',r.my_rating,'selected',r.selected,'published',r.selected,
        'top_rated',r.rating_count>0 and r.average_rating=r.highest_rating)
        order by r.average_rating desc,r.rating_count desc,r.created_at,r.id) from candidates r where r.original_key=g.original_key),'[]'::jsonb)
      ) order by g.original_key,g.id) from page g),'[]'::jsonb));
$$;
revoke all on function dictionary_reader.word_groups(uuid,text,text,integer) from public,anon,authenticated;

create or replace function dictionary_reader.activity(p_class_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
   'students',(select count(*) from public.dictionary_student_sessions where class_id=p_class_id),
   'wordAuthors',(select count(distinct owner_id) from public.dictionary_words where class_id=p_class_id),
   'revisionAuthors',(select count(distinct r.owner_id) from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id where w.class_id=p_class_id),
   'wordRatings',(select count(*) from public.dictionary_word_ratings v join public.dictionary_words w on w.id=v.word_id where w.class_id=p_class_id),
   'revisionRatings',(select count(*) from public.dictionary_revision_ratings v join public.dictionary_revision_summary r on r.id=v.revision_id where r.class_id=p_class_id),
   'raters',(select count(*) from (
     select v.owner_id from public.dictionary_word_ratings v join public.dictionary_words w on w.id=v.word_id where w.class_id=p_class_id
     union select v.owner_id from public.dictionary_revision_ratings v join public.dictionary_revision_summary r on r.id=v.revision_id where r.class_id=p_class_id
   ) voters));
$$;
revoke all on function dictionary_reader.activity(uuid) from public,anon,authenticated;

create or replace function dictionary_reader.notify_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare room_id uuid; item jsonb; public_change boolean:=false;
begin
  if tg_op='DELETE' then item=to_jsonb(old); else item=to_jsonb(new); end if;
  if tg_table_name='class_dictionaries' then room_id=(item->>'id')::uuid;public_change=true;
  elsif tg_table_name in ('dictionary_words','dictionary_student_sessions') then room_id=(item->>'class_id')::uuid;public_change=tg_table_name='dictionary_words';
  elsif tg_table_name in ('dictionary_revisions','dictionary_word_ratings') then
    select class_id into room_id from public.dictionary_words where id=(item->>'word_id')::uuid;
    if tg_table_name='dictionary_revisions' then public_change=coalesce((item->>'selected')::boolean,false) or (tg_op='UPDATE' and old.selected); end if;
  elsif tg_table_name='dictionary_revision_ratings' then
    select class_id,selected into room_id,public_change from public.dictionary_revision_summary where id=(item->>'revision_id')::uuid;
  end if;
  if room_id is not null then
    perform realtime.send(jsonb_build_object('kind',tg_table_name),'changed','dictionary:'||room_id::text,false);
    if public_change then perform realtime.send(jsonb_build_object('kind',tg_table_name),'changed','dictionary:public',false); end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function dictionary_reader.notify_change() from public,anon,authenticated;
do $$ declare table_name text; begin
  foreach table_name in array array['class_dictionaries','dictionary_words','dictionary_word_ratings','dictionary_revisions','dictionary_revision_ratings','dictionary_student_sessions'] loop
    execute format('drop trigger if exists dictionary_live_update on public.%I',table_name);
    execute format('create trigger dictionary_live_update after insert or update or delete on public.%I for each row execute function dictionary_reader.notify_change()',table_name);
  end loop;
end; $$;

create or replace function public.dictionary_get_class(p_class_id uuid,p_view text default 'words',p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; room public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  select * into room from public.class_dictionaries where id=p_class_id;
  if room.id is null then raise exception '삭제되었거나 없는 사전입니다. 사전 목록으로 돌아가 주세요.'; end if;

  perform dictionary_reader.require_contributor(p_class_id);
  if p_view='student_collect' then
    return jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),'isAdmin',false,'canApprove',false,
      'usage',public.dictionary_usage(),'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
      'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
      'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected),
      'total',0,'words','[]'::jsonb,'published','[]'::jsonb);
  end if;
  if p_view in ('refine','approval_pending','approval_approved') then
    result=jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
      'isAdmin',public.dictionary_is_admin(),'canApprove',dictionary_reader.can_approve(),'usage',public.dictionary_usage(),'activity',dictionary_reader.activity(p_class_id),
      'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
      'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
      'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected));
    if p_view in ('approval_pending','approval_approved') and not dictionary_reader.can_approve() then
      return result||jsonb_build_object('approvalLocked',true,'total',0,'words','[]'::jsonb,'published','[]'::jsonb);
    end if;
    return result||dictionary_reader.word_groups(p_class_id,p_view,p_search,p_offset);
  end if;
  select jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
    'isAdmin',public.dictionary_is_admin(),'canApprove',dictionary_reader.can_approve(),'usage',public.dictionary_usage(),'activity',dictionary_reader.activity(p_class_id),
    'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
    'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
    'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected),
    'total',case when p_view='published' then (select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected and concat_ws(' ',word,original_word,meaning) ilike '%'||left(p_search,100)||'%')
      else (select count(*) from public.dictionary_words where class_id=p_class_id and concat_ws(' ',word,meaning) ilike '%'||left(p_search,100)||'%') end,
    'words',case when p_view='published' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(item)) from (
      select w.id,w.word,w.category,w.meaning,w.reason,dictionary_reader.student_name(w.owner_id,w.class_id) as author_name,(w.owner_id=auth.uid()) as mine,
        coalesce((select avg(rating)::numeric(3,2) from public.dictionary_word_ratings where word_id=w.id),0) as average_rating,
        (select count(*) from public.dictionary_word_ratings where word_id=w.id) as rating_count,
        (select rating from public.dictionary_word_ratings where word_id=w.id and owner_id=auth.uid()) as my_rating,
        case when p_view='rate' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'word',r.word,'meaning',r.meaning,'reason',r.reason,'example',r.example,'author_name',coalesce(r.author_nickname,dictionary_reader.author_name(r.owner_id)),
          'mine',r.owner_id=auth.uid(),'average_rating',r.average_rating,'rating_count',r.rating_count,'my_rating',r.my_rating,
          'selected',r.selected,'published',r.selected) order by r.average_rating desc,r.created_at)
          from public.dictionary_revision_summary r where r.word_id=w.id),'[]'::jsonb) end as revisions
      from public.dictionary_words w where w.class_id=p_class_id and concat_ws(' ',w.word,w.meaning) ilike '%'||left(p_search,100)||'%'
      order by w.created_at desc,w.id limit 25 offset greatest(0,least(p_offset,100000))
    ) item),'[]'::jsonb) end,
    'published',case when p_view<>'published' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(item)) from (
      select id,word,original_word,category,meaning,example,average_rating,rating_count,coalesce(author_nickname,dictionary_reader.author_name(owner_id)) as author_name from public.dictionary_revision_summary
      where class_id=p_class_id and selected and concat_ws(' ',word,original_word,meaning) ilike '%'||left(p_search,100)||'%'
      order by word,id limit 25 offset greatest(0,least(p_offset,100000))
    ) item),'[]'::jsonb) end) into result;
  return result;
end; $$;

create or replace function public.dictionary_add_word(p_id uuid,p_class_id uuid,p_word text,p_category text,p_meaning text,p_reason text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.dictionary_require_user();
  perform dictionary_reader.require_contributor(p_class_id);
  if exists(select 1 from public.dictionary_words where id=p_id and owner_id=auth.uid() and class_id=p_class_id) then return p_id; end if;
  insert into public.dictionary_words(id,class_id,owner_id,word,category,meaning,reason)
  values(p_id,p_class_id,auth.uid(),trim(p_word),p_category,trim(p_meaning),trim(p_reason));
  return p_id;
exception when unique_violation then raise exception '내가 이 사전에 이미 등록한 표현입니다. 기존 내 표현을 확인해 주세요.';
end; $$;

create or replace function public.dictionary_rate_word(p_word_id uuid,p_rating integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare creator uuid; room_id uuid;
begin
  perform public.dictionary_require_user();
  select owner_id,class_id into creator,room_id from public.dictionary_words where id=p_word_id;
  if creator is null then raise exception '평가할 표현이 없습니다.'; end if;
  perform dictionary_reader.require_contributor(room_id);
  if creator=auth.uid() then raise exception '내가 등록한 표현은 다른 친구가 평가합니다.'; end if;
  insert into public.dictionary_word_ratings(word_id,owner_id,rating) values(p_word_id,auth.uid(),p_rating)
  on conflict(word_id,owner_id) do update set rating=excluded.rating;
  return true;
end; $$;

create or replace function public.dictionary_add_revision(p_id uuid,p_word_id uuid,p_word text,p_meaning text,p_reason text,p_example text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return public.dictionary_propose_revision(p_id,p_word_id,p_word,p_meaning,p_reason,p_example,dictionary_reader.author_name(auth.uid()));
end; $$;

create or replace function public.dictionary_propose_revision(p_id uuid,p_word_id uuid,p_word text,p_meaning text,p_reason text,p_example text,p_nickname text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare original public.dictionary_words%rowtype;
begin
  perform public.dictionary_require_user();
  -- Match the existing write guard's lock so duplicate checks and inserts are atomic.
  perform pg_advisory_xact_lock(91020261106);
  if exists(select 1 from public.dictionary_revisions where id=p_id and owner_id=auth.uid() and word_id=p_word_id) then return p_id; end if;
  select * into original from public.dictionary_words where id=p_word_id;
  if original.id is null then raise exception '원래 표현을 찾을 수 없습니다.'; end if;
  perform dictionary_reader.require_contributor(original.class_id);
  if exists(select 1 from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id
    where w.class_id=original.class_id and lower(trim(w.word))=lower(trim(original.word)) and r.owner_id=auth.uid())
    then raise exception '이 표현에 이미 순화어를 제안했습니다.'; end if;
  if not exists(select 1 from public.dictionary_word_ratings v join public.dictionary_words w on w.id=v.word_id
    where w.class_id=original.class_id and lower(trim(w.word))=lower(trim(original.word)))
    then raise exception '원래 표현의 상호 평가가 1개 이상 모인 뒤 순화어를 제안할 수 있습니다.'; end if;
  if lower(trim(original.word))=lower(trim(p_word)) then raise exception '원래 표현과 다른 순화어를 제안해 주세요.'; end if;
  p_nickname=coalesce((select nickname from public.dictionary_student_sessions where user_id=auth.uid() and class_id=original.class_id),p_nickname);
  if p_nickname is null or char_length(trim(p_nickname)) not between 1 and 20 then raise exception '닉네임은 1~20자로 입력해 주세요.'; end if;
  insert into public.dictionary_revisions(id,word_id,owner_id,word,meaning,reason,example,author_nickname)
  values(p_id,p_word_id,auth.uid(),trim(p_word),trim(p_meaning),trim(p_reason),trim(p_example),trim(p_nickname));
  return p_id;
exception when unique_violation then raise exception '이 표현에 이미 순화어를 제안했습니다.';
end; $$;

create or replace function public.dictionary_rate_revision(p_revision_id uuid,p_rating integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare creator uuid; room_id uuid;
begin
  perform public.dictionary_require_user();
  select r.owner_id,w.class_id into creator,room_id from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id where r.id=p_revision_id;
  if creator is null then raise exception '평가할 순화어가 없습니다.'; end if;
  perform dictionary_reader.require_contributor(room_id);
  if creator=auth.uid() then raise exception '내가 제안한 순화어는 다른 친구가 평가합니다.'; end if;
  insert into public.dictionary_revision_ratings(revision_id,owner_id,rating) values(p_revision_id,auth.uid(),p_rating)
  on conflict(revision_id,owner_id) do update set rating=excluded.rating;
  return true;
end; $$;

create or replace function public.dictionary_select_revision(p_revision_id uuid,p_selected boolean) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare candidate public.dictionary_revision_summary%rowtype;
begin
  perform public.dictionary_require_user();
  if not dictionary_reader.can_approve() then raise exception '학생 전용 접속에서는 승인할 수 없습니다. 교사 화면에서 승인해 주세요.'; end if;
  if p_selected is null then raise exception '승인 여부를 선택해 주세요.'; end if;
  perform pg_advisory_xact_lock(91020261106);
  select * into candidate from public.dictionary_revision_summary where id=p_revision_id;
  if candidate.id is null then raise exception '순화어를 찾을 수 없습니다.'; end if;
  if candidate.selected=p_selected then return true; end if;
  if p_selected and candidate.rating_count=0 then raise exception '순화어 별점 평가가 1개 이상 필요합니다.'; end if;
  if p_selected and exists(select 1 from public.dictionary_revision_summary r where r.class_id=candidate.class_id
    and lower(trim(r.original_word))=lower(trim(candidate.original_word)) and r.rating_count>0 and r.average_rating>candidate.average_rating)
    then raise exception '최고 평점 후보가 바뀌었습니다. 새로고침 후 승인해 주세요.'; end if;
  update public.dictionary_revisions set selected=p_selected,selected_by=case when p_selected then auth.uid() end,
    selected_at=case when p_selected then now() end where id=p_revision_id;
  return true;
end; $$;

create or replace function public.dictionary_delete_class(p_class_id uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.dictionary_is_admin() then raise exception '관리자만 사전을 삭제할 수 있습니다.'; end if;
  delete from public.class_dictionaries where id=p_class_id;
  if not found then raise exception '이미 삭제되었거나 없는 사전입니다.'; end if;
  return true;
end; $$;

-- 공개 실행 권한을 명시적으로 제한합니다.
revoke all on function public.dictionary_require_user(),public.dictionary_guard_write() from public,anon,authenticated;
revoke all on function public.dictionary_is_admin(),public.dictionary_admin_login(text),public.dictionary_admin_logout(),
 public.dictionary_create(text,uuid),public.dictionary_propose_revision(uuid,uuid,text,text,text,text,text),
 public.dictionary_usage(),public.dictionary_list_classes(text,integer),public.dictionary_create_class(text,text,text),
 public.dictionary_get_class(uuid,text,text,integer),public.dictionary_add_word(uuid,uuid,text,text,text,text),
 public.dictionary_rate_word(uuid,integer),public.dictionary_add_revision(uuid,uuid,text,text,text,text),
 public.dictionary_rate_revision(uuid,integer),public.dictionary_select_revision(uuid,boolean),public.dictionary_delete_class(uuid)
 from public,anon,authenticated;
grant execute on function public.dictionary_list_classes(text,integer) to anon,authenticated;
grant execute on function public.dictionary_is_admin(),public.dictionary_admin_login(text),public.dictionary_admin_logout(),
 public.dictionary_usage(),public.dictionary_create(text,uuid),public.dictionary_propose_revision(uuid,uuid,text,text,text,text,text),public.dictionary_create_class(text,text,text),public.dictionary_get_class(uuid,text,text,integer),
 public.dictionary_add_word(uuid,uuid,text,text,text,text),public.dictionary_rate_word(uuid,integer),
 public.dictionary_add_revision(uuid,uuid,text,text,text,text),public.dictionary_rate_revision(uuid,integer),
 public.dictionary_select_revision(uuid,boolean),public.dictionary_delete_class(uuid) to authenticated;
notify pgrst, 'reload schema';

create schema if not exists dictionary_reader;
revoke all on schema dictionary_reader from public;
grant usage on schema dictionary_reader to anon,authenticated;

-- Elevated reads stay outside the exposed API schema; only final dictionary fields are returned.
create or replace function dictionary_reader.browse_published(
  p_view text default 'words',p_search text default '',p_class_id uuid default null,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; search_pattern text := '%'||left(coalesce(p_search,''),100)||'%';
begin
  if p_view not in ('words','classes') or p_view is null then raise exception '지원하지 않는 사전 보기입니다.'; end if;
  with published as materialized (
    select r.id,r.word,r.original_word,r.category,r.meaning,r.example,coalesce(r.author_nickname,dictionary_reader.author_name(r.owner_id)) as author_name,
      round(r.average_rating,2) average_rating,r.rating_count,d.id class_id,d.title
    from public.dictionary_revision_summary r join public.class_dictionaries d on d.id=r.class_id
    where r.selected
  ), filtered_words as (
    select * from published
    where (p_class_id is null or class_id=p_class_id)
      and concat_ws(' ',word,original_word,meaning) ilike search_pattern
  ), published_classes as (
    select class_id id,title,count(*)::integer published_count
    from published group by class_id,title
  ), filtered_classes as (
    select * from published_classes
    where title ilike search_pattern
  )
  select jsonb_build_object(
    'publishedCount',(select count(*) from published),'classCount',(select count(*) from published_classes),
    'class',(select to_jsonb(c) from published_classes c where c.id=p_class_id),
    'total',case when p_view='classes' then (select count(*) from filtered_classes) else (select count(*) from filtered_words) end,
    'entries',case when p_view='words' then coalesce((select jsonb_agg(to_jsonb(w) order by lower(w.word),w.original_word,w.title,w.id)
      from (select * from filtered_words order by lower(word),original_word,title,id limit 24 offset greatest(0,least(coalesce(p_offset,0),100000))) w),'[]'::jsonb) else '[]'::jsonb end,
    'classes',case when p_view='classes' then coalesce((select jsonb_agg(to_jsonb(c) order by c.title,c.id)
      from (select * from filtered_classes order by title,id limit 24 offset greatest(0,least(coalesce(p_offset,0),100000))) c),'[]'::jsonb) else '[]'::jsonb end
  ) into result;
  return result;
end; $$;
revoke all on function dictionary_reader.browse_published(text,text,uuid,integer) from public,anon,authenticated;
grant execute on function dictionary_reader.browse_published(text,text,uuid,integer) to anon,authenticated;

create or replace function public.dictionary_browse(p_view text default 'words',p_search text default '',p_class_id uuid default null,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
  select dictionary_reader.browse_published(p_view,p_search,p_class_id,p_offset);
$$;
revoke all on function public.dictionary_browse(text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.dictionary_browse(text,text,uuid,integer) to anon,authenticated;
notify pgrst, 'reload schema';

commit;
