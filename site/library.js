'use strict';
const libraryState = {tab:'words',classId:'',search:'',offset:0,data:null,error:''};
const libraryUrl = (tab='words',classId='',search='',offset=0) => {
  const params=new URLSearchParams({view:'dictionary'});
  if(tab==='classes')params.set('tab','classes');
  if(tab==='classes'&&classId)params.set('class',classId);
  if(search)params.set('q',search);
  if(offset)params.set('page',String(offset/24+1));
  return '#'+params;
};
function openDictionaryRoute(params) {
  state.view='dictionary';state.classId='';state.data=null;
  document.body.classList.remove('home-mode');
  libraryState.tab=params.get('tab')==='classes'?'classes':'words';
  const classId=params.get('class')||'';
  libraryState.classId=libraryState.tab==='classes'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(classId)?classId:'';
  libraryState.search=(params.get('q')||'').slice(0,100);
  const page=Number(params.get('page')||1);
  libraryState.offset=Number.isInteger(page)?Math.max(0,Math.min(page-1,4166))*24:0;
  libraryState.data=null;libraryState.error='';
  document.title='모두의 사전 · 우리말 사전 편찬';
  renderDictionary();loadDictionary();
}
async function loadDictionary() {
  const request=++state.request;
  $('#app').setAttribute('aria-busy','true');
  $('#libraryStatus').textContent='사전을 불러오는 중…';
  try {
    const mode=libraryState.tab==='classes'&&!libraryState.classId?'classes':'words';
    const result=await api('browseDictionary',mode,libraryState.search,libraryState.classId,libraryState.offset);
    if(request!==state.request)return;
    if(libraryState.offset&&libraryState.offset>=result.total){
      libraryState.offset=Math.max(0,Math.ceil(result.total/24)-1)*24;
      history.replaceState(null,'',libraryUrl(libraryState.tab,libraryState.classId,libraryState.search,libraryState.offset));
      return loadDictionary();
    }
    libraryState.data=result;libraryState.error='';renderDictionary();startLive();
  } catch(error) {
    if(request!==state.request)return;
    libraryState.error=error.message;renderDictionary();
  } finally {if(request===state.request)$('#app').removeAttribute('aria-busy');}
}
function libraryEntries(entries) {
  return entries.map(item=>`<article class="published-card library-entry"><div class="card-head"><span class="badge">${esc(item.category)}</span><span class="score">${score(item.average_rating,item.rating_count)}</span></div><p class="original">${esc(item.original_word)} ${icon('arrow')}</p><h2><span class="highlight">${esc(item.word)}</span></h2><dl class="definitions"><div><dt>뜻</dt><dd>${esc(item.meaning)}</dd></div><div><dt>예문</dt><dd>${esc(item.example)}</dd></div></dl>${publicationFooter(item,item)}</article>`).join('');
}
function libraryClasses(classes) {
  return classes.map(room=>`<a class="library-class" href="${libraryUrl('classes',room.id)}" aria-label="${esc(roomName(room))} 사전 보기"><span class="class-symbol">${icon('book')}</span><div><p class="school">함께 만든 사전</p><h2>${esc(roomLabel(room))}</h2><p class="help">완성된 말 <strong>${Number(room.published_count)}</strong>개</p></div><span class="library-class-arrow">${icon('arrow')}</span></a>`).join('');
}
function renderDictionary() {
  const focused=document.activeElement?.id;
  const {data,tab,classId,search,offset,error}=libraryState;
  const classList=tab==='classes'&&!classId;
  const placeholder=classList?'사전 제목으로 찾아보기':'원래 표현이나 순화어로 찾아보기';
  const count=data?Number(data.total):0;
  const entries=data?(classList?data.classes:data.entries):[];
  const title=classList?'함께 만든 사전들':data?.class?roomLabel(data.class):'단어로 만나는 우리말';
  const emptyText=search?(classList?'검색된 사전이 없습니다. 다른 제목으로 찾아보세요.':'검색된 단어가 없습니다. 원래 표현이나 순화어로 다시 찾아보세요.'):
    classId?'이 사전에는 현재 편찬된 단어가 없습니다.':classList?'아직 완성된 사전이 없어요. 첫 번째 사전을 기다리고 있어요.':'아직 편찬된 단어가 없어요. 함께 다듬은 말이 이곳에 모여요.';
  $('#app').innerHTML=`<div class="class-topline"><a class="text-button back-link" href="#">${icon('back')}처음으로</a><button class="text-button library-participate" id="libraryJoin">사전 만들기에 참여 ${icon('arrow')}</button></div><section class="library-heading"><div class="library-emblem">${icon('book')}</div><div><p class="eyebrow">OUR WORDS, ONE DICTIONARY</p><h1>모두의 <span class="highlight">사전</span></h1><p class="library-description">함께 다듬은 말에서, 새로운 우리말을 발견해 보세요.</p></div><div class="library-stats" aria-label="전체 사전 현황"><span><b>${data?Number(data.publishedCount):'—'}</b>개의 말</span><span><b>${data?Number(data.classCount):'—'}</b>개의 사전</span></div></section><div class="library-tabs" role="tablist" aria-label="사전 보기 방식"><button id="libraryWordsTab" type="button" role="tab" aria-selected="${tab==='words'}" aria-controls="libraryPanel" tabindex="${tab==='words'?0:-1}" data-library-tab="words">${icon('book')}단어별 보기</button><button id="libraryClassesTab" type="button" role="tab" aria-selected="${tab==='classes'}" aria-controls="libraryPanel" tabindex="${tab==='classes'?0:-1}" data-library-tab="classes">${icon('classroom')}사전별 보기</button></div><section id="libraryPanel" role="tabpanel" aria-labelledby="${tab==='words'?'libraryWordsTab':'libraryClassesTab'}">${classId?`<a class="text-button library-back" href="${libraryUrl('classes')}">${icon('back')}전체 사전 보기</a>`:''}<div class="library-section-title"><div><h2>${esc(title)}</h2></div><span class="help">${classList?'사전 제목순':'순화어 가나다순'}</span></div><div class="toolbar library-toolbar"><form id="librarySearchForm" class="search-form"><input type="search" id="librarySearch" aria-label="${classList?'사전 제목 검색':'사전 단어 검색'}" value="${esc(search)}" maxlength="100" placeholder="${placeholder}"><button type="submit" class="icon-button" aria-label="사전 검색 실행">${icon('search')}</button></form><button id="refreshLibrary" class="icon-button" type="button" aria-label="사전 새로고침">${icon('refresh')}</button></div><div id="libraryStatus" class="library-status" role="status">${data?`${classList?'사전':'단어'} ${count}개${search?' · “'+esc(search)+'” 검색 결과':''}`:''}</div>${error?errorBox(error)+`<button type="button" class="button" id="retryLibrary">다시 불러오기</button>`:''}<div class="${classList?'library-class-grid':'word-grid'}" id="libraryResults">${entries.length?(classList?libraryClasses(entries):libraryEntries(entries)):data?empty(emptyText):error?'':empty('완성된 사전을 불러오고 있어요.')}</div>${data?pageButtons(count,24,offset,'library'):''}</section>`;
  $('#libraryJoin').onclick=openClassPicker;
  $('#refreshLibrary').onclick=loadDictionary;
  if($('#retryLibrary'))$('#retryLibrary').onclick=loadDictionary;
  document.querySelectorAll('[data-library-tab]').forEach(button=>{
    button.onclick=()=>{if(button.dataset.libraryTab!==tab)location.hash=libraryUrl(button.dataset.libraryTab);};
    button.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();
      const target=event.key==='Home'?'words':event.key==='End'?'classes':tab==='words'?'classes':'words';
      const next=$(`[data-library-tab="${target}"]`);next.focus();next.click();
    };
  });
  const runSearch=()=>{
    libraryState.search=$('#librarySearch').value.trim();libraryState.offset=0;
    libraryState.data=null;libraryState.error='';
    history.replaceState(null,'',libraryUrl(tab,classId,libraryState.search));renderDictionary();loadDictionary();
  };
  $('#librarySearchForm').onsubmit=event=>{event.preventDefault();runSearch();};
  $('#librarySearch').addEventListener('search',runSearch);
  document.querySelectorAll('[data-page="library"]').forEach(button=>button.onclick=()=>{
    location.hash=libraryUrl(tab,classId,search,Number(button.dataset.offset));
    $('.library-tabs').scrollIntoView({block:'start',behavior:'smooth'});
  });
  if(focused&&document.getElementById(focused))document.getElementById(focused).focus({preventScroll:true});
}
