import {nicknames} from './nicknames.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {classId, seedTag, existingWordId, entries, existingRevisions, sources} from './wonju-1-7.mjs';

const id = (kind,n) => `d170000${kind}-1107-4000-8000-${String(n).padStart(12,'0')}`;
const label = n => nicknames[n-1];
const quote = value => "'" + String(value).replaceAll("'","''") + "'";
assert.equal(entries.length,30);
const users = Array.from({length:31},(_,i)=>({
  id:id(1,i+1), metadata:{synthetic:true,seed_id:seedTag,participant_number:i<30?i+1:null,
    dictionary_nickname:i<30?label(i+1):'편찬도우미',display_name:i<30?label(i+1):'편찬도우미',purpose:'고1 30명 참여 수업 예시'}
}));
const words = entries.map(([word,category,meaning,reason],i)=>({
  id:id(2,i+1),owner_id:users[i].id,word,category,meaning,
  reason
}));
const allWords = [...words,{id:existingWordId,word:'야르',category:'유행어',owner_id:null}];
const wordRatings=[],revisions=[],revisionRatings=[];
for (let i=0;i<allWords.length;i++) {
  const original=allWords[i];
  const mild = ['럭키비키','칠가이','추구미','감다살','아자스','야르'].includes(original.word);
  const wordScores = original.category==='비속어'?[5,4,5,5,4,5,3]:mild?[2,3,2,4,3,2,3]:[3,4,4,3,5,4,3];
  for(let j=0;j<10+i%9;j++) {
    const voter=users[(i+j+1)%30];
    assert.notEqual(voter.id,original.owner_id);
    wordRatings.push({word_id:original.id,owner_id:voter.id,rating:wordScores[(i+j)%wordScores.length]});
  }
  const candidates=i<30?entries[i].slice(4):existingRevisions;
  candidates.forEach(([word,meaning,reason,example],variant)=>{
    const author=(i+(variant?17:7))%30;
    const revision={id:id(3,i*2+variant+1),word_id:original.id,owner_id:users[author].id,
      word,meaning,reason,
      example,selected:variant===0};
    revisions.push(revision);
    const scores=variant===0?[5,4,5,4,5,3,5]:i%4===0?[4,5,4,4,5,4]:[3,4,2,4,3,5,3];
    for(let j=0;j<8+(i+variant*3)%9;j++) {
      const voter=users[(author+j+1)%30];
      assert.notEqual(voter.id,revision.owner_id);
      revisionRatings.push({revision_id:revision.id,owner_id:voter.id,rating:scores[(i+j)%scores.length]});
    }
    const votes=revisionRatings.filter(r=>r.revision_id===revision.id);
    revision.average=votes.reduce((sum,r)=>sum+r.rating,0)/votes.length;
    assert.ok(!revision.selected||revision.average>=4);
  });
}
for(const item of [...words,...revisions]) {
  for(const field of ['word','meaning','reason',...(item.example?['example']:[])])
    assert.ok(item[field].trim().length>0&&item[field].length<=(field==='word'?80:600),`${item.word}: ${field}`);
}
assert.equal(new Set(words.map(w=>w.owner_id)).size,30);
assert.equal(new Set(revisions.map(r=>r.owner_id)).size,30);
for(const rows of [wordRatings,revisionRatings]) assert.equal(new Set(rows.map(r=>r.owner_id)).size,30);
assert.equal(new Set(words.map(w=>w.owner_id+'|'+w.word)).size,30);
const duplicates=Object.entries(allWords.reduce((out,w)=>{out[w.word]=(out[w.word]||0)+1;return out;},{})).filter(([,n])=>n>1);
assert.equal(duplicates.length,4);
const payload={users,words,wordRatings,revisions,revisionRatings};
const payloadSQL=quote(JSON.stringify(payload));
// This transaction is a one-time data operation, deliberately separate from installation SQL.
// Deterministic IDs and conflict checks make retries safe; existing contributions are not updated.
export const sql=`begin;
select pg_advisory_xact_lock(1707112026);
do $$ begin
  if not exists(select 1 from public.class_dictionaries where id=${quote(classId)} and school='원주여자고등학교' and grade='1' and class_name='7') then
    raise exception '대상 학급이 다릅니다. 예시를 적용하지 않았습니다.';
  end if;
  if not exists(select 1 from public.dictionary_words where id=${quote(existingWordId)} and class_id=${quote(classId)} and word='야르') then
    raise exception '기존 야르 항목을 확인할 수 없습니다.';
  end if;
end $$;
create temp table _wonju_payload on commit drop as select ${payloadSQL}::jsonb as data;
create temp table _wonju_original on commit drop as select to_jsonb(w) snapshot from public.dictionary_words w where id=${quote(existingWordId)};
do $$ begin
  if exists(select 1 from auth.users u join jsonb_to_recordset((select data->'users' from _wonju_payload)) x(id uuid) on x.id=u.id where u.raw_app_meta_data->>'seed_id' is distinct from ${quote(seedTag)}) then
    raise exception '예시 참여자 ID가 기존 사용자와 겹칩니다.';
  end if;
end $$;
insert into auth.users(id,aud,role,is_anonymous,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',true,metadata,jsonb_build_object('display_name',metadata->>'display_name'),now(),now()
from jsonb_to_recordset((select data->'users' from _wonju_payload)) x(id uuid,metadata jsonb)
on conflict(id) do nothing;

-- Run submissions and ratings through the same application rules used by students.
do $$ declare x record; begin
  for x in select * from jsonb_to_recordset((select data->'words' from _wonju_payload))
    p(id uuid,owner_id uuid,word text,category text,meaning text,reason text) loop
    perform set_config('request.jwt.claim.sub',x.owner_id::text,true);
    perform public.dictionary_add_word(x.id,${quote(classId)},x.word,x.category,x.meaning,x.reason);
  end loop;
  for x in select * from jsonb_to_recordset((select data->'wordRatings' from _wonju_payload))
    p(word_id uuid,owner_id uuid,rating integer) loop
    perform set_config('request.jwt.claim.sub',x.owner_id::text,true);
    perform public.dictionary_rate_word(x.word_id,x.rating);
  end loop;
  for x in select * from jsonb_to_recordset((select data->'revisions' from _wonju_payload))
    p(id uuid,word_id uuid,owner_id uuid,word text,meaning text,reason text,example text) loop
    perform set_config('request.jwt.claim.sub',x.owner_id::text,true);
    perform public.dictionary_add_revision(x.id,x.word_id,x.word,x.meaning,x.reason,x.example);
  end loop;
  for x in select * from jsonb_to_recordset((select data->'revisionRatings' from _wonju_payload))
    p(revision_id uuid,owner_id uuid,rating integer) loop
    perform set_config('request.jwt.claim.sub',x.owner_id::text,true);
    perform public.dictionary_rate_revision(x.revision_id,x.rating);
  end loop;
end $$;

-- A synthetic editor simulates the final selection, and retains no admin session.
insert into public.dictionary_admin_sessions(user_id,expires_at) values(${quote(users[30].id)},now()+interval '1 minute');
do $$ declare x record; begin
  perform set_config('request.jwt.claim.sub',${quote(users[30].id)},true);
  for x in select * from jsonb_to_recordset((select data->'revisions' from _wonju_payload)) p(id uuid,selected boolean) loop
    perform public.dictionary_select_revision(x.id,x.selected);
  end loop;
end $$;
delete from public.dictionary_admin_sessions where user_id=${quote(users[30].id)};
do $$ begin
  if (select to_jsonb(w) from public.dictionary_words w where id=${quote(existingWordId)}) is distinct from (select snapshot from _wonju_original) then
    raise exception '기존 표현이 변경되었습니다.';
  end if;
  if (select count(*) from public.dictionary_revision_summary where id in (select (value->>'id')::uuid from jsonb_array_elements((select data->'revisions' from _wonju_payload))) and selected and average_rating>=4 and rating_count>0)<>31 then
    raise exception '최종 편찬 31건 검증에 실패했습니다.';
  end if;
end $$;
commit;
`;

