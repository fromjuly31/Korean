'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const api = (name,...args) => AppApi.call(name,...args);
const tabs = [['collect','모으기'],['rate','평가하기'],['refine','순화하기'],['published','최종 사전']];
const state = {view:'home',admin:false,classId:'',tab:'collect',search:'',offset:0,data:null,request:0,saving:false,pickerRequest:0,homeSearch:'',homeOffset:0,classes:[],dialogVersion:0,homeVersion:0};
const score = (average,count) => Number(count) ? `★ ${Number(average).toFixed(1)} · ${Number(count)}명` : '아직 평가 전';
const roomLabel = room => `${String(room.grade).trim().replace(/\s*학년$/,'').trim()}학년 ${String(room.class_name).trim().replace(/\s*반$/,'').trim()}반`;
const roomName = room => `${room.school} · ${roomLabel(room)}`;
const icons = {
  classroom:'<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4M7 7h10M7 11h6"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',back:'<path d="m12 5-7 7 7 7M5 12h14"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  link:'<path d="m10 13 4-4m-7 6-1 1a4 4 0 0 0 6 6l4-4a4 4 0 0 0 0-6M17 9l1-1a4 4 0 0 0-6-6L8 6a4 4 0 0 0 0 6" transform="translate(0 1) scale(.9)"/>',
  book:'<path d="M12 5C8 2 4 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-2-1-6-2-10 1Zm0 0v15"/>',plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const empty = message => `<div class="empty">${icon('book')}<p>${esc(message)}</p></div>`;
const errorBox = message => `<div class="notice error" role="alert">${esc(message)}</div>`;
let toastTimer,disposeScene,opener;
function toast(message,error=false) {
  clearTimeout(toastTimer);const root=$('#toast');root.textContent=message;root.className=error?'error':'';root.hidden=false;
  toastTimer=setTimeout(()=>root.hidden=true,error?6500:3500);
}
function updateAdminButton() { $('#adminButton').textContent=state.admin?'교사 메뉴':'교사·관리자'; }
function pageButtons(total,size,offset,kind) {
  return total>size?`<nav class="pagination" aria-label="${kind==='home'?'학급':'표현'} 페이지"><button type="button" class="button" data-page="${kind}" data-offset="${Math.max(0,offset-size)}" ${offset===0?'disabled':''}>이전</button><span>${Math.floor(offset/size)+1} / ${Math.ceil(total/size)}</span><button type="button" class="button" data-page="${kind}" data-offset="${offset+size}" ${offset+size>=total?'disabled':''}>다음</button></nav>`:'';
}
function readDraft(key) { try{return JSON.parse(sessionStorage.getItem(key)) || {};}catch{return {};} }
function clearDraft(key) { try{sessionStorage.removeItem(key);}catch{} }
function closeModal() { if(!state.saving)$('#dialog').close(); }
function updateCounts(form) { form.querySelectorAll('[maxlength]:not([type=password])').forEach(input=>{const count=form.querySelector(`[data-count="${input.name}"]`);if(count)count.textContent=`${input.value.length}/${input.maxLength}`;}); }
function modal(title,body,action,onSubmit,options={}) {
  if(state.saving)return;
  if($('#dialog').open)$('#dialog').close();
  state.dialogVersion++;state.pickerRequest++;opener=document.activeElement;
  $('#dialogContent').innerHTML=`<form id="modalForm"><header class="dialog-head"><h2 id="dialogTitle">${esc(title)}</h2><button class="icon-button" type="button" data-close aria-label="닫기">${icon('close')}</button></header><div class="dialog-body">${body}<div id="modalError" class="dialog-error" role="alert" tabindex="-1"></div></div>${action?`<footer class="dialog-actions"><button class="button" type="button" data-close>취소</button><button class="button primary" id="modalSubmit" type="submit">${esc(action)}</button></footer>`:''}</form>`;
  const form=$('#modalForm');
  if(options.draftKey){const draft=readDraft(options.draftKey);for(const [name,value] of Object.entries(draft.values||{})){const input=form.elements.namedItem(name);if(input&&typeof value==='string')input.value=value;}}
  const saveDraft=()=>{updateCounts(form);if(options.draftKey){try{sessionStorage.setItem(options.draftKey,JSON.stringify({id:options.id,values:Object.fromEntries(new FormData(form))}));}catch{}}};
  form.addEventListener('input',event=>{if(event.target.setCustomValidity)event.target.setCustomValidity('');saveDraft();});form.addEventListener('change',saveDraft);updateCounts(form);
  form.querySelectorAll('[data-close]').forEach(button=>button.onclick=closeModal);
  const first=form.querySelector('input:not([readonly]),textarea,select');if(first)first.autofocus=true;
  document.body.classList.add('modal-open');$('#dialog').showModal();
  if(!first)$('#dialogTitle').setAttribute('tabindex','-1');
  form.onsubmit=async event=>{
    event.preventDefault();if(!onSubmit||state.saving)return;
    for(const input of form.querySelectorAll('[required]:not([type=password])')){if(!input.value.trim()){input.setCustomValidity('공백을 제외한 내용을 입력해 주세요.');input.reportValidity();return;}}
    state.saving=true;form.setAttribute('aria-busy','true');const button=$('#modalSubmit'),label=button.textContent;
    form.querySelectorAll('button').forEach(item=>item.disabled=true);button.textContent='저장 중…';$('#modalError').textContent='';
    try{await onSubmit(new FormData(form));if(options.draftKey)clearDraft(options.draftKey);}
    catch(error){if(form.isConnected){$('#modalError').textContent=error.message;$('#modalError').focus();}}
    finally{state.saving=false;form.removeAttribute('aria-busy');form.querySelectorAll('button').forEach(item=>item.disabled=false);button.textContent=label;}
  };
}
function field(label,name,placeholder,max=600,textarea=false) {
  return `<label class="field"><span class="field-label"><span>${esc(label)}</span><small data-count="${name}" aria-hidden="true">0/${max}</small></span>${textarea?`<textarea name="${name}" aria-label="${esc(label)}" required maxlength="${max}" placeholder="${esc(placeholder)}" rows="3"></textarea>`:`<input type="text" name="${name}" aria-label="${esc(label)}" required maxlength="${max}" placeholder="${esc(placeholder)}" autocomplete="off">`}</label>`;
}
function renderHome() {
  state.view='home';state.classId='';state.data=null;$('#app').removeAttribute('aria-busy');document.body.classList.add('home-mode');
  document.title='우리말 · 함께 만든 우리말 사전';
  $('#app').innerHTML=`<section class="home-hero" aria-labelledby="homeTitle"><div class="hero-copy"><p class="eyebrow"><span></span>OUR WORDS, ONE DICTIONARY</p><h1 id="homeTitle">우리의 말이 모여,<br><span class="highlight">하나의 사전으로.</span></h1><p class="hero-description">다른 반은 어떤 말을 만들었을까요?<br>함께 다듬은 우리말을 만나 보세요.</p><div class="hero-actions"><a class="dictionary-enter" href="#view=dictionary" aria-label="사전 입장"><span class="dictionary-enter-icon">${icon('book')}</span><span><strong>사전 입장</strong><small>모든 반의 완성된 사전 둘러보기</small></span>${icon('arrow')}</a><div class="classroom-actions"><button class="button" id="enterClassButton">우리 반 입장 ${icon('arrow')}</button><button class="text-button" id="createClassButton">${icon('plus')}새 사전 만들기</button></div></div>${!AppApi.configured()?'<p class="home-connection" role="status">데이터 저장소 연결을 준비하고 있습니다.</p>':''}</div><div class="home-art" aria-label="우리말 책과 단어들이 떠오르는 3D 공방" role="img"><div class="art-halo"></div><div class="art-orbit"></div><div id="scene"><img class="art-fallback" src="./assets/atelier-book.png" alt="" width="800" height="800" fetchpriority="high"></div><span class="art-spark" aria-hidden="true">✧</span></div><div class="home-meta"><span>함께 만든 말, 함께 보는 사전</span><div class="word-pills" aria-hidden="true"><span>말</span><span>마음</span><span>우리</span></div><button class="motion-control" type="button" aria-label="3D 움직임 멈추기" aria-pressed="false" hidden>Ⅱ</button></div></section>`;
  $('#enterClassButton').onclick=openClassPicker;$('#createClassButton').onclick=openCreateClass;
  const version=++state.homeVersion,mount=$('#scene');
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&!navigator.connection?.saveData){
    Promise.all([document.fonts.ready,import('./concepts/theme-studio/scene.js?v=atelier-20261107')]).then(([,module])=>{
      if(version!==state.homeVersion||!mount.isConnected)return;
      try{disposeScene=module.startScene('atelier');mount.classList.add('scene-ready');$('.motion-control').hidden=false;}catch{mount.querySelector('canvas')?.remove();}
    }).catch(()=>{});
  }
}
function openClassPicker() {
  modal('우리 반 찾기',`<div class="picker-toolbar"><div class="search-form"><input type="search" id="classSearch" aria-label="학교·학급 검색" value="${esc(state.homeSearch)}" placeholder="학교·학급 검색" maxlength="100"><button class="icon-button" type="button" id="searchClasses" aria-label="학급 검색">${icon('search')}</button></div><button type="button" class="icon-button" id="refreshHome" aria-label="학급 목록 새로고침">${icon('refresh')}</button></div><div id="homeNotice"></div><div id="classList" class="class-list">${empty('학급을 불러오는 중…')}</div><div id="homePages"></div><button class="text-button picker-create" type="button" id="pickerCreate">${icon('plus')}새 학급 만들기</button>`);
  $('#pickerCreate').onclick=openCreateClass;
  const search=()=>{state.homeSearch=$('#classSearch').value.trim();state.homeOffset=0;loadHome();};
  $('#searchClasses').onclick=search;$('#classSearch').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();search();}};$('#classSearch').addEventListener('search',search);$('#refreshHome').onclick=()=>loadHome();loadHome();
}
async function loadHome() {
  if(!$('#classList'))return;
  const request=++state.pickerRequest;$('#classList').setAttribute('aria-busy','true');
  try{
    const result=await api('listClasses',state.homeSearch,state.homeOffset);
    if(request!==state.pickerRequest||!$('#classList'))return;
    if(state.homeOffset&&state.homeOffset>=result.total){state.homeOffset=Math.max(0,Math.ceil(result.total/50)-1)*50;return loadHome();}
    state.classes=result.classes;$('#homeNotice').innerHTML='';
    $('#classList').innerHTML=result.classes.length?result.classes.map(room=>`<article class="class-card"><span class="class-symbol" aria-hidden="true">${icon('book')}</span><div><p class="school">${esc(room.school)}</p><h3>${esc(roomLabel(room))}</h3><span class="help">표현 ${Number(room.word_count)}개</span></div><button class="icon-button enter-room" type="button" data-enter="${room.id}" aria-label="${esc(roomName(room))} 입장">${icon('arrow')}</button></article>`).join(''):empty(state.homeSearch?'검색된 학급이 없습니다.':'아직 등록된 학급이 없어요. 첫 사전을 만들어 보세요.');
    $('#homePages').innerHTML=pageButtons(result.total,50,state.homeOffset,'home');bindShared();
  }catch(error){if(request!==state.pickerRequest||!$('#classList'))return;$('#homeNotice').innerHTML=errorBox(error.message);$('#classList').innerHTML='';$('#homePages').innerHTML='';}
  finally{if(request===state.pickerRequest)$('#classList')?.removeAttribute('aria-busy');}
}
function openCreateClass() {
  modal('우리 반 사전 만들기',`${field('학교','school','예: 한빛중학교',80)}<div class="field-row">${field('학년','grade','예: 2학년',20)}${field('반','className','예: 3반',40)}</div><p class="help">같은 학교·학급을 선택하면 함께 참여해요.</p>`,'만들고 입장하기',async form=>{const room=await api('createClass',Object.fromEntries(form));$('#dialog').close();openClass(room.id);});
}
function openClass(id) { if($('#dialog').open)$('#dialog').close();if(state.classId===id)loadClass();else location.hash='class='+id; }
function syncRoute(replace=false) {
  const params=new URLSearchParams({class:state.classId});if(state.tab!=='collect')params.set('stage',state.tab);if(state.search)params.set('q',state.search);if(state.offset)params.set('page',String(state.offset/25+1));history[replace?'replaceState':'pushState'](null,'','#'+params);
}
function setStage(tab) { if(!tabs.some(([key])=>key===tab))return;state.tab=tab;state.search='';state.offset=0;syncRoute();loadClass(); }
function navigate() {
  state.request++;state.homeVersion++;if(disposeScene){disposeScene();disposeScene=null;}
  if($('#dialog').open&&!state.saving)$('#dialog').close();
  const params=new URLSearchParams(location.hash.slice(1)),classId=params.get('class');
  if(params.get('view')==='dictionary'){openDictionaryRoute(params);return;}
  if(classId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(classId)){
    state.view='class';const changed=classId!==state.classId;state.classId=classId;state.tab=tabs.some(([key])=>key===params.get('stage'))?params.get('stage'):'collect';state.search=(params.get('q')||'').slice(0,100);
    const page=Number(params.get('page')||1);state.offset=Number.isInteger(page)?Math.max(0,Math.min(page-1,4000))*25:0;document.body.classList.remove('home-mode');
    if(changed||!state.data){state.data=null;$('#app').innerHTML=`<div class="initial-loading" role="status">${empty('우리 반 사전을 불러오는 중…')}</div>`;window.scrollTo(0,0);}loadClass();
  }else renderHome();
}
async function loadClass() {
  if(!state.classId)return;
  const request=++state.request,classId=state.classId,previousData=state.data,scroll=window.scrollY;
  const focused=document.activeElement,focusLabel=focused?.matches('[data-rating]')?focused.getAttribute('aria-label'):null;
  $('#app').setAttribute('aria-busy','true');$('#wordList')?.classList.add('updating');if($('#loadStatus'))$('#loadStatus').textContent='불러오는 중…';
  try{
    const result=await api('getClass',classId,state.tab==='published'?'published':'words',state.search,state.offset);
    if(request!==state.request||classId!==state.classId)return;
    if(state.offset&&state.offset>=result.total){state.offset=Math.max(0,Math.ceil(result.total/25)-1)*25;syncRoute(true);return loadClass();}
    state.data=result;state.renderedTab=state.tab;state.admin=result.isAdmin;updateAdminButton();renderClass();
    if(previousData){window.scrollTo(0,scroll);if(focusLabel){const target=[...document.querySelectorAll('[data-rating]')].find(button=>button.getAttribute('aria-label')===focusLabel);target?.focus({preventScroll:true});}}
  }catch(error){
    if(request!==state.request)return;
    if(previousData&&!/삭제되었거나 없는 학급/.test(error.message)){state.tab=state.renderedTab;state.data=previousData;syncRoute(true);renderClass();$('#classNotice').innerHTML=errorBox(error.message);return;}
    state.data=null;$('#app').innerHTML=`<section class="load-error"><a class="text-button" href="#">${icon('back')}처음으로</a>${errorBox(error.message)}<button class="button primary" id="retryClass">다시 불러오기</button></section>`;$('#retryClass').onclick=()=>loadClass();
  }finally{if(request===state.request){$('#app').removeAttribute('aria-busy');$('#wordList')?.classList.remove('updating');if($('#loadStatus'))$('#loadStatus').textContent='';}}
}
function renderClass() {
  const data=state.data,room=data.class,blocked=data.usage.writeBlocked;
  document.title=`${roomName(room)} · 우리말`;
  const titles={collect:['순화할 표현','우리의 말 한 조각을 모아요.'],rate:['친구의 표현 평가','바꾸면 좋을 말에 별점을 주세요.'],refine:['더 알맞은 우리말','새 표현을 제안하고 평가해요.'],published:['우리 반의 사전','평균 4점 이상 · 교사 선택']};
  const [title,description]=titles[state.tab];
  $('#app').innerHTML=`<div class="class-topline"><a class="text-button back-link" href="#">${icon('back')}처음으로</a>${state.admin?'<span class="admin-label">교사·관리자 모드</span>':''}<button class="button share-button" id="copyClassLink">${icon('link')}링크 복사</button></div><section class="class-heading"><p class="school">${esc(room.school)}</p><h1>${esc(roomLabel(room))}<span class="class-heading-suffix">의 우리말</span></h1><div class="stats" aria-label="학급 편찬 현황"><span>표현 <b>${Number(data.wordCount)}</b></span><span>순화어 <b>${Number(data.revisionCount)}</b></span><span>편찬 <b>${Number(data.publishedCount)}</b></span></div></section><nav class="tabs" aria-label="사전 편찬 단계">${tabs.map(([key,label],i)=>`<button class="tab ${state.tab===key?'active':''}" data-tab="${key}" aria-current="${state.tab===key?'step':'false'}"><span aria-hidden="true">0${i+1}</span>${label}</button>`).join('')}</nav><div id="classNotice">${blocked?'<div class="notice error" role="alert"><strong>무료 저장 용량 보호를 위해 새 저장을 중단했어요.</strong><span>기존 자료 조회와 관리자 학급 삭제는 가능합니다.</span></div>':''}</div><div class="stage-intro"><div><h2>${title}</h2><p>${description}</p></div>${state.tab==='collect'?`<button class="button primary" id="addWordButton" ${blocked?'disabled':''}>${icon('plus')}표현 등록</button>`:''}</div><div class="toolbar"><form id="wordSearchForm" class="search-form"><input type="search" id="wordSearch" aria-label="표현 검색" value="${esc(state.search)}" maxlength="100" placeholder="${state.tab==='published'?'원래 표현·순화어 검색':'표현·뜻 검색'}"><button class="icon-button" type="submit" aria-label="표현 검색 실행">${icon('search')}</button></form><span id="loadStatus" role="status"></span><button class="icon-button" id="refreshClass" aria-label="새로고침" title="친구의 최신 활동 불러오기">${icon('refresh')}</button></div><section class="word-grid" id="wordList" aria-label="${state.tab==='published'?'최종 사전':'등록된 표현'}">${state.tab==='published'?publishedHtml(data.published):wordsHtml(data.words,blocked)}</section>${pageButtons(data.total,25,state.offset,'class')}`;
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{if(button.dataset.tab!==state.tab)setStage(button.dataset.tab);});
  const search=()=>{state.search=$('#wordSearch').value.trim();state.offset=0;syncRoute(true);loadClass();};
  $('#wordSearchForm').onsubmit=event=>{event.preventDefault();search();};$('#wordSearch').addEventListener('search',search);$('#refreshClass').onclick=()=>loadClass();if($('#addWordButton'))$('#addWordButton').onclick=openAddWord;
  $('#copyClassLink').onclick=async()=>{const link=location.href.split('#')[0]+'#class='+state.classId;try{await navigator.clipboard.writeText(link);toast('학급 링크를 복사했어요.');}catch{modal('학급 링크',`<p class="help">주소를 복사해 친구와 공유하세요.</p><input type="text" class="link-input" value="${esc(link)}" readonly aria-label="학급 링크">`);$('.link-input').onclick=event=>event.currentTarget.select();$('.link-input').select();}};
  document.querySelectorAll('[data-add-revision]').forEach(button=>button.onclick=()=>openAddRevision(button.dataset.addRevision));document.querySelectorAll('[data-rating]').forEach(button=>button.onclick=()=>saveRating(button));document.querySelectorAll('[data-select-revision]').forEach(button=>button.onclick=()=>selectRevision(button));document.querySelectorAll('[data-next-stage]').forEach(button=>button.onclick=()=>setStage(button.dataset.nextStage));bindShared();
}
function stars(kind,item,blocked) {
  if(item.mine)return '<p class="help own-note">내 표현은 친구가 평가해요.</p>';
  return `<div class="stars" role="group" aria-label="${esc(item.word)} ${kind==='word'?'순화 필요성':'순화어'} 평가">${[1,2,3,4,5].map(n=>`<button class="star ${n<=Number(item.my_rating)?'on':''}" data-rating="${kind}" data-id="${item.id}" data-score="${n}" aria-label="${esc(item.word)} ${n}점" aria-pressed="${Number(item.my_rating)===n}" ${blocked?'disabled':''}>★</button>`).join('')}<span class="rating-label">${item.my_rating?`내 평가 ${item.my_rating}점`:'별을 눌러 평가'}</span></div>`;
}
function refinementHtml(word,blocked) {
  let prompt;
  if(!Number(word.rating_count))prompt=`<div class="stage-hint"><p>친구의 평가가 1개 이상 필요해요.</p><button type="button" class="text-button" data-next-stage="rate">평가하러 가기 ${icon('arrow')}</button></div>`;
  else if(word.revisions.some(item=>item.mine))prompt='<p class="help own-note">내 순화어가 등록되어 있어요.</p>';
  else prompt=`<button class="button revision-add" data-add-revision="${word.id}" ${blocked?'disabled':''}>${icon('plus')}순화어 제안</button>`;
  return prompt+word.revisions.map(item=>revisionHtml(item,blocked)).join('');
}
function wordsHtml(words,blocked) {
  if(!words.length)return empty(state.search?'검색된 표현이 없습니다.':state.tab==='collect'?'첫 번째 표현을 등록해 보세요.':'아직 표현이 없어요. 모으기에서 등록해 주세요.');
  return words.map(word=>`<article class="word-card" data-word="${word.id}"><div class="card-head"><span class="badge">${esc(word.category)}</span>${word.mine?'<span class="mine-label">내 표현</span>':''}</div><h3>${esc(word.word)}</h3><dl class="definitions"><div><dt>뜻</dt><dd>${esc(word.meaning)}</dd></div><div><dt>바꾸고 싶은 이유</dt><dd>${esc(word.reason)}</dd></div></dl><div class="rating-box"><span class="score">순화 필요성 ${score(word.average_rating,word.rating_count)}</span>${state.tab==='rate'?stars('word',word,blocked):''}</div>${state.tab==='collect'?`<button type="button" class="text-button next-link" data-next-stage="rate">친구 표현 평가하기 ${icon('arrow')}</button>`:''}${state.tab==='refine'?refinementHtml(word,blocked):''}</article>`).join('');
}
function revisionHtml(item,blocked) {
  const eligible=Number(item.average_rating)>=4&&Number(item.rating_count)>0;
  return `<section class="revision" data-revision="${item.id}"><div class="card-head"><span class="badge ${item.published?'gold':''}">${item.published?'편찬 완료':item.selected?'평점 충족 대기':'순화어 제안'}</span>${item.mine?'<span class="mine-label">내 제안</span>':''}</div><h3>${esc(item.word)}</h3><dl class="definitions"><div><dt>뜻</dt><dd>${esc(item.meaning)}</dd></div><div><dt>바꾼 이유</dt><dd>${esc(item.reason)}</dd></div><div><dt>예문</dt><dd>${esc(item.example)}</dd></div></dl><div class="rating-box"><span class="score">순화어 ${score(item.average_rating,item.rating_count)}</span>${stars('revision',item,blocked)}</div>${state.admin?`<div class="publication-action"><span class="help">${eligible?'편찬 기준 충족':'평균 4점 이상부터 편찬 가능'}</span><button class="button ${item.selected?'':'primary'}" data-select-revision="${item.id}" data-selected="${!item.selected}" ${blocked||(!item.selected&&!eligible)?'disabled':''}>${item.selected?'교사 선택 취소':'사전 편찬'}</button></div>`:eligible&&!item.published?'<p class="help own-note">교사가 선택하면 사전에 실려요.</p>':''}</section>`;
}
function publishedHtml(entries) {
  return entries.length?entries.map(item=>`<article class="published-card"><div class="card-head"><span class="badge gold">편찬 완료</span><span class="score">${score(item.average_rating,item.rating_count)}</span></div><p class="original">${esc(item.original_word)} ${icon('arrow')}</p><h2><span class="highlight">${esc(item.word)}</span></h2><dl class="definitions"><div><dt>뜻</dt><dd>${esc(item.meaning)}</dd></div><div><dt>예문</dt><dd>${esc(item.example)}</dd></div></dl></article>`).join(''):empty(state.search?'검색된 순화어가 없습니다.':'평균 4점 이상인 순화어를 교사가 선택하면 이곳에 편찬됩니다.');
}
function openAddWord() {
  const classId=state.classId,draftKey='dictionary-word-'+classId,id=readDraft(draftKey).id||crypto.randomUUID();
  modal('순화할 표현 등록',`${field('순화할 표현','word','예: 힐링',80)}<label class="field"><span class="field-label">표현 유형</span><select name="category">${['비속어','유행어','외래어','신조어','기타'].map(item=>`<option>${item}</option>`).join('')}</select></label>${field('이 표현의 뜻','meaning','어떤 뜻으로 쓰이나요?',600,true)}${field('순화가 필요한 이유','reason','왜 바꾸면 좋을까요?',600,true)}`,'등록 완료',async form=>{
    await api('addWord',classId,{id,...Object.fromEntries(form)});$('#dialog').close();toast('등록했어요. 친구의 평가를 기다려 주세요.');if(state.classId===classId){state.tab='rate';state.search='';state.offset=0;syncRoute(true);await loadClass();}
  },{draftKey,id});
}
function openAddRevision(wordId) {
  const original=state.data?.words.find(item=>item.id===wordId);if(!original)return;
  const classId=state.classId,draftKey='dictionary-revision-'+wordId,id=readDraft(draftKey).id||crypto.randomUUID();
  modal('순화어 제안하기',`<div class="original-word"><span>원래 표현</span><strong>${esc(original.word)}</strong></div>${field('새로 제안하는 순화어','word','더 알맞은 우리말',80)}${field('순화어의 뜻','meaning','어떤 의미를 담았나요?',600,true)}${field('바꾼 이유','reason','새 표현이 좋은 이유',600,true)}${field('순화어를 사용한 예문','example','새 표현으로 만든 한 문장',600,true)}`,'순화어 등록',async form=>{
    await api('addRevision',wordId,{id,...Object.fromEntries(form)});$('#dialog').close();toast('순화어를 등록했어요. 친구가 평가할 차례예요.');if(state.classId===classId)await loadClass();
  },{draftKey,id});
}
async function saveRating(button) {
  const group=button.closest('.stars'),classId=state.classId;group.querySelectorAll('button').forEach(item=>item.disabled=true);
  try{await api(button.dataset.rating==='word'?'rateWord':'rateRevision',button.dataset.id,Number(button.dataset.score));toast(`${button.dataset.score}점으로 평가했어요.`);if(state.classId===classId)await loadClass();}
  catch(error){toast(error.message,true);group.querySelectorAll('button').forEach(item=>item.disabled=false);}
}
async function selectRevision(button) {
  const classId=state.classId;button.disabled=true;
  try{await api('selectRevision',button.dataset.selectRevision,button.dataset.selected==='true');toast(button.dataset.selected==='true'?'우리 반 사전에 편찬했어요.':'교사 선택을 취소했어요.');if(state.classId===classId)await loadClass();}
  catch(error){toast(error.message,true);button.disabled=false;}
}
function openAdmin() {
  if(state.admin){
    modal('교사·관리자 메뉴',`<div class="menu-list"><button type="button" class="menu-item" id="usageButton">저장 용량 확인 ${icon('arrow')}</button>${state.data?`<button type="button" class="menu-item danger" id="deleteCurrentClass">학급 삭제 ${icon('arrow')}</button>`:''}<button type="button" class="menu-item" id="logoutAdmin">관리자 로그아웃 ${icon('arrow')}</button></div>`);
    $('#logoutAdmin').onclick=async event=>{event.currentTarget.disabled=true;try{await api('logoutAdmin');state.admin=false;$('#dialog').close();updateAdminButton();if(state.classId)await loadClass();toast('관리자에서 로그아웃했어요.');}catch(error){toast(error.message,true);if($('#logoutAdmin'))$('#logoutAdmin').disabled=false;}};
    if($('#deleteCurrentClass'))$('#deleteCurrentClass').onclick=()=>openDeleteClass(state.data.class);
    $('#usageButton').onclick=async event=>{event.currentTarget.disabled=true;try{const data=await api('getUsage');modal('데이터 저장 용량',`<p class="usage-number">${(data.databaseBytes/1000000).toFixed(1)}<small> / ${(data.writeLimitBytes/1000000).toFixed(0)} MB</small></p><div class="meter"><span style="width:${Math.min(100,data.databaseBytes/data.writeLimitBytes*100)}%"></span></div><p class="help">450 MB부터 새 저장을 보호합니다. 학급 삭제는 계속 가능해요.</p>${data.writeBlocked?errorBox('현재 새 저장이 중단되어 있습니다.'):''}`);}catch(error){toast(error.message,true);if($('#usageButton'))$('#usageButton').disabled=false;}};
    return;
  }
  modal('교사·관리자 입장','<label class="field"><span class="field-label">관리자 비밀번호</span><input name="password" type="password" required maxlength="100" autocomplete="current-password"></label>','관리자로 입장',async form=>{await api('loginAdmin',form.get('password'));state.admin=true;updateAdminButton();$('#dialog').close();toast('교사·관리자로 입장했어요.');if(state.classId)await loadClass();});
}
function openDeleteClass(room) {
  modal('학급 사전 삭제',`<p class="delete-room">${esc(roomName(room))}</p><div class="notice error">표현·별점·순화어·최종 사전이 모두 삭제됩니다. 되돌릴 수 없어요.</div><label class="field"><span class="field-label">삭제하려면 ‘삭제’를 입력해 주세요.</span><input type="text" name="confirm" required pattern="삭제" autocomplete="off"></label>`,'학급과 모든 자료 삭제',async()=>{await api('deleteClass',room.id);$('#dialog').close();toast('학급과 연결 자료를 삭제했어요.');if(state.classId===room.id)location.hash='';});
}
function openManual() {
  const guides={student:[['사전 둘러보기','메인의 사전 입장에서 모든 반의 완성된 말을 찾아보세요. 단어별 보기가 먼저 열리고, 반별로 보기에서 학급 사전도 볼 수 있어요.'],['우리 반 입장','학교·학급을 찾거나 새 사전을 만드세요.'],['표현 모으기','바꾸고 싶은 말과 뜻·이유를 적으세요.'],['친구의 표현 평가','다른 친구의 말에 순화 필요성 1~5점을 주세요.'],['순화어 제안·평가','평가가 모이면 새 표현·뜻·이유·예문을 제안하세요. 친구의 순화어도 평가해요.'],['우리 반 사전 확인','평균 4점 이상인 순화어를 교사가 선택하면 완성이에요.']],teacher:[['학급 준비','새 사전을 만들고 ‘링크 복사’로 학생에게 공유하세요.'],['교사 인증','우측 상단 ‘교사·관리자’에서 비밀번호를 입력하세요.'],['최종 편찬','‘순화하기’에서 평균 4점 이상·평가 1명 이상인 순화어의 ‘사전 편찬’을 누르세요.'],['편찬 확인·취소','‘최종 사전’에서 결과를 확인하세요. ‘순화하기’에서 교사 선택을 취소할 수 있어요.'],['관리·마무리','교사 메뉴에서 용량 확인·학급 삭제·로그아웃을 할 수 있어요.']]};
  modal('사용 설명서','<div class="manual-tabs" role="tablist" aria-label="사용자별 설명"><button type="button" role="tab" id="guideStudent" aria-selected="true" aria-controls="manualContent" data-guide="student">학생</button><button type="button" role="tab" id="guideTeacher" aria-selected="false" aria-controls="manualContent" data-guide="teacher" tabindex="-1">교사</button></div><div id="manualContent" role="tabpanel" aria-labelledby="guideStudent"></div>');
  const show=kind=>{document.querySelectorAll('[data-guide]').forEach(button=>{const active=button.dataset.guide===kind;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});$('#manualContent').setAttribute('aria-labelledby',kind==='student'?'guideStudent':'guideTeacher');$('#manualContent').innerHTML=`<ol class="manual-steps">${guides[kind].map(([title,body])=>`<li><strong>${title}</strong><p>${body}</p></li>`).join('')}</ol><div class="manual-note">${kind==='student'?'내 표현·제안은 다른 친구가 평가해요. 같은 표현의 내 순화어는 1개만 제안할 수 있어요.':'평점이 4점 미만이 되면 선택한 단어도 최종 사전에서 빠집니다.'}</div><p class="help manual-foot">친구의 새 활동은 ${icon('refresh')} 새로고침으로 확인해요.<br>같은 기기·브라우저에서 작성 기록이 이어집니다.</p>`;};
  document.querySelectorAll('[data-guide]').forEach(button=>{button.onclick=()=>show(button.dataset.guide);button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'student':event.key==='End'?'teacher':button.dataset.guide==='student'?'teacher':'student';show(target);$(`[data-guide="${target}"]`).focus();}};});show('student');
}
function bindShared() {
  document.querySelectorAll('[data-enter]').forEach(button=>button.onclick=()=>openClass(button.dataset.enter));
  document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{if(button.dataset.page==='home'){state.homeOffset=Number(button.dataset.offset);loadHome();$('.dialog-body').scrollTop=0;}else{state.offset=Number(button.dataset.offset);syncRoute();loadClass();$('.tabs')?.scrollIntoView({block:'start',behavior:'smooth'});}});
}
$('#adminButton').onclick=openAdmin;$('#manualButton').onclick=openManual;
$('.skip-link').onclick=event=>{event.preventDefault();$('#app').focus({preventScroll:true});};
$('#dialog').addEventListener('cancel',event=>{if(state.saving)event.preventDefault();});
$('#dialog').addEventListener('close',()=>{if($('#dialog').open)return;state.pickerRequest++;document.body.classList.remove('modal-open');if(opener?.isConnected)opener.focus({preventScroll:true});});
window.addEventListener('hashchange',navigate);
window.addEventListener('pageshow',event=>{if(event.persisted){if(state.view==='dictionary')loadDictionary();else if(state.classId)loadClass();else{if(disposeScene)disposeScene();disposeScene=null;renderHome();}}});
const visualHeight=()=>{const viewport=window.visualViewport,height=viewport?.height||innerHeight;document.documentElement.style.setProperty('--visual-height',`${height}px`);document.documentElement.style.setProperty('--visual-top',`${viewport?.offsetTop||0}px`);document.body.classList.toggle('keyboard-open',height<innerHeight-100);};
window.visualViewport?.addEventListener('resize',visualHeight);window.visualViewport?.addEventListener('scroll',visualHeight,{passive:true});visualHeight();navigate();
if(AppApi.configured())api('isAdmin').then(isAdmin=>{state.admin=isAdmin;updateAdminButton();}).catch(()=>{});
