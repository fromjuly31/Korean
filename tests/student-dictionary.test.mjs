import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase,createApi } from './support/database.mjs';

test('공개 학급: 등록 → 상호 평가 → 순화어 평가 → 교사 편찬 → 서버 삭제',async t => {
  const database = await createDatabase(); t.after(() => database.db.close());
  const ids = await Promise.all([database.newUser(),database.newUser(),database.newUser()]);
  const [student,peer,teacher] = await Promise.all(ids.map(id => createApi(database,id)));
  const room = await student('createClass',{school:'한빛중학교',grade:'2학년',className:'3반'});
  const otherRoom = await peer('createClass',{school:'한빛중학교',grade:'2학년',className:'4반'});
  const word = {id:randomUUID(),word:'힐링',category:'외래어',meaning:'마음이 편안해지는 일',reason:'쉬운 우리말로 바꾸고 싶어요.'};
  const revision = {id:randomUUID(),word:'마음쉼',meaning:'마음을 쉬게 하는 일',reason:'뜻이 쉽게 전해져요.',example:'산책하며 마음쉼을 했어.'};

  await t.test('코드·비밀번호 없이 학급 생성·목록 조회·입장, 중복 학급 재사용',async () => {
    assert.equal((await peer('listClasses')).classes.length,2);
    assert.equal((await peer('createClass',{school:'한빛중학교',grade:'2학년',className:'3반'})).id,room.id);
    assert.equal((await peer('getClass',room.id)).class.id,room.id);
    assert.equal(await student('isAdmin'),false);
    const anonymous = await database.asUser(null,"select public.dictionary_list_classes() as result",[],'anon');
    assert.equal(anonymous.rows[0].result.total,2);
  });
  await t.test('표현 등록은 재시도해도 중복 생성되지 않으며 원본 평가 전 순화어 제안은 차단',async () => {
    await student('addWord',room.id,word); await student('addWord',room.id,word);
    assert.equal((await peer('getClass',room.id)).wordCount,1);
    await assert.rejects(student('addWord',room.id,{...word,id:randomUUID()}),/이미 등록/);
    await assert.rejects(student('addRevision',word.id,revision),/상호 평가/);
  });
  await t.test('원본 별점은 1~5점, 자기 평가 금지, 재평가는 한 표만 갱신',async () => {
    await assert.rejects(student('rateWord',word.id,5),/다른 친구/);
    await assert.rejects(peer('rateWord',word.id,6),/1~5점/);
    await peer('rateWord',word.id,3); await peer('rateWord',word.id,5);
    const item = (await student('getClass',room.id)).words[0];
    assert.equal(Number(item.rating_count),1); assert.equal(Number(item.average_rating),5);
  });
  await t.test('순화어 등록·재시도와 별점 평가, 원본과 같은 제안 및 자기 평가 차단',async () => {
    await assert.rejects(student('addRevision',word.id,{...revision,word:word.word}),/다른 순화어/);
    await student('addRevision',word.id,revision); await student('addRevision',word.id,revision);
    await assert.rejects(student('rateRevision',revision.id,5),/다른 친구/);
    await peer('rateRevision',revision.id,3);
    assert.equal((await student('getClass',room.id)).revisionCount,1);
  });
  await t.test('관리자 비밀번호 admin123은 서버에서 검증되고 직접 테이블 접근은 불가',async () => {
    await assert.rejects(teacher('loginAdmin','wrong'),/비밀번호/);
    await teacher('loginAdmin','admin123'); assert.equal(await teacher('isAdmin'),true);
    await assert.rejects(student('selectRevision',revision.id,true),/인증/);
    await assert.rejects(database.asUser(ids[0],'select * from public.dictionary_settings'),/permission denied/);
    await assert.rejects(database.asUser(ids[0],"update public.dictionary_revisions set selected=true where id=$1",[revision.id]),/permission denied/);
    await assert.rejects(database.asUser(ids[0],"delete from public.class_dictionaries where id=$1",[room.id]),/permission denied/);
  });
  await t.test('4점 미만은 교사도 편찬 불가, 고평점도 교사 선택 전에는 공개 사전에 없음',async () => {
    await assert.rejects(teacher('selectRevision',revision.id,true),/4점 이상/);
    await peer('rateRevision',revision.id,5);
    assert.equal((await student('getClass',room.id,'published')).published.length,0);
    await teacher('selectRevision',revision.id,true);
    assert.equal((await student('getClass',room.id,'published')).published[0].word,'마음쉼');
    assert.equal((await student('getClass',otherRoom.id,'published')).published.length,0);
  });
  await t.test('재평가로 평점 미달 또는 교사 선택 취소 시 최종 사전에서 제외',async () => {
    await peer('rateRevision',revision.id,3);
    assert.equal((await student('getClass',room.id,'published')).published.length,0);
    await peer('rateRevision',revision.id,5);
    await teacher('selectRevision',revision.id,false);
    assert.equal((await student('getClass',room.id,'published')).published.length,0);
    await teacher('selectRevision',revision.id,true);
  });
  await t.test('학생의 학급 삭제 차단, 관리자는 로그아웃하면 권한 소멸',async () => {
    await assert.rejects(student('deleteClass',room.id),/관리자만/);
    await teacher('logoutAdmin'); await assert.rejects(teacher('deleteClass',room.id),/관리자만/);
    await teacher('loginAdmin','admin123');
  });
  await t.test('동시 요청·검색·페이지 조회와 SQL 재실행에도 기존 자료 유지',async () => {
    await Promise.all([peer('rateWord',word.id,4),peer('rateWord',word.id,5)]);
    assert.equal(Number((await student('getClass',room.id)).words[0].rating_count),1);
    assert.equal((await student('listClasses','없는학교')).total,0);
    assert.equal((await student('getClass',room.id,'published','마음')).published.length,1);
    await database.db.exec(database.schema);
    assert.equal((await student('getClass',room.id,'published')).published.length,1);
  });
  await t.test('무료 용량 보호 한도에서 신규 등록·평가 변경 차단, 읽기·관리자 로그인은 가능',async () => {
    await database.db.exec('update public.dictionary_settings set write_limit_bytes=1');
    assert.equal((await student('getUsage')).writeBlocked,true);
    await assert.rejects(student('addWord',room.id,{...word,id:randomUUID(),word:'테스트'}),/무료 저장/);
    await assert.rejects(peer('rateRevision',revision.id,4),/무료 저장/);
    await assert.rejects(student('createClass',{school:'새학교',grade:'1학년',className:'1반'}),/무료 저장/);
    await teacher('logoutAdmin'); await teacher('loginAdmin','admin123');
    assert.equal((await student('getClass',room.id,'published')).published.length,1);
  });
  await t.test('용량 초과 상태에서도 관리자 삭제가 서버의 모든 연결 자료에 CASCADE 적용',async () => {
    await teacher('deleteClass',room.id);
    for (const table of ['dictionary_words','dictionary_word_ratings','dictionary_revisions','dictionary_revision_ratings']) {
      assert.equal(Number((await database.db.query('select count(*) as n from public.'+table)).rows[0].n),0,table);
    }
    assert.equal((await student('listClasses')).classes[0].id,otherRoom.id);
    await assert.rejects(student('getClass',room.id),/삭제되었거나/);
    await assert.rejects(teacher('deleteClass',room.id),/이미 삭제/);
  });
});

