-- 기존 자료와 권한을 유지하고 읽기 응답에 익명 닉네임을 추가합니다.
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

create or replace function public.dictionary_get_class(p_class_id uuid,p_view text default 'words',p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; room public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  select * into room from public.class_dictionaries where id=p_class_id;
  if room.id is null then raise exception '삭제되었거나 없는 학급입니다. 학급 목록으로 돌아가 주세요.'; end if;
  select jsonb_build_object('class',jsonb_build_object('id',room.id,'school',room.school,'grade',room.grade,'class_name',room.class_name),
    'isAdmin',public.dictionary_is_admin(),'usage',public.dictionary_usage(),
    'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
    'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
    'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected and average_rating>=4 and rating_count>0),
    'total',case when p_view='published' then (select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected and average_rating>=4 and rating_count>0 and concat_ws(' ',word,original_word,meaning) ilike '%'||left(p_search,100)||'%')
      else (select count(*) from public.dictionary_words where class_id=p_class_id and concat_ws(' ',word,meaning) ilike '%'||left(p_search,100)||'%') end,
    'words',case when p_view='published' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(item)) from (
      select w.id,w.word,w.category,w.meaning,w.reason,dictionary_reader.author_name(w.owner_id) as author_name,(w.owner_id=auth.uid()) as mine,
        coalesce((select avg(rating)::numeric(3,2) from public.dictionary_word_ratings where word_id=w.id),0) as average_rating,
        (select count(*) from public.dictionary_word_ratings where word_id=w.id) as rating_count,
        (select rating from public.dictionary_word_ratings where word_id=w.id and owner_id=auth.uid()) as my_rating,
        coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'word',r.word,'meaning',r.meaning,'reason',r.reason,'example',r.example,'author_name',dictionary_reader.author_name(r.owner_id),
          'mine',r.owner_id=auth.uid(),'average_rating',r.average_rating,'rating_count',r.rating_count,'my_rating',r.my_rating,
          'selected',r.selected,'published',r.selected and r.average_rating>=4 and r.rating_count>0) order by r.average_rating desc,r.created_at)
          from public.dictionary_revision_summary r where r.word_id=w.id),'[]'::jsonb) as revisions
      from public.dictionary_words w where w.class_id=p_class_id and concat_ws(' ',w.word,w.meaning) ilike '%'||left(p_search,100)||'%'
      order by w.created_at desc,w.id limit 25 offset greatest(0,least(p_offset,100000))
    ) item),'[]'::jsonb) end,
    'published',case when p_view<>'published' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(item)) from (
      select id,word,original_word,category,meaning,example,average_rating,rating_count,dictionary_reader.author_name(owner_id) as author_name from public.dictionary_revision_summary
      where class_id=p_class_id and selected and average_rating>=4 and rating_count>0 and concat_ws(' ',word,original_word,meaning) ilike '%'||left(p_search,100)||'%'
      order by word,id limit 25 offset greatest(0,least(p_offset,100000))
    ) item),'[]'::jsonb) end) into result;
  return result;
end; $$;
create or replace function dictionary_reader.browse_published(
  p_view text default 'words',p_search text default '',p_class_id uuid default null,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; search_pattern text := '%'||left(coalesce(p_search,''),100)||'%';
begin
  if p_view not in ('words','classes') or p_view is null then raise exception '지원하지 않는 사전 보기입니다.'; end if;
  with published as materialized (
    select r.id,r.word,r.original_word,r.category,r.meaning,r.example,dictionary_reader.author_name(r.owner_id) as author_name,
      round(r.average_rating,2) average_rating,r.rating_count,d.id class_id,d.school,d.grade,d.class_name
    from public.dictionary_revision_summary r join public.class_dictionaries d on d.id=r.class_id
    where r.selected and r.average_rating>=4 and r.rating_count>0
  ), filtered_words as (
    select * from published
    where (p_class_id is null or class_id=p_class_id)
      and concat_ws(' ',word,original_word,meaning) ilike search_pattern
  ), published_classes as (
    select class_id id,school,grade,class_name,count(*)::integer published_count
    from published group by class_id,school,grade,class_name
  ), filtered_classes as (
    select * from published_classes
    where concat_ws(' ',school,regexp_replace(grade,'\s*학년$','')||'학년',regexp_replace(class_name,'\s*반$','')||'반') ilike search_pattern
  )
  select jsonb_build_object(
    'publishedCount',(select count(*) from published),'classCount',(select count(*) from published_classes),
    'class',(select to_jsonb(c) from published_classes c where c.id=p_class_id),
    'total',case when p_view='classes' then (select count(*) from filtered_classes) else (select count(*) from filtered_words) end,
    'entries',case when p_view='words' then coalesce((select jsonb_agg(to_jsonb(w) order by lower(w.word),w.original_word,w.school,w.grade,w.class_name,w.id)
      from (select * from filtered_words order by lower(word),original_word,school,grade,class_name,id limit 24 offset greatest(0,least(coalesce(p_offset,0),100000))) w),'[]'::jsonb) else '[]'::jsonb end,
    'classes',case when p_view='classes' then coalesce((select jsonb_agg(to_jsonb(c) order by c.school,c.grade,c.class_name,c.id)
      from (select * from filtered_classes order by school,grade,class_name,id limit 24 offset greatest(0,least(coalesce(p_offset,0),100000))) c),'[]'::jsonb) else '[]'::jsonb end
  ) into result;
  return result;
end; $$;
notify pgrst, 'reload schema';
commit;
