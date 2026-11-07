'use strict';
const studentStages=[['collect','표현 등록'],['rate','평가하기'],['refine','순화하기']];
const liveState={topic:'',dispose:null,timer:null,fallback:null,status:'CONNECTING',last:0};
function studentEntryUrl(token,stage=state.tab){
  const url=new URL('./student.html',location.href);url.hash=new URLSearchParams({class:state.classId,stage:studentStages.some(([key])=>key===stage)?stage:'collect',join:token});return url.href;
}
function qrSvg(url){const code=qrcode(0,'M');code.addData(url);code.make();return code.createSvgTag({cellSize:4,margin:16,scalable:true});}
function teacherShareHtml(){return studentStages.some(([key])=>key===state.tab)?'<aside class="student-share" id="studentShare" aria-label="학생 입장 QR과 링크"><p class="help">학생 입장 링크를 준비하고 있어요.</p></aside>':'';}
async function bindTeacherShare(){
  const target=$('#studentShare');if(!target)return;
  const classId=state.classId,stage=state.tab;
  try{
    const result=state.studentLinks[classId]||await api('studentLink',classId);state.studentLinks[classId]=result;
    if(!target.isConnected||state.classId!==classId||state.tab!==stage)return;
    const url=studentEntryUrl(result.token,stage),label=studentStages.find(([key])=>key===stage)[1];
    target.innerHTML=`<button class="student-qr" id="expandStudentQr" type="button" aria-label="학생 입장 QR 크게 보기">${qrSvg(url)}</button><div class="student-share-copy"><p class="eyebrow">STUDENT ENTRY</p><h3>학생 입장 · ${esc(label)}</h3><p class="help">QR을 찍거나 링크로 입장하면 학생 전용 화면이 열려요.<br>학생은 세 단계를 자유롭게 오갈 수 있어요.</p><div class="student-link-row"><input id="studentLink" aria-label="학생 입장 링크" value="${esc(url)}" readonly><button class="button" id="copyStudentLink" type="button">링크 복사</button></div><button class="text-button" id="studentQrButton" type="button">QR 크게 보기 ${icon('arrow')}</button></div>`;
    const expand=()=>modal('학생 입장 QR',`<div class="qr-presentation">${qrSvg(url)}<h3>${esc(state.data.class.title)}</h3><p>${esc(label)}로 입장 · 입장 후 단계 이동 가능</p><a href="${esc(url)}" target="_blank" rel="noopener">학생 화면 미리보기 ${icon('arrow')}</a></div>`);
    $('#expandStudentQr').onclick=expand;$('#studentQrButton').onclick=expand;
    $('#copyStudentLink').onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('학생 입장 링크를 복사했어요.');}catch{$('#studentLink').focus();$('#studentLink').select();toast('선택된 링크를 복사해 주세요.');}};
  }catch(error){if(target.isConnected){target.innerHTML=errorBox(error.message)+'<button class="button" type="button" id="retryStudentLink">다시 불러오기</button>';$('#retryStudentLink').onclick=bindTeacherShare;}}
}
function activityHtml(data){
  const activity=data.activity||{};
  return `<section class="response-overview" aria-label="학생 응답 현황"><div class="response-overview-head"><h2>학생 응답 현황</h2>${liveIndicatorHtml()}</div><div class="response-counts"><div><span>입장 학생</span><strong>${Number(activity.students||0)}<small>명</small></strong></div><div><span>표현 등록</span><strong>${Number(data.wordCount)}<small>건</small></strong></div><div><span>별점 평가</span><strong>${Number(activity.wordRatings||0)+Number(activity.revisionRatings||0)}<small>건</small></strong></div><div><span>순화어 제안</span><strong>${Number(data.revisionCount)}<small>건</small></strong></div></div><p class="response-authors">표현 등록 ${Number(activity.wordAuthors||0)}명 · 평가 참여 ${Number(activity.raters||0)}명 · 순화어 제안 ${Number(activity.revisionAuthors||0)}명</p></section>`;
}
function liveIndicatorHtml(){return '<span class="live-indicator" data-live-status role="status">실시간 연결 중</span>';}
function updateLiveIndicator(){document.querySelectorAll('[data-live-status]').forEach(el=>{el.classList.toggle('connected',liveState.status==='SUBSCRIBED');el.textContent=liveState.status==='SUBSCRIBED'?'실시간 연동 중':liveState.status==='UNAVAILABLE'?'최신 응답 확인 가능':'연결 재시도 중';});}
function stopLive(){if(liveState.dispose)liveState.dispose();clearTimeout(liveState.timer);clearInterval(liveState.fallback);Object.assign(liveState,{topic:'',dispose:null,timer:null,fallback:null,status:'CONNECTING'});}
function startLive(classId=null){
  const topic=classId||'public';if(liveState.topic===topic){updateLiveIndicator();return;}
  stopLive();liveState.topic=topic;
  const refresh=()=>{
    clearTimeout(liveState.timer);
    liveState.timer=setTimeout(()=>{
      if(document.hidden)return;
      if(state.saving||$('#app').getAttribute('aria-busy')==='true'){refresh();return;}
      liveState.last=Date.now();if(state.view==='dictionary')loadDictionary();else if(state.classId)loadClass({live:true});
    },Math.max(350,1000-(Date.now()-liveState.last)));
  };
  liveState.dispose=AppApi.watch(classId,change=>{
    const kind=change?.payload?.kind;
    if(studentMode&&state.tab==='rate'&&['dictionary_revisions','dictionary_revision_ratings','dictionary_student_sessions'].includes(kind))return;
    if(studentMode&&kind==='dictionary_student_sessions')return;
    refresh();
  },status=>{
    if(liveState.topic!==topic)return;
    liveState.status=status;updateLiveIndicator();
    clearInterval(liveState.fallback);
    if(!['SUBSCRIBED','UNAVAILABLE','CLOSED'].includes(status))liveState.fallback=setInterval(()=>{if(!document.hidden)refresh();},5000);
  });
  updateLiveIndicator();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(state.view==='class')loadClass({live:true});else if(state.view==='dictionary')loadDictionary();}});