test('관리자 비밀번호 실패 횟수 제한과 만료',async t => {
  const database = await createDatabase(); t.after(() => database.db.close());
  const id = await database.newUser(); const api = await createApi(database,id);
  for(let i=0;i<5;i++) await assert.rejects(api('loginAdmin','bad'),/비밀번호/);
  await assert.rejects(api('loginAdmin','admin123'),/시도 횟수/);
  await database.db.exec("update public.dictionary_admin_sessions set locked_until=now()-interval '1 second'");
  await api('loginAdmin','admin123');
  await database.db.exec("update public.dictionary_admin_sessions set expires_at=now()-interval '1 second'");
  assert.equal(await api('isAdmin'),false);
});

test('같은 표현도 학생별 등록·평가·편찬이 독립적이며 기존 자료와 재시도 보호를 유지',async t => {
  const database = await createDatabase(); t.after(() => database.db.close());
  const ids = await Promise.all([database.newUser(),database.newUser(),database.newUser()]);
  const [first,second,teacher] = await Promise.all(ids.map(id => createApi(database,id)));
  const room = await first('createClass',{school:'예시고등학교',grade:'1',className:'7'});
  const original = {id:randomUUID(),word:'킹받네',category:'유행어',meaning:'장난 때문에 은근히 짜증 남',reason:'감정을 직접 말하고 싶다.'};
  await database.db.exec('drop index public.dictionary_words_owner_unique; create unique index dictionary_words_unique on public.dictionary_words(class_id,lower(trim(word)))');
  await first('addWord',room.id,original);
  const update = await readFile(new URL('../supabase/duplicate-words-update.sql',import.meta.url),'utf8');
  await database.db.exec(update);
  const duplicate = {...original,id:randomUUID(),word:' 킹받네 ',meaning:'웃기면서도 약 오름',reason:'친구가 싫어할 수도 있어서.'};
  await second('addWord',room.id,duplicate);
  await second('addWord',room.id,duplicate);
  await assert.rejects(first('addWord',room.id,{...duplicate,id:randomUUID()}),/내가.*이미 등록/);
  await second('rateWord',original.id,5);
  await first('rateWord',duplicate.id,2);
  const words = (await first('getClass',room.id,'words','킹받네')).words;
  assert.equal(words.length,2);
  assert.equal(words.find(w=>w.id===original.id).meaning,original.meaning);
  assert.equal(words.find(w=>w.id===original.id).mine,true);
  assert.equal(Number(words.find(w=>w.id===original.id).average_rating),5);
  assert.equal(words.find(w=>w.id===duplicate.id).mine,false);
  assert.equal(Number(words.find(w=>w.id===duplicate.id).average_rating),2);
  const revision = {id:randomUUID(),word:'은근히 약 오르네',meaning:'계속 신경 쓰여 짜증이 남',reason:'감정을 설명한다.',example:'계속 놀리니까 은근히 약 오르네.'};
  await first('addRevision',original.id,revision);
  await second('rateRevision',revision.id,5);
  await teacher('loginAdmin','admin123');
  await teacher('selectRevision',revision.id,true);
  assert.equal((await first('getClass',room.id,'published')).publishedCount,1);
  await database.db.exec(update);
  await database.db.exec(database.schema);
  const after = await first('getClass',room.id);
  assert.equal(after.wordCount,2);
  assert.equal(after.words.find(w=>w.id===duplicate.id).revisions.length,0);
  assert.equal(after.publishedCount,1);
});

