-- Student links, password-free teacher approval, and password-protected content management.
-- Run after the free-title/approval schema. Existing content and ratings are preserved.
begin;
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

-- Updated reader/approval/create definitions follow.

create or replace function public.dictionary_get_class(p_class_id uuid,p_view text default 'words',p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; room public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  select * into room from public.class_dictionaries where id=p_class_id;
  if room.id is null then raise exception '삭제되었거나 없는 사전입니다. 사전 목록으로 돌아가 주세요.'; end if;

  perform dictionary_reader.require_contributor(p_class_id);
  if p_view in ('refine','approval_pending','approval_approved') then
    result=jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
      'isAdmin',public.dictionary_is_admin(),'canApprove',dictionary_reader.can_approve(),'usage',public.dictionary_usage(),
      'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
      'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
      'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected));
    if p_view in ('approval_pending','approval_approved') and not dictionary_reader.can_approve() then
      return result||jsonb_build_object('approvalLocked',true,'total',0,'words','[]'::jsonb,'published','[]'::jsonb);
    end if;
    return result||dictionary_reader.word_groups(p_class_id,p_view,p_search,p_offset);
  end if;
  select jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
    'isAdmin',public.dictionary_is_admin(),'canApprove',dictionary_reader.can_approve(),'usage',public.dictionary_usage(),
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
        coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'word',r.word,'meaning',r.meaning,'reason',r.reason,'example',r.example,'author_name',coalesce(r.author_nickname,dictionary_reader.author_name(r.owner_id)),
          'mine',r.owner_id=auth.uid(),'average_rating',r.average_rating,'rating_count',r.rating_count,'my_rating',r.my_rating,
          'selected',r.selected,'published',r.selected) order by r.average_rating desc,r.created_at)
          from public.dictionary_revision_summary r where r.word_id=w.id),'[]'::jsonb) as revisions
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

notify pgrst, 'reload schema';
commit;
