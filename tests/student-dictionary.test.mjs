import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase,createApi } from './support/database.mjs';

test('중복 표현 묶음, 공동 최고 평점, 교사 승인 상태와 페이지 조회',async t=>{
  const database=await createDatabase();t.after(()=>database.db.close());
  const users=await Promise.all(Array.from({length:6},()=>database.newUser()));
  const [first,second,reviewer,teacher,fifth,sixth]=await Promise.all(users.map(id=>createApi(database,id)));
  const room=await first('createClass',{title:'1-7 파이팅'}),other=await first('createClass',{title:'다른 사전'});
  const original={id:randomUUID(),word:'킹받네',category:'유행어',meaning:'장난 때문에 은근히 짜증 남',reason:'감정을 설명하고 싶다.'};
  const duplicate={...original,id:randomUUID(),word:' 킹받네 ',meaning:'웃기면서도 얄미움'};
  await first('addWord',room.id,original);await second('addWord',room.id,duplicate);
  await reviewer('rateWord',duplicate.id,5);
  const make=(word,nickname)=>({id:randomUUID(),word,nickname,meaning:'이렇게 느끼는 마음',reason:'감정이 잘 전해짐',example:'오늘은 이렇게 말했어.'});
  const a=make('은근히 약 오르네','구름고래'),b=make('웃긴데 얄밉다','소다팝'),unrated=make('짜증나네','새벽별'),lower=make('화가 난다','별사탕');
  await first('addRevision',original.id,a);await second('addRevision',duplicate.id,b);
  await fifth('addRevision',duplicate.id,unrated);await sixth('addRevision',original.id,lower);
  await first('addRevision',original.id,a);
  await assert.rejects(first('addRevision',duplicate.id,{...a,id:randomUUID()}),/이미 순화어/);
  await assert.rejects(database.asUser(users[0],'select public.dictionary_add_revision($1,$2,$3,$4,$5,$6)',[randomUUID(),duplicate.id,'다른 말','뜻','이유','예문']),/이미 순화어/);
  for(const [proposal,rating] of [[a,3],[b,3],[lower,2]])await reviewer('rateRevision',proposal.id,rating);
  const another={...original,id:randomUUID()};await first('addWord',other.id,another);await reviewer('rateWord',another.id,5);
  const otherProposal=make('다른 사전의 말','보라구름');await first('addRevision',another.id,otherProposal);await reviewer('rateRevision',otherProposal.id,5);
  const groups=await first('getClass',room.id,'refine');
  assert.equal(groups.total,1);assert.equal(groups.wordCount,2);assert.equal(groups.words[0].original_count,2);
  assert.equal(groups.words[0].revisions.length,4);assert.equal(Number(groups.words[0].rating_count),1);
  assert.deepEqual(new Set(groups.words[0].originals.map(o=>o.meaning)),new Set([original.meaning,duplicate.meaning]));
  assert.equal(groups.words[0].revisions.filter(r=>r.top_rated).length,2);
  assert.equal(groups.words[0].revisions.find(r=>r.id===a.id).mine,true);
  assert.equal((await first('getClass',room.id,'words')).total,2);
  assert.equal((await first('getClass',room.id,'refine','얄밉다')).words[0].revisions.length,4,'search must not split a duplicate group');
  const locked=await first('getClass',room.id,'approval_pending');assert.equal(locked.approvalLocked,true);assert.deepEqual(locked.words,[]);
  await assert.rejects(first('selectRevision',a.id,true),/인증/);
  await assert.rejects(database.asUser(users[0],"select dictionary_reader.word_groups($1,'approval_pending','',0)",[room.id]),/permission denied/);
  await teacher('loginAdmin','admin123');
  let queue=await teacher('getClass',room.id,'approval_pending');
  assert.equal(queue.total,1);assert.equal(queue.pendingCount,2);
  assert.deepEqual(new Set(queue.words[0].revisions.map(r=>r.id)),new Set([a.id,b.id]));
  await assert.rejects(teacher('selectRevision',unrated.id,true),/별점 평가/);
  await assert.rejects(teacher('selectRevision',lower.id,true),/최고 평점/);
  await teacher('selectRevision',a.id,true);
  queue=await teacher('getClass',room.id,'approval_pending');assert.equal(queue.pendingCount,1);assert.equal(queue.approvedCount,1);
  assert.equal(queue.words[0].revisions[0].id,b.id);
  const completed=await teacher('getClass',room.id,'approval_approved');
  assert.equal(completed.words[0].revisions[0].published,true);
  const browse=async()=>(await database.asUser(null,'select public.dictionary_browse() data',[],'anon')).rows[0].data;
  assert.equal((await browse()).entries[0].author_name,'구름고래');
  assert.equal((await browse()).total,1,'approval publishes immediately at 3 points');
  await reviewer('rateRevision',a.id,1);await teacher('selectRevision',a.id,true);
  assert.equal((await browse()).total,1,'approved entry survives rating and rank changes');
  await reviewer('rateRevision',lower.id,4);
  await assert.rejects(teacher('selectRevision',b.id,true),/최고 평점 후보가 바뀌었습니다/);
  await teacher('selectRevision',lower.id,true);assert.equal((await browse()).total,2);
  await teacher('selectRevision',a.id,false);assert.equal((await browse()).total,1);
  assert.equal((await teacher('getClass',room.id,'approval_pending')).pendingCount,0);
  await teacher('selectRevision',lower.id,false);assert.equal((await browse()).total,0);
  assert.equal((await teacher('getClass',room.id,'approval_pending')).pendingCount,1);
  const migration=await readFile(new URL('../supabase/approval-workflow.sql',import.meta.url),'utf8');
  const before=(await database.db.query('select to_jsonb(r) data from public.dictionary_revisions r order by id')).rows;
  await database.db.exec(migration);await database.db.exec(migration);await database.db.exec(database.schema);
  assert.deepEqual((await database.db.query('select to_jsonb(r) data from public.dictionary_revisions r order by id')).rows,before);
  await database.db.query("insert into public.dictionary_words(class_id,owner_id,word,category,meaning,reason) select $1,$2,'추가표현'||lpad(n::text,2,'0'),'기타','뜻','이유' from generate_series(1,26) n",[room.id,users[0]]);
  await database.db.query("insert into public.dictionary_revisions(word_id,owner_id,word,meaning,reason,example,author_nickname) select id,$2,'후보'||word,'뜻','이유','예문','구름고래' from public.dictionary_words where class_id=$1 and word like '추가표현%'",[room.id,users[0]]);
  await database.db.query("insert into public.dictionary_revision_ratings(revision_id,owner_id,rating) select r.id,$2,2 from public.dictionary_revisions r join public.dictionary_words w on w.id=r.word_id where w.class_id=$1 and w.word like '추가표현%'",[room.id,users[2]]);
  const page1=await teacher('getClass',room.id,'approval_pending','',0),page2=await teacher('getClass',room.id,'approval_pending','',25);
  assert.equal(page1.total,27);assert.equal(page1.words.length,25);assert.equal(page2.words.length,2);
  assert.equal(new Set([...page1.words,...page2.words].map(w=>w.word)).size,27);
  assert.equal((await first('getClass',room.id,'refine')).total,27);
  assert.equal((await teacher('getClass',room.id,'approval_pending','후보추가표현01')).total,1);
});