test('공개 사전은 최종 편찬어와 익명 닉네임을 검색·분리·페이지 조회하며 개인 식별 정보는 감춘다',async t => {
  const database=await createDatabase();t.after(()=>database.db.close());
  const writer=await database.newUser(),reviewer=await database.newUser();
  await database.db.query("update auth.users set raw_app_meta_data=$1,raw_user_meta_data=$2 where id=$3",[{display_name:'비공개 실명'},{display_name:'사용자가 입력한 실명'},writer]);
  const student=await createApi(database,writer);
  const first=await student('createClass',{school:'가람고등학교',grade:'1',className:'7'});
  const second=await student('createClass',{school:'나래고등학교',grade:'2학년',className:'3반'});
  const unfinished=await student('createClass',{school:'미편찬고등학교',grade:'1',className:'1'});
  let droppedId,unselectedId;
  for(let i=0;i<29;i++) {
    const room=i===28?unfinished:i%2?second:first;
    const wordId=randomUUID(),revisionId=randomUUID();
    await database.db.query('insert into public.dictionary_words(id,class_id,owner_id,word,category,meaning,reason) values($1,$2,$3,$4,$5,$6,$7)',[wordId,room.id,writer,'표현'+i,'유행어','원래 뜻','비공개 원문 이유']);
    await database.db.query('insert into public.dictionary_revisions(id,word_id,owner_id,word,meaning,reason,example,selected) values($1,$2,$3,$4,$5,$6,$7,$8)',[revisionId,wordId,writer,i<2?'마음쉼':'순화어'+String(i).padStart(2,'0'),'공개 뜻 '+i,'비공개 제안 이유','공개 예문 '+i,i!==27&&i!==28]);
    await database.db.query('insert into public.dictionary_revision_ratings(revision_id,owner_id,rating) values($1,$2,$3)',[revisionId,reviewer,5]);
    if(i===0)droppedId=revisionId;if(i===27)unselectedId=revisionId;
  }
  const browse=async(view='words',search='',classId=null,offset=0)=>(await database.asUser(null,'select public.dictionary_browse($1,$2,$3,$4) result',[view,search,classId,offset],'anon')).rows[0].result;
  const all=await browse();
  assert.equal(all.total,27);assert.equal(all.publishedCount,27);assert.equal(all.classCount,2);assert.equal(all.entries.length,24);
  assert.equal((await browse('words','',null,24)).entries.length,3);
  assert.equal(new Set([...all.entries,...(await browse('words','',null,24)).entries].map(r=>r.id)).size,27);
  assert.ok(all.entries.every(r=>r.school&&r.grade&&r.class_name&&r.class_id));
  assert.ok(all.entries.every(r=>!('owner_id' in r)&&!('selected_by' in r)&&!('reason' in r)&&!('my_rating' in r)));
  const anonymousName=all.entries[0].author_name;
  assert.match(anonymousName,/^[가-힣]+[0-9]{3}$/);
  assert.ok(all.entries.every(r=>r.author_name===anonymousName));
  assert.ok(!JSON.stringify(all).includes('실명'));
  assert.equal((await student('getClass',first.id)).words[0].author_name,anonymousName);
  await database.db.query("update auth.users set raw_app_meta_data=raw_app_meta_data||$1::jsonb where id=$2",[{dictionary_nickname:'별사탕'},writer]);
  assert.ok((await browse()).entries.every(r=>r.author_name==='별사탕'));
  assert.equal((await student('getClass',first.id,'published')).published[0].author_name,'별사탕');
  await assert.rejects(database.asUser(null,'select dictionary_reader.author_name($1)',[writer],'anon'),/permission denied/);
  assert.equal((await browse('words','마음쉼')).total,2);
  assert.equal((await browse('words','표현0')).total,1);
  assert.equal((await browse('words','공개 뜻 5')).total,1);
  assert.equal((await browse('words','비공개')).total,0);
  const classes=await browse('classes');assert.equal(classes.classes.length,2);assert.deepEqual(classes.entries,[]);
  assert.equal((await browse('classes','1학년 7반')).classes[0].id,first.id);
  assert.equal((await browse('classes','2학년 3반')).classes[0].id,second.id);
  const filtered=await browse('words','',second.id);assert.equal(filtered.class.id,second.id);assert.ok(filtered.entries.every(r=>r.class_id===second.id));
  assert.equal((await browse('words','',unfinished.id)).total,0);
  assert.equal((await browse('words','',randomUUID())).class,null);
  await database.db.query('update public.dictionary_revision_ratings set rating=3 where revision_id=$1',[droppedId]);
  assert.equal((await browse('words','마음쉼')).total,1);
  assert.ok(!(await browse()).entries.some(r=>r.id===unselectedId));
  await assert.rejects(database.asUser(null,'select * from public.dictionary_revisions',[],'anon'),/permission denied/);
  await assert.rejects(browse('invalid'),/지원하지/);
  assert.equal((await browse('words','',null,-24)).entries.length,24);
  await database.db.query('delete from public.class_dictionaries where id=$1',[second.id]);
  assert.equal((await browse('classes')).classes.length,1);
  await database.db.exec(await readFile(new URL('../supabase/dictionary-library.sql',import.meta.url),'utf8'));
  assert.equal((await browse('classes')).classes.length,1);
});