function renderStudentError(message='교사가 공유한 QR이나 학생 입장 링크로 들어와 주세요.'){
  stopLive();
  state.view='student-error';state.classId='';state.data=null;document.body.classList.remove('home-mode');$('#app').removeAttribute('aria-busy');
  $('#app').innerHTML=`<section class="student-invalid">${icon('book')}<h1>학생 입장</h1><p>${esc(message)}</p></section>`;
}
function renderStudentWelcome(room){
  state.view='student-welcome';state.data=null;
  $('#app').innerHTML=`<section class="student-welcome"><p class="eyebrow">STUDENT ENTRY</p><h1>${esc(room.title)}</h1><p class="help">함께 사용할 닉네임을 정하고 입장해 주세요.<br>등록한 표현과 순화어에 이 이름이 자동으로 표시돼요.</p><form id="studentNicknameForm">${field('닉네임','nickname','예: 민트초코',20)}<p id="nicknameError" class="dialog-error" role="alert"></p><button class="button primary" type="submit">입장하기 ${icon('arrow')}</button></form></section>`;
  const form=$('#studentNicknameForm');form.oninput=event=>{event.target.setCustomValidity?.('');updateCounts(form);};
  form.onsubmit=async event=>{
    event.preventDefault();const nickname=form.elements.nickname.value.trim();if(!nickname){form.elements.nickname.setCustomValidity('닉네임을 입력해 주세요.');form.elements.nickname.reportValidity();return;}
    const button=form.querySelector('button');button.disabled=true;button.textContent='입장 중…';$('#nicknameError').textContent='';
    try{const entry=await api('enterStudent',state.classId,state.studentToken,nickname);state.nickname=entry.nickname;state.studentJoin=state.classId+state.studentToken;state.view='class';await loadClass();}
    catch(error){if(form.isConnected)$('#nicknameError').textContent=error.message;}
    finally{if(button.isConnected){button.disabled=false;button.textContent='입장하기';}}
  };
}
function studentWordFormHtml(blocked){return `<form id="studentWordForm" class="student-word-form">${field('순화할 표현','word','예: 힐링',80)}<label class="field"><span class="field-label">표현 유형</span><select name="category" aria-label="표현 유형">${['비속어','유행어','외래어','신조어','기타'].map(item=>`<option>${item}</option>`).join('')}</select></label>${field('이 표현의 뜻','meaning','어떤 뜻으로 쓰이나요?',600,true)}${field('순화가 필요한 이유','reason','왜 바꾸면 좋을까요?',600,true)}<p class="dialog-error" id="studentFormError" role="alert"></p><div class="student-submit"><button class="button primary" type="submit" ${blocked?'disabled':''}>표현 등록</button></div></form>`;}
function renderStudentClass(){
  const data=state.data,blocked=data.usage.writeBlocked,stage=studentStages.find(([key])=>key===state.tab);
  document.title=`${stage[1]} · ${data.class.title} · 우리말 사전 편찬`;
  const descriptions={collect:'바꾸고 싶은 말과 뜻, 이유를 적어 주세요.',rate:'친구가 모은 표현에 순화 필요성 별점을 주세요.',refine:'같은 표현 아래 순화어를 제안하고 별점을 주세요.'};
  $('#app').innerHTML=`<header class="student-class-heading"><p>학생 참여 · ${esc(state.nickname)}</p><h1>${esc(data.class.title)}</h1>${liveIndicatorHtml()}</header><nav class="student-tabs" aria-label="학생 활동 단계">${studentStages.map(([key,label],i)=>`<button type="button" id="studentStage-${key}" data-tab="${key}" class="${state.tab===key?'active':''}" aria-current="${state.tab===key?'step':'false'}"><small>0${i+1}</small><span>${label}</span></button>`).join('')}</nav><section class="student-stage-intro"><p>지금은 ${stage[1]} 단계</p><h2>${stage[1]}</h2><span>${descriptions[state.tab]}</span></section><div id="classNotice">${blocked?errorBox('저장 용량 보호로 새 저장을 잠시 중단했어요. 교사에게 알려 주세요.'):''}</div>${state.tab==='collect'?studentWordFormHtml(blocked):`<div class="toolbar"><form id="wordSearchForm" class="search-form"><input type="search" id="wordSearch" aria-label="표현 검색" value="${esc(state.search)}" maxlength="100" placeholder="${state.tab==='refine'?'원래 표현·순화어 검색':'표현·뜻 검색'}"><button class="icon-button" type="submit" aria-label="표현 검색 실행">${icon('search')}</button></form><button class="icon-button" id="refreshClass" type="button" aria-label="새로고침">${icon('refresh')}</button></div><section class="word-grid" id="wordList">${state.tab==='refine'?groupedWordsHtml(data.words,blocked):wordsHtml(data.words,blocked)}</section>${pageButtons(data.total,25,state.offset,'class')}`}`;
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{if(button.dataset.tab!==state.tab)setStage(button.dataset.tab);});
  if(state.tab==='collect')bindStudentWordForm();
  else{
    const search=()=>{state.search=$('#wordSearch').value.trim();state.offset=0;syncRoute(true);loadClass();};
    $('#wordSearchForm').onsubmit=event=>{event.preventDefault();search();};$('#wordSearch').addEventListener('search',search);$('#refreshClass').onclick=()=>loadClass();
    document.querySelectorAll('[data-add-revision]').forEach(button=>button.onclick=()=>openAddRevision(button.dataset.addRevision));document.querySelectorAll('[data-rating]').forEach(button=>button.onclick=()=>saveRating(button));document.querySelectorAll('[data-next-stage]').forEach(button=>button.onclick=()=>setStage(button.dataset.nextStage));bindShared();
  }
}
function bindStudentWordForm(){
  const form=$('#studentWordForm'),classId=state.classId,key='dictionary-word-'+classId,draft=readDraft(key);
  let id=draft.id||crypto.randomUUID();
  for(const [name,value] of Object.entries(draft.values||{})){const input=form.elements.namedItem(name);if(input&&typeof value==='string')input.value=value;}
  const save=()=>{updateCounts(form);try{sessionStorage.setItem(key,JSON.stringify({id,values:Object.fromEntries(new FormData(form))}));}catch{}};
  form.oninput=event=>{event.target.setCustomValidity?.('');save();};form.onchange=save;updateCounts(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(state.saving)return;
    for(const input of form.querySelectorAll('[required]'))if(!input.value.trim()){input.setCustomValidity('공백을 제외한 내용을 입력해 주세요.');input.reportValidity();return;}
    save();state.saving=true;const button=form.querySelector('[type=submit]');button.disabled=true;button.textContent='등록 중…';$('#studentFormError').textContent='';
    try{await api('addWord',classId,{id,...Object.fromEntries(new FormData(form))});clearDraft(key);id=crypto.randomUUID();form.reset();updateCounts(form);toast('등록했어요. 평가하기와 순화하기도 자유롭게 참여해 보세요.');if(state.classId===classId)await loadClass({live:true});}
    catch(error){if(form.isConnected)$('#studentFormError').textContent=error.message;}
    finally{state.saving=false;if(button.isConnected){button.disabled=state.data?.usage.writeBlocked||false;button.textContent='표현 등록';}}
  };
}