test('자유 제목과 제안별 닉네임: 검증·재시도·동명 사전·편찬 연결·기존 자료 보존',async t=>{
  const database=await createDatabase();t.after(()=>database.db.close());
  const owner=await database.newUser(),reviewer=await database.newUser();
  const api=await createApi(database,owner),peer=await createApi(database,reviewer);
  const id=randomUUID();
  for(const title of ['', '   ', '가'.repeat(81)])await assert.rejects(api('createClass',{title}),/1~80자/);
  const room=await api('createClass',{id,title:'  1-7 파이팅  '});
  assert.equal(room.title,'1-7 파이팅');
  assert.equal((await api('createClass',{id,title:'1-7 파이팅'})).id,id);
  assert.notEqual((await peer('createClass',{title:'1-7 파이팅'})).id,id);
  await assert.rejects(peer('createClass',{id,title:'가로채기'}),/다른 작성자/);
  const bare=(await database.db.query('select * from public.class_dictionaries where id=$1',[id])).rows[0];
  assert.equal(bare.school,null);assert.equal(bare.grade,null);assert.equal(bare.class_name,null);
  assert.equal((await peer('listClasses','1-7 파이팅')).total,2);
  const free=await api('createClass',{title:'1학년 7반'});
  assert.equal((await peer('getClass',free.id)).class.title,'1학년 7반');
  assert.ok(!('school' in (await peer('getClass',id)).class));
  await assert.rejects(database.asUser(null,'select public.dictionary_create($1)', ['새 사전'],'anon'),/permission denied/);
  const proposal={id:randomUUID(),word:'마음쉼',meaning:'마음이 편히 쉬는 일',reason:'뜻이 잘 전해짐',example:'산책하며 마음쉼을 했어.',nickname:'  민트초코  '};
  const words=[randomUUID(),randomUUID()];
  for(let i=0;i<words.length;i++){
    await api('addWord',id,{id:words[i],word:'힐링'+i,meaning:'편히 쉬는 일',reason:'쉬운 말로',category:'외래어'});
    await peer('rateWord',words[i],5);
  }
  for(const nickname of [undefined,'','   ','가'.repeat(21)])await assert.rejects(api('addRevision',words[0],{...proposal,nickname}),/닉네임은 1~20자/);
  await api('addRevision',words[0],proposal);
  await api('addRevision',words[0],{...proposal,nickname:'재시도 이름'});
  await api('addRevision',words[1],{...proposal,id:randomUUID(),nickname:'새벽별'});
  await database.db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[{dictionary_nickname:'다른이름'},owner]);
  const saved=(await api('getClass',id)).words;
  assert.equal(saved.find(w=>w.id===words[0]).revisions[0].author_name,'민트초코');
  assert.equal(saved.find(w=>w.id===words[1]).revisions[0].author_name,'새벽별');
  await peer('rateRevision',proposal.id,5);await peer('loginAdmin','admin123');await peer('selectRevision',proposal.id,true);
  const update=await readFile(new URL('../supabase/dictionary-titles-update.sql',import.meta.url),'utf8');
  await database.db.exec(update);await database.db.exec(update);
  const published=(await api('getClass',id,'published')).published[0];
  assert.equal(published.author_name,'민트초코');assert.equal(published.example,proposal.example);
  const publicEntry=(await database.asUser(null,'select public.dictionary_browse() result',[],'anon')).rows[0].result.entries[0];
  assert.equal(publicEntry.author_name,'민트초코');assert.equal(publicEntry.title,'1-7 파이팅');
  assert.equal((await api('getClass',id)).wordCount,2);assert.equal((await api('getClass',id)).revisionCount,2);
  assert.equal(Number(publicEntry.rating_count),1);
});

