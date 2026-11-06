import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    await assert.rejects(peer('addWord',room.id,{...word,id:randomUUID()}),/이미 등록/);
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