function adminActionsHtml(kind,item){return state.admin&&!studentMode?`<div class="record-actions"><button class="text-button" type="button" data-edit-item="${item.id}" data-kind="${kind}" aria-label="${esc(item.word)} ${kind==='word'?'표현':'순화어'} 수정">수정</button><button class="text-button danger" type="button" data-delete-item="${item.id}" data-kind="${kind}" aria-label="${esc(item.word)} ${kind==='word'?'표현':'순화어'} 삭제">삭제</button></div>`:'';}
function bindAdminActions(){
  document.querySelectorAll('[data-edit-item]').forEach(button=>button.onclick=()=>openAdminEdit(button.dataset.kind,button.dataset.editItem));
  document.querySelectorAll('[data-delete-item]').forEach(button=>button.onclick=()=>openAdminDelete(button.dataset.kind,button.dataset.deleteItem));
}
async function openAdminEdit(kind,id){
  try{
    const item=await api('adminGetItem',kind,id),classId=state.classId;
    const body=kind==='word'?`${field('순화할 표현','word','표현',80)}<label class="field"><span class="field-label">표현 유형</span><select name="category" aria-label="표현 유형">${['비속어','유행어','외래어','신조어','기타'].map(value=>`<option>${value}</option>`).join('')}</select></label>${field('이 표현의 뜻','meaning','뜻',600,true)}${field('순화가 필요한 이유','reason','이유',600,true)}`:`${field('순화어','word','순화어',80)}${field('순화어의 뜻','meaning','뜻',600,true)}${field('바꾼 이유','reason','이유',600,true)}${field('순화어를 사용한 예문','example','예문',600,true)}${field('닉네임','nickname','닉네임',20)}`;
    modal(kind==='word'?'표현 수정':'순화어 수정',body+'<p class="help">수정 내용은 편찬된 사전에도 반영돼요.</p>','수정 저장',async form=>{await api(kind==='word'?'adminUpdateWord':'adminUpdateRevision',id,Object.fromEntries(form));$('#dialog').close();toast('수정했어요.');if(state.classId===classId)await loadClass();});
    for(const [name,value] of Object.entries(item)){const input=$('#modalForm').elements.namedItem(name);if(input&&typeof value==='string')input.value=value;}updateCounts($('#modalForm'));
  }catch(error){toast(error.message,true);}
}
async function openAdminDelete(kind,id){
  try{
    const item=await api('adminGetItem',kind,id),classId=state.classId;
    modal(kind==='word'?'표현 삭제':'순화어 삭제',`<p class="delete-room">${esc(item.word)}</p><p class="help">${kind==='word'?`이 표현과 연결된 순화어 ${Number(item.revision_count)}개, 별점도 함께 삭제돼요.`:'이 순화어와 별점이 삭제되고 최종 사전에서도 빠져요.'} 되돌릴 수 없어요.</p><label class="field"><span class="field-label">삭제하려면 ‘삭제’를 입력해 주세요.</span><input name="confirm" required pattern="삭제" autocomplete="off"></label>`,'삭제하기',async()=>{await api('adminDeleteItem',kind,id);$('#dialog').close();toast('삭제했어요.');if(state.classId===classId)await loadClass();});
  }catch(error){toast(error.message,true);}
}