test('공개 학급: 등록 → 상호 평가 → 순화어 평가 → 교사 편찬 → 서버 삭제',async t => {
  const database = await createDatabase(); t.after(() => database.db.close());
  const ids = await Promise.all([database.newUser(),database.newUser(),database.newUser()]);
  const [student,peer,teacher] = await Promise.all(ids.map(id => createApi(database,id)));
  const roomId=randomUUID();
  const room = await student('createClass',{id:roomId,title:'우리말 탐험대'});
  const otherRoom = await peer('createClass',{title:'함께 쓰는 말'});
  const word = {id:randomUUID(),word:'힐링',category:'외래어',meaning:'마음이 편안해지는 일',reason:'쉬운 우리말로 바꾸고 싶어요.'};
  const revision = {id:randomUUID(),nickname:'별사탕',word:'마음쉼',meaning:'마음을 쉬게 하는 일',reason:'뜻이 쉽게 전해져요.',example:'산책하며 마음쉼을 했어.'};

  await t.test('자유 제목으로 생성·목록 조회·입장, 같은 요청 재시도 보호',async () => {
    assert.equal((await peer('listClasses')).classes.length,2);
    assert.equal((await student('createClass',{id:roomId,title:'우리말 탐험대'})).id,room.id);
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
  await t.test('4점 미만도 단어별 최고 평점이면 교사 승인으로 즉시 편찬',async () => {
    const pending=await teacher('getClass',room.id,'approval_pending');
    assert.equal(Number(pending.words[0].revisions[0].average_rating),3);
    assert.equal((await student('getClass',room.id,'published')).published.length,0);
    await teacher('selectRevision',revision.id,true);
    assert.equal((await student('getClass',room.id,'published')).published[0].word,'마음쉼');
    assert.equal((await student('getClass',otherRoom.id,'published')).published.length,0);
  });
  await t.test('승인 후 평점이 내려가도 유지하며 교사가 취소할 때만 최종 사전에서 제외',async () => {
    await peer('rateRevision',revision.id,2);
    assert.equal((await student('getClass',room.id,'published')).published.length,1);
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
    await assert.rejects(student('createClass',{title:'새 사전'}),/무료 저장/);
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
  const room = await first('createClass',{title:'1-7 파이팅'});
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
  const revision = {id:randomUUID(),nickname:'별사탕',word:'은근히 약 오르네',meaning:'계속 신경 쓰여 짜증이 남',reason:'감정을 설명한다.',example:'계속 놀리니까 은근히 약 오르네.'};
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
  const first=await student('createClass',{title:'1-7 파이팅'});
  const second=await student('createClass',{title:'우리말 탐험대'});
  const unfinished=await student('createClass',{title:'아직 편찬 전'});
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
  assert.ok(all.entries.every(r=>r.title&&r.class_id&&!('school' in r)&&!('grade' in r)&&!('class_name' in r)));
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
  assert.equal((await browse('classes','1-7 파이팅')).classes[0].id,first.id);
  assert.equal((await browse('classes','우리말 탐험대')).classes[0].id,second.id);
  const filtered=await browse('words','',second.id);assert.equal(filtered.class.id,second.id);assert.ok(filtered.entries.every(r=>r.class_id===second.id));
  assert.equal((await browse('words','',unfinished.id)).total,0);
  assert.equal((await browse('words','',randomUUID())).class,null);
  await database.db.query('update public.dictionary_revision_ratings set rating=3 where revision_id=$1',[droppedId]);
  assert.equal((await browse('words','마음쉼')).total,2);
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
  for(const id of [classId,otherId])await database.db.query('insert into public.class_dictionaries(id,title,school,grade,class_name,created_by) values($1,$2,$2,$3,$4,$5)',[id,id===classId?'원주여자고등학교':'다른학교','1','7',people[0]]);
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