test('기존 예시의 이름 표시만 정리하고 문장·평가·다른 학급 자료를 보존한다',async t=>{
  const database=await createDatabase();t.after(()=>database.db.close());
  const people=[];
  for(let n=1;n<=30;n++){
    const id=await database.newUser();people.push(id);
    await database.db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[{seed_id:'wonju-1-7-grade10-demo-20261107',synthetic:true,participant_number:n},id]);
  }
  const classId='219df13a-738f-4bed-b2a6-1e5c6f7a3655',otherId=randomUUID(),wordId=randomUUID(),otherWordId=randomUUID(),revisionId=randomUUID();
  for(const id of [classId,otherId])await database.db.query('insert into public.class_dictionaries(id,school,grade,class_name,created_by) values($1,$2,$3,$4,$5)',[id,id===classId?'원주여자고등학교':'다른학교','1','7',people[0]]);
  for(const [id,room] of [[wordId,classId],[otherWordId,otherId]])await database.db.query('insert into public.dictionary_words(id,class_id,owner_id,word,category,meaning,reason) values($1,$2,$3,$4,$5,$6,$7)',[id,room,people[29],'딸깍','유행어','간단히 끝냄','원래 이유 [가상 학생 30 · 예시]']);
  await database.db.query('insert into public.dictionary_revisions(id,word_id,owner_id,word,meaning,reason,example,selected) values($1,$2,$3,$4,$5,$6,$7,true)',[revisionId,wordId,people[29],'간단히 처리하다','복잡한 절차 없이 일을 끝내다.','바꾼 이유 [가상 학생 30 · 예시]','표 정리는 도구로 간단히 처리했어. [가상 학생 30의 가상 예문]']);
  await database.db.query('insert into public.dictionary_revision_ratings(revision_id,owner_id,rating) values($1,$2,5)',[revisionId,people[0]]);
  const update=await readFile(new URL('../supabase/examples/wonju-nicknames-update.sql',import.meta.url),'utf8');
  await database.db.exec(update);await database.db.exec(update);
  const row=(await database.db.query('select * from public.dictionary_revisions where id=$1',[revisionId])).rows[0];
  assert.equal(row.reason,'바꾼 이유');assert.equal(row.example,'표 정리는 도구로 간단히 처리했어.');assert.equal(row.selected,true);
  assert.equal((await database.db.query('select reason from public.dictionary_words where id=$1',[otherWordId])).rows[0].reason,'원래 이유 [가상 학생 30 · 예시]');
  assert.equal((await database.db.query('select dictionary_reader.author_name($1) name',[people[29]])).rows[0].name,'소다팝');
  const user=(await database.db.query('select raw_app_meta_data from auth.users where id=$1',[people[29]])).rows[0].raw_app_meta_data;
  assert.equal(user.synthetic,true);assert.equal(user.seed_id,'wonju-1-7-grade10-demo-20261107');
  const published=(await database.asUser(null,'select public.dictionary_browse() data',[],'anon')).rows[0].data;
  assert.equal(published.total,1);assert.equal(published.entries[0].author_name,'소다팝');assert.equal(Number(published.entries[0].average_rating),5);
});