const output=new URL('../../test-results/wonju-1-7/',import.meta.url);
await mkdir(output,{recursive:true});
await writeFile(new URL('seed.sql',output),sql,'utf8');
await writeFile(new URL('data.json',output),JSON.stringify(payload,null,2),'utf8');
const counts={students:30,addedWords:words.length,totalWords:31,uniqueWords:new Set(allWords.map(w=>w.word)).size,
  revisions:revisions.length,published:revisions.filter(r=>r.selected).length,
  wordRatings:wordRatings.length,revisionRatings:revisionRatings.length,duplicates};
await writeFile(new URL('summary.json',output),JSON.stringify(counts,null,2),'utf8');
const report=['# 원주여자고등학교 1-7 · 고1 가상 수업 예시','',
  '학생 30명과 편찬 담당 1명은 모두 가상입니다. 실제 학생 이름·제출물·별점·교사 평가가 아닙니다.',
  '기존에 등록된 ‘야르’ 원문은 보존하고 가상 평가와 순화어만 추가했습니다.',
  '서로 다른 학생은 같은 표현을 등록할 수 있으며, 항목별 평가와 순화어는 독립적입니다.',
  '',...Object.entries(counts).filter(([k])=>k!=='duplicates').map(([k,v])=>`- ${k}: ${v}`),'',
  '중복 표현: '+duplicates.map(([word,n])=>`${word} ${n}건`).join(', '),'',
  '## 최종 사전','',...allWords.flatMap((w,i)=>{
    const r=revisions[i*2],other=revisions[i*2+1];
    return [`### ${i+1}. ${w.word} → ${r.word}`,'',r.meaning,'',r.example,'',
      `선택된 제안의 가상 평균: ${r.average.toFixed(2)}점. 다른 후보: ${other.word} (${other.average.toFixed(2)}점, 미선택).`,''];
  }), '## 표현 사용 맥락 참고','',
  '2025~2026년에 쓰인 유행 표현과 일상 비속어를 섞었습니다. 표현 선정에 참고했으며, 학생 설명·예문·평가는 새로 작성한 가상 자료입니다. 모든 단어가 2026년 11월에 새로 생겼거나 가장 유행한다는 뜻은 아닙니다.','',
  ...sources.map(([name,url])=>`- [${name}](${url})`),''];
await writeFile(new URL('dictionary.md',output),report.join('\n'),'utf8');
console.log(JSON.stringify(counts));
