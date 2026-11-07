-- Broadcast only change notifications. Content is always read through restricted RPCs.
begin;
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
-- Updated reader follows.

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
notify pgrst, 'reload schema';
commit;
