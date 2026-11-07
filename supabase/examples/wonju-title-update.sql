-- Rename only the existing example dictionary selected by its original metadata.
-- Its ID, content, ratings and legacy school/class metadata stay intact.
begin;
update public.class_dictionaries set title='1-7 파이팅'
where school='원주여자고등학교' and grade='1' and class_name='7'
  and title in ('원주여자고등학교 1학년 7반','1-7 파이팅');
commit;
