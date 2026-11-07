'use strict';
const studentMode=document.body.dataset.mode==='student';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const api = (name,...args) => AppApi.call(name,...args);
const tabs = [['collect','모으기'],['rate','평가하기'],['refine','순화하기'],['approval','승인하기'],['published','최종 사전']];
const state = {view:'home',admin:false,teacher:false,nickname:'',studentToken:'',studentJoin:'',studentLinks:{},classId:'',tab:'collect',approval:'pending',search:'',offset:0,data:null,request:0,saving:false,pickerRequest:0,homeSearch:'',homeOffset:0,classes:[],dialogVersion:0,homeVersion:0};
const score = (average,count) => Number(count) ? `★ ${Number(average).toFixed(1)} · ${Number(count)}명` : '아직 평가 전';
const roomLabel = room => room.title || '우리말 사전';
const roomName = roomLabel;
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
function updateAdminButton() { const button=$('#adminButton');if(button)button.textContent=state.admin?'관리자 메뉴':'관리자 로그인'; }
function pageButtons(total,size,offset,kind) {
  return total>size?`<nav class="pagination" aria-label="${kind==='home'?'사전':'표현'} 페이지"><button type="button" class="button" data-page="${kind}" data-offset="${Math.max(0,offset-size)}" ${offset===0?'disabled':''}>이전</button><span>${Math.floor(offset/size)+1} / ${Math.ceil(total/size)}</span><button type="button" class="button" data-page="${kind}" data-offset="${offset+size}" ${offset+size>=total?'disabled':''}>다음</button></nav>`:'';
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
  if(options.draftKey){const draft=readDraft(options.draftKey);draft.values={...options.defaults,...draft.values};for(const [name,value] of Object.entries(draft.values||{})){const input=form.elements.namedItem(name);if(input&&typeof value==='string')input.value=value;}}
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
  stopLive();if(studentMode){renderStudentError();return;}
  state.view='home';state.classId='';state.data=null;$('#app').removeAttribute('aria-busy');document.body.classList.add('home-mode');
  document.title='우리말 사전 편찬';
  $('#app').innerHTML=`<section class="home-hero" aria-labelledby="homeTitle"><div class="hero-copy"><p class="eyebrow"><span></span>OUR WORDS, ONE DICTIONARY</p><h1 id="homeTitle">우리의 말이 모여,<br><span class="highlight">하나의 사전으로.</span></h1><p class="hero-description">우리는 어떤 말을 만들었을까요?<br>함께 다듬은 우리말을 만나 보세요.</p><div class="hero-actions"><a class="dictionary-enter" href="#view=dictionary" aria-label="사전 입장"><span class="dictionary-enter-icon">${icon('book')}</span><span><strong>사전 입장</strong><small>모두가 완성한 사전 둘러보기</small></span>${icon('arrow')}</a><div class="classroom-actions"><button class="button" id="enterClassButton">사전 열기 ${icon('arrow')}</button><button class="text-button" id="createClassButton">${icon('plus')}새 사전 만들기</button></div></div>${!AppApi.configured()?'<p class="home-connection" role="status">데이터 저장소 연결을 준비하고 있습니다.</p>':''}</div><div class="home-art" aria-label="우리말 책과 단어들이 떠오르는 3D 공방" role="img"><div class="art-halo"></div><div class="art-orbit"></div><div id="scene"><img class="art-fallback" src="./assets/atelier-book.png" alt="" width="800" height="800" fetchpriority="high"></div><span class="art-spark" aria-hidden="true">✧</span></div><div class="home-meta"><span>함께 만든 말, 함께 보는 사전</span><div class="word-pills" aria-hidden="true"><span>말</span><span>마음</span><span>우리</span></div><button class="motion-control" type="button" aria-label="3D 움직임 멈추기" aria-pressed="false" hidden>Ⅱ</button></div></section>`;
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
  modal('참여할 사전 찾기',`<div class="picker-toolbar"><div class="search-form"><input type="search" id="classSearch" aria-label="사전 제목 검색" value="${esc(state.homeSearch)}" placeholder="사전 제목 검색" maxlength="100"><button class="icon-button" type="button" id="searchClasses" aria-label="사전 검색">${icon('search')}</button></div><button type="button" class="icon-button" id="refreshHome" aria-label="사전 목록 새로고침">${icon('refresh')}</button></div><div id="homeNotice"></div><div id="classList" class="class-list">${empty('사전을 불러오는 중…')}</div><div id="homePages"></div><button class="text-button picker-create" type="button" id="pickerCreate">${icon('plus')}새 사전 만들기</button>`);
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
    $('#classList').innerHTML=result.classes.length?result.classes.map(room=>`<article class="class-card"><span class="class-symbol" aria-hidden="true">${icon('book')}</span><div><p class="school">함께 만드는 사전</p><h3>${esc(roomLabel(room))}</h3><span class="help">표현 ${Number(room.word_count)}개</span></div><button class="icon-button enter-room" type="button" data-enter="${room.id}" aria-label="${esc(roomName(room))} 입장">${icon('arrow')}</button></article>`).join(''):empty(state.homeSearch?'검색된 사전이 없습니다.':'아직 등록된 사전이 없어요. 첫 사전을 만들어 보세요.');
    $('#homePages').innerHTML=pageButtons(result.total,50,state.homeOffset,'home');bindShared();
  }catch(error){if(request!==state.pickerRequest||!$('#classList'))return;$('#homeNotice').innerHTML=errorBox(error.message);$('#classList').innerHTML='';$('#homePages').innerHTML='';}
  finally{if(request===state.pickerRequest)$('#classList')?.removeAttribute('aria-busy');}
}
function openCreateClass() {
  const draftKey='dictionary-create',id=readDraft(draftKey).id||crypto.randomUUID();
  modal('새 사전 만들기',`${field('사전 제목','title','예: 1-7 파이팅',80)}<p class="help">우리만의 사전 제목을 자유롭게 지어 주세요. 만든 뒤 링크를 공유하면 함께 참여할 수 있어요.</p>`,'만들고 입장하기',async form=>{const room=await api('createClass',{id,...Object.fromEntries(form)});$('#dialog').close();openClass(room.id);},{draftKey,id});
}
function openClass(id) { if($('#dialog').open)$('#dialog').close();if(state.classId===id)loadClass();else location.hash='class='+id; }
function syncRoute(replace=false) {
  const params=new URLSearchParams({class:state.classId});if(state.tab!=='collect')params.set('stage',state.tab);if(state.tab==='approval'&&state.approval==='approved')params.set('approval','approved');if(studentMode)params.set('join',state.studentToken);if(state.search)params.set('q',state.search);if(state.offset)params.set('page',String(state.offset/25+1));history[replace?'replaceState':'pushState'](null,'','#'+params);
}
function setStage(tab) { if(!tabs.some(([key])=>key===tab))return;state.tab=tab;state.approval='pending';state.search='';state.offset=0;if(studentMode)window.scrollTo(0,0);syncRoute();loadClass(); }
function navigate() {
  state.request++;state.homeVersion++;if(disposeScene){disposeScene();disposeScene=null;}
  if($('#dialog').open&&!state.saving)$('#dialog').close();
  const params=new URLSearchParams(location.hash.slice(1)),classId=params.get('class');
  if(params.get('view')==='dictionary'){if(studentMode){renderStudentError();return;}openDictionaryRoute(params);return;}
  if(classId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(classId)){
    if(studentMode){state.studentToken=params.get('join')||'';if(!/^[0-9a-f-]{36}$/i.test(state.studentToken)){renderStudentError();return;}}
    state.view='class';const changed=classId!==state.classId;state.classId=classId;state.tab=tabs.some(([key])=>key===params.get('stage'))?params.get('stage'):'collect';state.search=(params.get('q')||'').slice(0,100);state.approval=params.get('approval')==='approved'?'approved':'pending';if(studentMode&&!studentStages.some(([key])=>key===state.tab))state.tab='collect';
    const page=Number(params.get('page')||1);state.offset=Number.isInteger(page)?Math.max(0,Math.min(page-1,4000))*25:0;document.body.classList.remove('home-mode');
    if(changed||!state.data){state.data=null;$('#app').innerHTML=`<div class="initial-loading" role="status">${empty('우리 사전을 불러오는 중…')}</div>`;window.scrollTo(0,0);}loadClass();
  }else renderHome();
}
async function loadClass({live=false}={}) {
  if(!state.classId)return;
  const request=++state.request,classId=state.classId,previousData=state.data,scroll=window.scrollY;
  const focused=document.activeElement,focusLabel=focused?.matches('[data-rating]')?focused.getAttribute('aria-label'):null;
  const approvalFocus=focused?.matches('[data-approval],[data-tab]')?focused.id:null;
  const searchDraft=focused?.id==='wordSearch'?{value:focused.value,start:focused.selectionStart,end:focused.selectionEnd}:null;
  const focusItemId=focused?.dataset?.id,openGroups=[...document.querySelectorAll('[data-word] details[open]')].map(el=>el.closest('[data-word]').dataset.word);
  $('#app').setAttribute('aria-busy','true');$('#wordList')?.classList.add('updating');if($('#loadStatus'))$('#loadStatus').textContent='불러오는 중…';
  try{
    if(studentMode&&state.studentJoin!==classId+state.studentToken){const entry=await api('enterStudent',classId,state.studentToken);if(request!==state.request)return;if(entry.needsNickname){renderStudentWelcome(entry.class);return;}state.nickname=entry.nickname;state.studentJoin=classId+state.studentToken;}
    const result=await api('getClass',classId,studentMode&&state.tab==='collect'?'student_collect':state.tab==='approval'?'approval_'+state.approval:state.tab==='refine'?'refine':state.tab==='published'?'published':state.tab==='rate'?'rate':'words',state.search,state.offset);
    if(request!==state.request||classId!==state.classId)return;
    if(state.offset&&state.offset>=result.total){state.offset=Math.max(0,Math.ceil(result.total/25)-1)*25;syncRoute(true);return loadClass();}
    state.data=result;state.renderedTab=state.tab;state.renderedApproval=state.approval;state.admin=!studentMode&&result.isAdmin;state.teacher=!studentMode&&result.canApprove;updateAdminButton();if(!(live&&studentMode&&state.tab==='collect'&&previousData))renderClass();startLive(classId);
    if(approvalFocus)document.getElementById(approvalFocus)?.focus({preventScroll:true});
    openGroups.forEach(id=>{const details=document.querySelector(`[data-word="${id}"] details`);if(details)details.open=true;});
    if(searchDraft&&$('#wordSearch')){const input=$('#wordSearch');input.value=searchDraft.value;input.focus({preventScroll:true});try{input.setSelectionRange(searchDraft.start,searchDraft.end);}catch{}}
    if(previousData){window.scrollTo(0,scroll);if(focusLabel){const target=[...document.querySelectorAll('[data-rating]')].find(button=>button.getAttribute('aria-label')===focusLabel&&button.dataset.id===focusItemId);target?.focus({preventScroll:true});}}
  }catch(error){
    if(request!==state.request)return;
    if(previousData&&!/삭제되었거나 없는 사전/.test(error.message)){state.tab=state.renderedTab;state.approval=state.renderedApproval;state.data=previousData;syncRoute(true);renderClass();$('#classNotice').innerHTML=errorBox(error.message);return;}
    state.data=null;$('#app').innerHTML=`<section class="load-error"><a class="text-button" href="#">${icon('back')}처음으로</a>${errorBox(error.message)}<button class="button primary" id="retryClass">다시 불러오기</button></section>`;$('#retryClass').onclick=()=>loadClass();
  }finally{if(request===state.request){$('#app').removeAttribute('aria-busy');$('#wordList')?.classList.remove('updating');if($('#loadStatus'))$('#loadStatus').textContent='';}}
}
function renderClass() {
  if(studentMode){renderStudentClass();return;}
  const data=state.data,room=data.class,blocked=data.usage.writeBlocked;
  document.title=`${roomName(room)} · 우리말 사전 편찬`;
  const titles={collect:['순화할 표현','우리의 말 한 조각을 모아요.'],rate:['친구의 표현 평가','바꾸면 좋을 말에 별점을 주세요.'],refine:['더 알맞은 우리말','같은 표현 아래 모인 순화어를 제안하고 평가해요.'],approval:['교사의 승인','단어별 최고 평점 후보 · 공동 1위는 모두 표시'],published:['함께 만든 사전','교사가 승인한 순화어']};
  const [title,description]=titles[state.tab];
  $('#app').innerHTML=`<div class="class-topline"><a class="text-button back-link" href="#">${icon('back')}처음으로</a>${state.admin?'<span class="admin-label">관리자 모드</span>':''}<button class="button share-button" id="copyClassLink">${icon('link')}교사용 링크</button></div><section class="class-heading"><p class="school">함께 만드는 사전</p><h1>${esc(roomLabel(room))}</h1><div class="stats" aria-label="사전 편찬 현황"><span>표현 <b>${Number(data.wordCount)}</b></span><span>순화어 <b>${Number(data.revisionCount)}</b></span><span>편찬 <b>${Number(data.publishedCount)}</b></span></div></section><nav class="tabs" aria-label="사전 편찬 단계">${tabs.map(([key,label],i)=>`<button class="tab ${state.tab===key?'active':''}" data-tab="${key}" aria-current="${state.tab===key?'step':'false'}"><span aria-hidden="true">0${i+1}</span>${label}</button>`).join('')}</nav><div id="classNotice">${blocked?'<div class="notice error" role="alert"><strong>무료 저장 용량 보호를 위해 새 저장을 중단했어요.</strong><span>기존 자료 조회와 관리자 사전 삭제는 가능합니다.</span></div>':''}</div><div class="stage-intro"><div><h2>${title}</h2><p>${description}</p></div></div>${teacherShareHtml()}${activityHtml(data)}${state.tab==='approval'?approvalControlsHtml(data):''}<div class="toolbar"><form id="wordSearchForm" class="search-form"><input type="search" id="wordSearch" aria-label="표현 검색" value="${esc(state.search)}" maxlength="100" placeholder="${['refine','approval','published'].includes(state.tab)?'원래 표현·순화어 검색':'표현·뜻 검색'}"><button class="icon-button" type="submit" aria-label="표현 검색 실행">${icon('search')}</button></form><span id="loadStatus" role="status"></span><button class="icon-button" id="refreshClass" aria-label="새로고침" title="친구의 최신 활동 불러오기">${icon('refresh')}</button></div><section class="word-grid" id="wordList" aria-label="${state.tab==='published'?'최종 사전':state.tab==='approval'?'승인 후보':'등록된 표현'}">${state.tab==='published'?publishedHtml(data.published):state.tab==='approval'?data.approvalLocked?'':groupedWordsHtml(data.words,blocked,true):state.tab==='refine'?groupedWordsHtml(data.words,blocked):wordsHtml(data.words,blocked)}</section>${pageButtons(data.total,25,state.offset,'class')}`;
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{if(button.dataset.tab!==state.tab)setStage(button.dataset.tab);});
  bindApprovalControls();bindAdminActions();bindTeacherShare();
  const search=()=>{state.search=$('#wordSearch').value.trim();state.offset=0;syncRoute(true);loadClass();};
  $('#wordSearchForm').onsubmit=event=>{event.preventDefault();search();};$('#wordSearch').addEventListener('search',search);$('#refreshClass').onclick=()=>loadClass();if($('#addWordButton'))$('#addWordButton').onclick=openAddWord;
  $('#copyClassLink').onclick=async()=>{const link=location.href.split('#')[0]+'#class='+state.classId;try{await navigator.clipboard.writeText(link);toast('사전 링크를 복사했어요.');}catch{modal('사전 링크',`<p class="help">주소를 복사해 친구와 공유하세요.</p><input type="text" class="link-input" value="${esc(link)}" readonly aria-label="사전 링크">`);$('.link-input').onclick=event=>event.currentTarget.select();$('.link-input').select();}};
  document.querySelectorAll('[data-add-revision]').forEach(button=>button.onclick=()=>openAddRevision(button.dataset.addRevision));document.querySelectorAll('[data-rating]').forEach(button=>button.onclick=()=>saveRating(button));document.querySelectorAll('[data-select-revision]').forEach(button=>button.onclick=()=>selectRevision(button));document.querySelectorAll('[data-next-stage]').forEach(button=>button.onclick=()=>setStage(button.dataset.nextStage));bindShared();
}
function stars(kind,item,blocked) {
  if(!studentMode)return '';
  if(item.mine)return '<p class="help own-note">내 표현은 친구가 평가해요.</p>';
  return `<div class="stars" role="group" aria-label="${esc(item.word)} ${kind==='word'?'순화 필요성':'순화어'} 평가">${[1,2,3,4,5].map(n=>`<button class="star ${n<=Number(item.my_rating)?'on':''}" data-rating="${kind}" data-id="${item.id}" data-score="${n}" aria-label="${esc(item.word)} ${n}점" aria-pressed="${Number(item.my_rating)===n}" ${blocked?'disabled':''}>★</button>`).join('')}<span class="rating-label">${item.my_rating?`내 평가 ${item.my_rating}점`:'별을 눌러 평가'}</span></div>`;
}
function refinementHtml(word,blocked) {
  let prompt;
  if(!Number(word.rating_count))prompt=`<div class="stage-hint"><p>친구의 평가가 1개 이상 필요해요.</p><button type="button" class="text-button" data-next-stage="rate">평가하러 가기 ${icon('arrow')}</button></div>`;
  else if(word.revisions.some(item=>item.mine))prompt='<p class="help own-note">내 순화어가 등록되어 있어요.</p>';
  else prompt=`<button class="button revision-add" data-add-revision="${word.id}" ${blocked?'disabled':''}>${icon('plus')}순화어 제안</button>`;
  return (studentMode?prompt:'')+word.revisions.map(item=>revisionHtml(item,blocked)).join('');
}
function wordsHtml(words,blocked) {
  if(!words.length)return empty(state.search?'검색된 표현이 없습니다.':state.tab==='collect'?'첫 번째 표현을 등록해 보세요.':'아직 표현이 없어요. 모으기에서 등록해 주세요.');
  return words.map(word=>`<article class="word-card" data-word="${word.id}"><div class="card-head"><span class="badge">${esc(word.category)}</span>${word.mine?'<span class="mine-label">내 표현</span>':''}</div><h3>${esc(word.word)}</h3>${adminActionsHtml('word',word)}<dl class="definitions"><div><dt>뜻</dt><dd>${esc(word.meaning)}</dd></div><div><dt>바꾸고 싶은 이유</dt><dd>${esc(word.reason)}</dd></div></dl><p class="contributor">작성 · ${esc(word.author_name||'익명 작성자')}</p><div class="rating-box"><span class="score">순화 필요성 ${score(word.average_rating,word.rating_count)}</span>${state.tab==='rate'?stars('word',word,blocked):''}</div>${state.tab==='collect'?`<button type="button" class="text-button next-link" data-next-stage="rate">친구 표현 평가하기 ${icon('arrow')}</button>`:''}${state.tab==='refine'?refinementHtml(word,blocked):''}</article>`).join('');
}
function revisionHtml(item,blocked,approval=false) {
  const status=item.selected?'편찬 완료':item.top_rated?'승인 대기중':'순화어 제안';
  return `<section class="revision" data-revision="${item.id}"><div class="card-head"><span class="badge ${item.selected?'gold':''}">${status}</span>${item.mine?'<span class="mine-label">내 제안</span>':''}</div><h3>${esc(item.word)}</h3>${adminActionsHtml('revision',item)}<dl class="definitions"><div><dt>뜻</dt><dd>${esc(item.meaning)}</dd></div><div><dt>바꾼 이유</dt><dd>${esc(item.reason)}</dd></div><div><dt>예문</dt><dd>${esc(item.example)}</dd></div></dl><p class="contributor">제안 · ${esc(item.author_name||'익명 작성자')}</p><div class="rating-box"><span class="score">순화어 ${score(item.average_rating,item.rating_count)}</span>${approval?'':stars('revision',item,blocked)}</div>${approval&&state.teacher?`<div class="publication-action"><span class="help">${item.selected?'최종 사전에 실렸어요.':'승인하면 바로 최종 사전에 실려요.'}</span><button class="button ${item.selected?'':'primary'}" data-select-revision="${item.id}" data-selected="${!item.selected}" ${blocked?'disabled':''}>${item.selected?'승인 취소':'승인'}</button></div>`:item.top_rated&&!item.selected?'<p class="help own-note">교사의 승인을 기다리고 있어요.</p>':''}</section>`;
}
function groupedWordsHtml(words,blocked,approval=false) {
  if(!words.length)return empty(state.search?'검색된 표현이 없습니다.':approval?state.approval==='approved'?'아직 승인 완료된 순화어가 없습니다.':'승인 대기중인 순화어가 없습니다. 별점 평가가 모이면 단어별 최고 평점 후보가 이곳에 표시됩니다.':'아직 표현이 없어요. 모으기에서 등록해 주세요.');
  return words.map(word=>`<article class="word-card word-group" data-word="${word.id}"><div class="card-head"><span class="badge">${esc(word.category)}</span><span class="help">${approval?'순화어 '+word.revisions.length+'개':'표현 '+Number(word.original_count)+'건 · 순화어 '+word.revisions.length+'개'}</span></div><h3>${esc(word.word)}</h3>${Number(word.original_count)===1?adminActionsHtml('word',word):''}${approval?'':Number(word.original_count)>1?`<details class="original-submissions"><summary>친구들이 적은 뜻과 이유 ${Number(word.original_count)}건</summary>${word.originals.map(original=>`<div class="original-submission"><p class="contributor">작성 · ${esc(original.author_name)}</p>${adminActionsHtml('word',original)}<dl class="definitions"><div><dt>뜻</dt><dd>${esc(original.meaning)}</dd></div><div><dt>바꾸고 싶은 이유</dt><dd>${esc(original.reason)}</dd></div></dl></div>`).join('')}</details>`:`<dl class="definitions"><div><dt>뜻</dt><dd>${esc(word.meaning)}</dd></div><div><dt>바꾸고 싶은 이유</dt><dd>${esc(word.reason)}</dd></div></dl><p class="contributor">작성 · ${esc(word.author_name)}</p>`}${approval?word.revisions.map(item=>revisionHtml(item,blocked,true)).join(''):refinementHtml(word,blocked)}</article>`).join('');
}
function approvalControlsHtml(data) {
  if(data.approvalLocked)return '<div class="notice approval-locked"><strong>학생 전용 접속에서는 승인할 수 없습니다.</strong><p>교사 화면에서 승인할 수 있어요.</p></div>';
  return `<div class="approval-tabs" role="tablist" aria-label="승인 상태"><button type="button" role="tab" id="approvalPending" aria-controls="wordList" aria-selected="${state.approval==='pending'}" tabindex="${state.approval==='pending'?0:-1}" data-approval="pending">승인 대기중 <span>${Number(data.pendingCount)}</span></button><button type="button" role="tab" id="approvalApproved" aria-controls="wordList" aria-selected="${state.approval==='approved'}" tabindex="${state.approval==='approved'?0:-1}" data-approval="approved">승인 완료 <span>${Number(data.approvedCount)}</span></button></div>`;
}
function bindApprovalControls() {
  if($('#approvalLogin'))$('#approvalLogin').onclick=openAdmin;
  if(state.tab!=='approval'||state.data.approvalLocked)return;
  $('#wordList').setAttribute('role','tabpanel');$('#wordList').setAttribute('aria-labelledby',state.approval==='pending'?'approvalPending':'approvalApproved');
  document.querySelectorAll('[data-approval]').forEach(button=>{
    button.onclick=()=>{if(button.dataset.approval===state.approval)return;state.approval=button.dataset.approval;state.search='';state.offset=0;syncRoute();loadClass();};
    button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const target=event.key==='Home'?'pending':event.key==='End'?'approved':state.approval==='pending'?'approved':'pending';const next=$(`[data-approval="${target}"]`);next.focus();next.click();};
  });
}
function publicationFooter(item,room) {
  const nickname=item.author_name||'익명 편찬자';
  return `<a class="entry-class" href="${libraryUrl('classes',room.class_id||room.id)}" aria-label="${esc(roomName(room))} 사전 보기 · 작성자 ${esc(nickname)}"><span class="entry-class-icon">${icon('book')}</span><span><small>함께 만든 사전</small><strong>${esc(roomLabel(room))} <span class="entry-author" aria-label="작성자 ${esc(nickname)}">· ${esc(nickname)}</span></strong></span>${icon('arrow')}</a>`;
}
function publishedHtml(entries) {
  return entries.length?entries.map(item=>`<article class="published-card"><div class="card-head"><span class="badge gold">편찬 완료</span><span class="score">${score(item.average_rating,item.rating_count)}</span></div><p class="original">${esc(item.original_word)} ${icon('arrow')}</p><h2><span class="highlight">${esc(item.word)}</span></h2>${adminActionsHtml('revision',item)}<dl class="definitions"><div><dt>뜻</dt><dd>${esc(item.meaning)}</dd></div><div><dt>예문</dt><dd>${esc(item.example)}</dd></div></dl>${publicationFooter(item,state.data.class)}</article>`).join(''):empty(state.search?'검색된 순화어가 없습니다.':'교사가 승인한 순화어가 이곳에 편찬됩니다.');
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
  modal('순화어 제안하기',`<div class="original-word"><span>원래 표현</span><strong>${esc(original.word)}</strong></div>${field('새로 제안하는 순화어','word','더 알맞은 우리말',80)}${field('순화어의 뜻','meaning','어떤 의미를 담았나요?',600,true)}${field('바꾼 이유','reason','새 표현이 좋은 이유',600,true)}${field('순화어를 사용한 예문','example','새 표현으로 만든 한 문장',600,true)}<p class="help student-proposal-author">작성자 · ${esc(state.nickname)}</p>`,'순화어 등록',async form=>{
    await api('addRevision',wordId,{id,...Object.fromEntries(form),nickname:state.nickname});$('#dialog').close();toast('순화어를 등록했어요. 친구가 평가할 차례예요.');if(state.classId===classId)await loadClass();
  },{draftKey,id,defaults:{nickname:readNickname()}});
}
function readNickname(){try{return localStorage.getItem('dictionary-nickname')||'';}catch{return '';}}
async function saveRating(button) {
  const group=button.closest('.stars'),classId=state.classId;group.querySelectorAll('button').forEach(item=>item.disabled=true);
  try{await api(button.dataset.rating==='word'?'rateWord':'rateRevision',button.dataset.id,Number(button.dataset.score));toast(`${button.dataset.score}점으로 평가했어요.`);if(state.classId===classId)await loadClass();}
  catch(error){toast(error.message,true);group.querySelectorAll('button').forEach(item=>item.disabled=false);}
}
async function selectRevision(button) {
  const classId=state.classId;button.disabled=true;
  try{await api('selectRevision',button.dataset.selectRevision,button.dataset.selected==='true');toast(button.dataset.selected==='true'?'승인했습니다. 편찬 완료로 변경했어요.':'승인을 취소했어요.');if(state.classId===classId)await loadClass();}
  catch(error){toast(error.message,true);button.disabled=false;}
}
function openAdmin() {
  if(studentMode)return;
  if(state.admin){
    modal('관리자 메뉴',`<div class="menu-list"><button type="button" class="menu-item" id="usageButton">저장 용량 확인 ${icon('arrow')}</button>${state.data?`<button type="button" class="menu-item danger" id="deleteCurrentClass">사전 삭제 ${icon('arrow')}</button>`:''}<button type="button" class="menu-item" id="logoutAdmin">관리자 로그아웃 ${icon('arrow')}</button></div>`);
    $('#logoutAdmin').onclick=async event=>{event.currentTarget.disabled=true;try{await api('logoutAdmin');state.admin=false;$('#dialog').close();updateAdminButton();if(state.classId)await loadClass();toast('관리자에서 로그아웃했어요.');}catch(error){toast(error.message,true);if($('#logoutAdmin'))$('#logoutAdmin').disabled=false;}};
    if($('#deleteCurrentClass'))$('#deleteCurrentClass').onclick=()=>openDeleteClass(state.data.class);
    $('#usageButton').onclick=async event=>{event.currentTarget.disabled=true;try{const data=await api('getUsage');modal('데이터 저장 용량',`<p class="usage-number">${(data.databaseBytes/1000000).toFixed(1)}<small> / ${(data.writeLimitBytes/1000000).toFixed(0)} MB</small></p><div class="meter"><span style="width:${Math.min(100,data.databaseBytes/data.writeLimitBytes*100)}%"></span></div><p class="help">450 MB부터 새 저장을 보호합니다. 사전 삭제는 계속 가능해요.</p>${data.writeBlocked?errorBox('현재 새 저장이 중단되어 있습니다.'):''}`);}catch(error){toast(error.message,true);if($('#usageButton'))$('#usageButton').disabled=false;}};
    return;
  }
  modal('관리자 로그인','<label class="field"><span class="field-label">관리자 비밀번호</span><input name="password" type="password" required maxlength="100" autocomplete="current-password"></label>','로그인',async form=>{await api('loginAdmin',form.get('password'));state.admin=true;updateAdminButton();$('#dialog').close();toast('관리자로 로그인했어요.');if(state.classId)await loadClass();});
}
function openDeleteClass(room) {
  modal('사전 삭제',`<p class="delete-room">${esc(roomName(room))}</p><div class="notice error">표현·별점·순화어·최종 사전이 모두 삭제됩니다. 되돌릴 수 없어요.</div><label class="field"><span class="field-label">삭제하려면 ‘삭제’를 입력해 주세요.</span><input type="text" name="confirm" required pattern="삭제" autocomplete="off"></label>`,'사전과 모든 자료 삭제',async()=>{await api('deleteClass',room.id);$('#dialog').close();toast('사전과 연결 자료를 삭제했어요.');if(state.classId===room.id)location.hash='';});
}
function openManual() {
  const guides={"student":[["학생 입장","교사가 공유한 QR이나 학생 링크로 입장하고, 처음에는 닉네임을 정하세요."],["표현 등록","바꾸고 싶은 말과 뜻·이유를 적고 등록하세요."],["평가하기","친구가 모은 표현에 순화 필요성 1~5점을 주세요."],["순화하기","평가가 모이면 순화어·뜻·이유·예문을 제안하세요. 입장 때 정한 닉네임이 자동으로 표시돼요. 친구의 순화어도 평가해요."],["자유롭게 이동","상단의 세 단계를 자유롭게 오갈 수 있어요. 작성하던 표현과 순화어는 같은 탭에서 이어 쓸 수 있어요."]],"teacher":[["사전 준비","새 사전을 만들고 모으기·평가하기·순화하기의 학생 입장 QR이나 링크를 공유하세요."],["실시간 응답","학생 응답 현황에서 입장 학생 수와 표현·별점·순화어 응답을 실시간으로 확인하세요."],["사전 승인","로그인 없이 ‘승인하기’에서 단어별 최고 평점 후보를 승인하세요. 공동 1위도 모두 표시돼요."],["편찬 확인·취소","최종 사전에서 결과를 확인하고, ‘승인 완료’에서 승인을 취소할 수 있어요."],["관리자 로그인","수정·삭제가 필요할 때 관리자 비밀번호로 로그인하세요. 단어 카드의 수정·삭제 버튼과 관리자 메뉴를 사용할 수 있어요."]]};
  modal('사용 설명서','<div class="manual-tabs" role="tablist" aria-label="사용자별 설명"><button type="button" role="tab" id="guideStudent" aria-selected="true" aria-controls="manualContent" data-guide="student">학생</button><button type="button" role="tab" id="guideTeacher" aria-selected="false" aria-controls="manualContent" data-guide="teacher" tabindex="-1">교사</button></div><div id="manualContent" role="tabpanel" aria-labelledby="guideStudent"></div>');
  const show=kind=>{document.querySelectorAll('[data-guide]').forEach(button=>{const active=button.dataset.guide===kind;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});$('#manualContent').setAttribute('aria-labelledby',kind==='student'?'guideStudent':'guideTeacher');$('#manualContent').innerHTML=`<ol class="manual-steps">${guides[kind].map(([title,body])=>`<li><strong>${title}</strong><p>${body}</p></li>`).join('')}</ol><div class="manual-note">${kind==='student'?'내 표현·제안은 다른 친구가 평가해요. 같은 표현의 내 순화어는 1개만 제안할 수 있어요.':'승인한 순화어는 이후 별점이 바뀌어도 최종 사전에 유지됩니다.'}</div><p class="help manual-foot">친구의 새 활동은 ${icon('refresh')} 새로고침으로 확인해요.<br>같은 기기·브라우저에서 작성 기록이 이어집니다.</p>`;};
  document.querySelectorAll('[data-guide]').forEach(button=>{button.onclick=()=>show(button.dataset.guide);button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'student':event.key==='End'?'teacher':button.dataset.guide==='student'?'teacher':'student';show(target);$(`[data-guide="${target}"]`).focus();}};});show('student');
}
function bindShared() {
  document.querySelectorAll('[data-enter]').forEach(button=>button.onclick=()=>openClass(button.dataset.enter));
  document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{if(button.dataset.page==='home'){state.homeOffset=Number(button.dataset.offset);loadHome();$('.dialog-body').scrollTop=0;}else{state.offset=Number(button.dataset.offset);syncRoute();loadClass();$('.tabs')?.scrollIntoView({block:'start',behavior:'smooth'});}});
}
if($('#adminButton'))$('#adminButton').onclick=openAdmin;if($('#manualButton'))$('#manualButton').onclick=openManual;
$('.skip-link').onclick=event=>{event.preventDefault();$('#app').focus({preventScroll:true});};
$('#dialog').addEventListener('cancel',event=>{if(state.saving)event.preventDefault();});
$('#dialog').addEventListener('close',()=>{if($('#dialog').open)return;state.pickerRequest++;document.body.classList.remove('modal-open');if(opener?.isConnected)opener.focus({preventScroll:true});});
window.addEventListener('hashchange',navigate);
window.addEventListener('pageshow',event=>{if(event.persisted){if(state.view==='dictionary')loadDictionary();else if(state.classId)loadClass();else{if(disposeScene)disposeScene();disposeScene=null;renderHome();}}});
const visualHeight=()=>{const viewport=window.visualViewport,height=viewport?.height||innerHeight;document.documentElement.style.setProperty('--visual-height',`${height}px`);document.documentElement.style.setProperty('--visual-top',`${viewport?.offsetTop||0}px`);document.body.classList.toggle('keyboard-open',height<innerHeight-100);};
window.visualViewport?.addEventListener('resize',visualHeight);window.visualViewport?.addEventListener('scroll',visualHeight,{passive:true});visualHeight();navigate();
if(AppApi.configured()&&!studentMode)api('isAdmin').then(isAdmin=>{state.admin=isAdmin;updateAdminButton();}).catch(()=>{});
