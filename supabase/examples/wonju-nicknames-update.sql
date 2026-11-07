-- 이미 반영한 예시의 작성자 표시만 바꿉니다. 원문, 별점, 편찬 선택은 유지합니다.
begin;
create temp table _nickname_map on commit drop as
select u.id,n.nickname from auth.users u
join (values (1,'구름고래'),(2,'민트초코'),(3,'말랑콩떡'),(4,'달빛책갈피'),(5,'초코송이'),(6,'햇살한줌'),(7,'밤하늘'),(8,'복숭아젤리'),(9,'필통요정'),(10,'라임소다'),(11,'느린거북'),(12,'별사탕'),(13,'고구마라떼'),(14,'책먹는곰'),(15,'우주먼지'),(16,'레몬사탕'),(17,'꾸벅고양이'),(18,'오늘도맑음'),(19,'딸기우유'),(20,'바람개비'),(21,'파란운동화'),(22,'모찌토끼'),(23,'새벽별'),(24,'메론빵'),(25,'급식탐험가'),(26,'귤한조각'),(27,'졸린수달'),(28,'보라구름'),(29,'녹차쿠키'),(30,'소다팝')) n(number,nickname) on (u.raw_app_meta_data->>'participant_number')::integer=n.number
where u.raw_app_meta_data->>'seed_id'='wonju-1-7-grade10-demo-20261107';
do $$ begin if (select count(*) from _nickname_map)<>30 then raise exception '예시 작성자 30명을 확인할 수 없습니다.'; end if; end $$;
update auth.users u set raw_app_meta_data=coalesce(u.raw_app_meta_data,'{}'::jsonb)||jsonb_build_object('dictionary_nickname',n.nickname,'display_name',n.nickname),
raw_user_meta_data=coalesce(u.raw_user_meta_data,'{}'::jsonb)||jsonb_build_object('display_name',n.nickname)
from _nickname_map n where u.id=n.id;
update public.dictionary_words w set reason=regexp_replace(w.reason,' \[가상 학생 [0-9]+ · 예시\]$','')
from _nickname_map n where w.owner_id=n.id and w.class_id='219df13a-738f-4bed-b2a6-1e5c6f7a3655' and w.reason~' \[가상 학생 [0-9]+ · 예시\]$';
update public.dictionary_revisions r set reason=regexp_replace(r.reason,' \[가상 학생 [0-9]+ · 예시\]$',''),
example=regexp_replace(r.example,' \[가상 학생 [0-9]+의 가상 예문\]$','')
from _nickname_map n,public.dictionary_words w where r.owner_id=n.id and r.word_id=w.id
and w.class_id='219df13a-738f-4bed-b2a6-1e5c6f7a3655'
and (r.reason~' \[가상 학생 [0-9]+ · 예시\]$' or r.example~' \[가상 학생 [0-9]+의 가상 예문\]$');
commit;
