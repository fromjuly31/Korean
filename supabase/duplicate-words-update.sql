-- 기존 학급 자료를 보존하면서 서로 다른 학생의 같은 표현 등록을 허용합니다.
begin;
drop index if exists public.dictionary_words_unique;
create unique index if not exists dictionary_words_owner_unique
  on public.dictionary_words(class_id, owner_id, lower(trim(word)));

create or replace function public.dictionary_add_word(p_id uuid,p_class_id uuid,p_word text,p_category text,p_meaning text,p_reason text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.dictionary_require_user();
  if exists(select 1 from public.dictionary_words where id=p_id and owner_id=auth.uid() and class_id=p_class_id) then return p_id; end if;
  insert into public.dictionary_words(id,class_id,owner_id,word,category,meaning,reason)
  values(p_id,p_class_id,auth.uid(),trim(p_word),p_category,trim(p_meaning),trim(p_reason));
  return p_id;
exception when unique_violation then raise exception '내가 이 학급에 이미 등록한 표현입니다. 기존 내 표현을 확인해 주세요.';
end; $$;
revoke all on function public.dictionary_add_word(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.dictionary_add_word(uuid,uuid,text,text,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
