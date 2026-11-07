-- Group duplicate originals, rank proposals per expression, and publish by teacher approval.
-- Existing submissions, ratings, nicknames and approvals are preserved.
begin;
create index if not exists dictionary_words_group_idx on public.dictionary_words(class_id,lower(trim(word)));

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
        'author_name',dictionary_reader.author_name(owner_id),'mine',owner_id=auth.uid()) order by created_at,id) originals,
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
  if exists(select 1 from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id
    where w.class_id=original.class_id and lower(trim(w.word))=lower(trim(original.word)) and r.owner_id=auth.uid())
    then raise exception '이 표현에 이미 순화어를 제안했습니다.'; end if;
  if not exists(select 1 from public.dictionary_word_ratings v join public.dictionary_words w on w.id=v.word_id
    where w.class_id=original.class_id and lower(trim(w.word))=lower(trim(original.word)))
    then raise exception '원래 표현의 상호 평가가 1개 이상 모인 뒤 순화어를 제안할 수 있습니다.'; end if;
  if lower(trim(original.word))=lower(trim(p_word)) then raise exception '원래 표현과 다른 순화어를 제안해 주세요.'; end if;
  if p_nickname is null or char_length(trim(p_nickname)) not between 1 and 20 then raise exception '닉네임은 1~20자로 입력해 주세요.'; end if;
  insert into public.dictionary_revisions(id,word_id,owner_id,word,meaning,reason,example,author_nickname)
  values(p_id,p_word_id,auth.uid(),trim(p_word),trim(p_meaning),trim(p_reason),trim(p_example),trim(p_nickname));
  return p_id;
exception when unique_violation then raise exception '이 표현에 이미 순화어를 제안했습니다.';
end; $$;

-- Cached clients retain the same validation and nickname snapshot behavior.
create or replace function public.dictionary_add_revision(p_id uuid,p_word_id uuid,p_word text,p_meaning text,p_reason text,p_example text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return public.dictionary_propose_revision(p_id,p_word_id,p_word,p_meaning,p_reason,p_example,dictionary_reader.author_name(auth.uid()));
end; $$;

create or replace function public.dictionary_select_revision(p_revision_id uuid,p_selected boolean) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare candidate public.dictionary_revision_summary%rowtype;
begin
  if not public.dictionary_is_admin() then raise exception '교사·관리자 인증이 필요합니다.'; end if;
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

-- Reader definitions are kept in sync with open-dictionary.sql below.

create or replace function public.dictionary_get_class(p_class_id uuid,p_view text default 'words',p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; room public.class_dictionaries%rowtype;
begin
  perform public.dictionary_require_user();
  select * into room from public.class_dictionaries where id=p_class_id;
  if room.id is null then raise exception '삭제되었거나 없는 사전입니다. 사전 목록으로 돌아가 주세요.'; end if;

  if p_view in ('refine','approval_pending','approval_approved') then
    result=jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
      'isAdmin',public.dictionary_is_admin(),'usage',public.dictionary_usage(),
      'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
      'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
      'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected));
    if p_view in ('approval_pending','approval_approved') and not public.dictionary_is_admin() then
      return result||jsonb_build_object('approvalLocked',true,'total',0,'words','[]'::jsonb,'published','[]'::jsonb);
    end if;
    return result||dictionary_reader.word_groups(p_class_id,p_view,p_search,p_offset);
  end if;
  select jsonb_build_object('class',jsonb_build_object('id',room.id,'title',room.title),
    'isAdmin',public.dictionary_is_admin(),'usage',public.dictionary_usage(),
    'wordCount',(select count(*) from public.dictionary_words where class_id=p_class_id),
    'revisionCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id),
    'publishedCount',(select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected),
    'total',case when p_view='published' then (select count(*) from public.dictionary_revision_summary where class_id=p_class_id and selected and concat_ws(' ',word,original_word,meaning) ilike '%'||left(p_search,100)||'%')
      else (select count(*) from public.dictionary_words where class_id=p_class_id and concat_ws(' ',word,meaning) ilike '%'||left(p_search,100)||'%') end,
    'words',case when p_view='published' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(item)) from (
      select w.id,w.word,w.category,w.meaning,w.reason,dictionary_reader.author_name(w.owner_id) as author_name,(w.owner_id=auth.uid()) as mine,
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

notify pgrst, 'reload schema';
commit;
