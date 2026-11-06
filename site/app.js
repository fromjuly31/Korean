'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const api = (name, ...args) => AppApi.call(name, ...args);
const state = { admin: false, classId: '', tab: 'collect', search: '', offset: 0, homeSearch: '', homeOffset: 0, classes: [], data: null, request: 0, saving: false };
const tabs = [['collect', '모으기'], ['rate', '평가하기'], ['refine', '순화하기'], ['published', '최종 사전']];
const score = (average, count) => Number(count) ? `★ ${Number(average).toFixed(1)} · ${Number(count)}명` : '아직 평가 전';
const roomName = room => `${room.school} · ${room.grade} ${room.class_name}`;
let toastTimer;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const root = $('#toast'); root.textContent = message; root.className = error ? 'error' : ''; root.hidden = false;
  toastTimer = setTimeout(() => { root.hidden = true; }, 4500);
}
function updateAdminButton() { $('#adminButton').textContent = state.admin ? '관리 중 · 메뉴' : '교사·관리자'; }
function empty(message) { return `<div class="empty">${esc(message)}</div>`; }
function errorBox(message) { return `<div class="notice error" role="alert">${esc(message)}</div>`; }
function pageButtons(total, size, offset, kind) {
  return total > size ? `<div class="pagination"><button class="button" data-page="${kind}" data-offset="${Math.max(0, offset - size)}" ${offset === 0 ? 'disabled' : ''}>이전</button><span>${Math.floor(offset / size) + 1} / ${Math.ceil(total / size)}</span><button class="button" data-page="${kind}" data-offset="${offset + size}" ${offset + size >= total ? 'disabled' : ''}>다음</button></div>` : '';
}
function modal(title, body, action, onSubmit) {
  $('#dialogContent').innerHTML = `<form id="modalForm"><div class="dialog-head"><h2>${esc(title)}</h2><button class="close-button" type="button" data-close aria-label="닫기">×</button></div><div class="dialog-body">${body}<div id="modalError" class="dialog-error" role="alert"></div></div><div class="dialog-actions"><button class="button" type="button" data-close>취소</button>${action ? `<button class="button primary" id="modalSubmit" type="submit">${esc(action)}</button>` : ''}</div></form>`;
  $('#dialog').showModal();
  $('#dialog').querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  $('#modalForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!onSubmit || state.saving) return;
    state.saving = true;
    const form = event.currentTarget;
    const button = $('#modalSubmit');
    const label = button.textContent;
    form.querySelectorAll('button').forEach(item => { item.disabled = true; });
    button.textContent = '처리 중...'; $('#modalError').textContent = '';
    try { await onSubmit(new FormData(form)); }
    catch (error) { if ($('#modalError')) $('#modalError').textContent = error.message; }
    finally { state.saving = false; form.querySelectorAll('button').forEach(item => { item.disabled = false; }); button.textContent = label; }
  });
}
function closeModal() { if (!state.saving) $('#dialog').close(); }
function field(label, name, placeholder, max = 600, textarea = false) {
  return `<label class="field"><span>${esc(label)}</span>${textarea ? `<textarea name="${name}" required maxlength="${max}" placeholder="${esc(placeholder)}"></textarea>` : `<input type="text" name="${name}" required maxlength="${max}" placeholder="${esc(placeholder)}">`}</label>`;
}

function renderHome() {
  state.classId = ''; state.data = null;
  $('#app').innerHTML = `<section class="hero"><div><p class="eyebrow">OUR CLASS · OUR WORDS</p><h1>함께 고친 말,<br><em>우리 반의 사전으로.</em></h1><p class="lead">우리가 쓰는 표현을 모으고, 서로 별점을 매기고,<br>더 다정하고 알맞은 우리말을 함께 만듭니다.</p><div class="hero-note"><span>가입 없이 바로 참여</span><span>학급별 공동 편찬</span></div></div><div class="sample-book"><small>편찬 예시 · 우리가 바꾼 한마디</small><h2><span>힐링 → </span>마음쉼</h2><p><b>뜻</b> 지친 마음을 편안하게 쉬게 하는 일.</p><p>“친구와 산책하며 마음쉼을 했어.”</p></div></section>
    <div class="steps">${[['01','표현 모으기','순화하고 싶은 말을 등록해요'],['02','상호 평가','순화 필요성을 별점으로'],['03','순화어 만들기','새 표현을 제안하고 평가해요'],['04','사전 편찬','높은 평점과 교사의 선택']].map(([n,t,d]) => `<div class="step"><b>${n}</b><div><strong>${t}</strong><small>${d}</small></div></div>`).join('')}</div>
    <section><div class="section-heading"><div><h2>우리 학급으로 입장하기</h2><p>학교와 학급을 선택하면 바로 참여할 수 있어요.</p></div><button class="button primary" id="createClassButton">+ 우리 학급 만들기</button></div><div class="toolbar"><form id="classSearchForm" class="search-form"><input type="search" id="classSearch" aria-label="학교·학급 검색" value="${esc(state.homeSearch)}" placeholder="학교 또는 학급 이름 검색"><button class="button" type="submit">검색</button></form><button class="button quiet" id="refreshHome">새로고침</button></div><div id="homeNotice"></div><div id="classList" class="cards">${empty('학급 목록을 불러오는 중...')}</div><div id="homePages"></div></section>`;
  $('#createClassButton').onclick = openCreateClass;
  $('#classSearchForm').onsubmit = event => { event.preventDefault(); state.homeSearch = $('#classSearch').value; state.homeOffset = 0; loadHome(); };
  $('#refreshHome').onclick = loadHome;
  loadHome();
}
async function loadHome() {
  const request = ++state.request;
  try {
    const result = await api('listClasses', state.homeSearch, state.homeOffset);
    if (request !== state.request || state.classId) return;
    state.classes = result.classes; $('#homeNotice').innerHTML = '';
    $('#classList').innerHTML = result.classes.length ? result.classes.map(room => `<article class="class-card"><p class="school">${esc(room.school)}</p><h3>${esc(room.grade)} ${esc(room.class_name)}</h3><p class="help">순화할 표현 ${Number(room.word_count)}개</p><div class="row"><button class="button primary" data-enter="${room.id}">학급 입장 →</button>${state.admin ? `<button class="button danger" data-delete-class="${room.id}">삭제</button>` : ''}</div></article>`).join('') : empty(state.homeSearch ? '검색된 학급이 없습니다.' : '아직 등록된 학급이 없어요. 우리 학급의 첫 사전을 만들어 보세요.');
    $('#homePages').innerHTML = pageButtons(result.total, 50, state.homeOffset, 'home');
    bindShared();
  } catch (error) {
    if (request !== state.request || state.classId) return;
    $('#homeNotice').innerHTML = errorBox(error.message);
    $('#classList').innerHTML = '';
    $('#homePages').innerHTML = '';
  }
}
function openCreateClass() {
  modal('우리 학급 사전 만들기', `${field('학교', 'school', '예: 한빛중학교', 80)}<div class="field-row">${field('학년', 'grade', '예: 2학년', 20)}${field('반', 'className', '예: 3반', 40)}</div><p class="help">코드나 비밀번호 없이 같은 학교·학급을 선택해 함께 참여합니다. 이미 있는 학급이면 바로 입장해요.</p>`, '만들고 입장하기', async form => {
    const room = await api('createClass', Object.fromEntries(form));
    $('#dialog').close(); openClass(room.id);
  });
}
function openClass(id) { location.hash = 'class=' + id; }
function navigate() {
  state.request++;
  const params = new URLSearchParams(location.hash.slice(1));
  const classId = params.get('class');
  state.search = ''; state.offset = 0; state.tab = 'collect';
  if (classId && /^[0-9a-f-]{36}$/i.test(classId)) {
    state.classId = classId;
    $('#app').innerHTML = `<a class="button quiet" href="#">← 학급 목록</a>${empty('우리 학급 사전을 불러오는 중...')}`;
    loadClass();
  } else renderHome();
}
async function loadClass(silent = false) {
  if (!state.classId) return;
  const request = ++state.request;
  try {
    const result = await api('getClass', state.classId, state.tab === 'published' ? 'published' : 'words', state.search, state.offset);
    if (request !== state.request) return;
    state.data = result; state.admin = result.isAdmin; updateAdminButton();
    renderClass();
  } catch (error) {
    if (request !== state.request) return;
    if (silent && state.data) return toast(error.message, true);
    $('#app').innerHTML = `<a class="button quiet" href="#">← 학급 목록</a>${errorBox(error.message)}<button class="button" id="retryClass">다시 불러오기</button>`;
    $('#retryClass').onclick = () => loadClass();
  }
}
function renderClass() {
  const data = state.data; const room = data.class;
  const blocked = data.usage.writeBlocked;
  const titles = {
    collect: ['순화하고 싶은 말을 모아요', '표현의 뜻과 순화가 필요한 이유를 직접 등록해 보세요.'],
    rate: ['어떤 표현을 바꾸면 좋을까요?', '다른 친구가 등록한 말의 순화 필요성을 평가해요. 1점은 낮음, 5점은 높음입니다.'],
    refine: ['더 알맞은 우리말을 만들어 봐요', '상호 평가가 모인 표현에 순화어를 제안하고, 뜻의 전달력과 자연스러움을 별점으로 평가해요.'],
    published: ['우리 반 우리말 순화어 사전', '순화어 평균 4점 이상 · 1명 이상 평가 · 교사 선택을 모두 충족한 표현입니다.']
  };
  const [title, description] = titles[state.tab];
  $('#app').innerHTML = `<a class="button quiet" href="#">← 학급 목록</a><div class="class-title"><div><p class="school">${esc(room.school)}</p><h1>${esc(room.grade)} ${esc(room.class_name)}의 우리말</h1></div><div class="class-actions">${state.admin ? '<span class="admin-label">교사·관리자 모드</span><button class="button danger" id="deleteCurrentClass">학급 삭제</button>' : ''}<button class="button" id="copyClassLink">학급 링크 복사</button></div></div>
    <nav class="tabs" aria-label="사전 편찬 단계">${tabs.map(([key,label],i) => `<button class="tab ${state.tab === key ? 'active' : ''}" data-tab="${key}" aria-current="${state.tab === key ? 'step' : 'false'}"><small>STEP ${i+1}</small>${label}</button>`).join('')}</nav>
    ${blocked ? '<div class="notice error"><strong>무료 저장 용량 보호를 위해 새 저장을 중단했어요.</strong>기존 자료는 읽을 수 있습니다. 관리자가 불필요한 학급 자료를 삭제한 후 다시 확인해 주세요.</div>' : ''}
    <div class="stage-intro"><div><h2>${title}</h2><p>${description}</p></div>${state.tab === 'collect' ? `<button class="button primary" id="addWordButton" ${blocked ? 'disabled' : ''}>+ 순화할 말 등록</button>` : ''}</div>
    <div class="toolbar"><form class="search-form" id="wordSearchForm"><input type="search" aria-label="표현 검색" id="wordSearch" value="${esc(state.search)}" placeholder="${state.tab === 'published' ? '원래 표현 또는 순화어 검색' : '원래 표현 또는 뜻 검색'}"><button class="button" type="submit">검색</button></form><button class="button quiet" id="refreshClass">새로고침</button></div>
    <div class="stats"><span><b>${data.wordCount}</b>수집 표현</span><span><b>${data.revisionCount}</b>순화어 제안</span><span><b>${data.publishedCount}</b>최종 편찬</span></div>
    <section class="word-grid" id="wordList" style="margin-top:20px">${state.tab === 'published' ? publishedHtml(data.published) : wordsHtml(data.words, blocked)}</section>${pageButtons(data.total,25,state.offset,'class')}`;
  document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => { state.tab = button.dataset.tab; state.search = ''; state.offset = 0; loadClass(); }; });
  $('#wordSearchForm').onsubmit = event => { event.preventDefault(); state.search = $('#wordSearch').value; state.offset = 0; loadClass(); };
  $('#refreshClass').onclick = () => loadClass();
  if ($('#addWordButton')) $('#addWordButton').onclick = openAddWord;
  if ($('#deleteCurrentClass')) $('#deleteCurrentClass').onclick = () => openDeleteClass(room);
  $('#copyClassLink').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('학급 링크를 복사했습니다.'); }
    catch { modal('학급 링크', `<p class="help">아래 주소를 복사해 친구들과 공유하세요.</p><input type="text" value="${esc(location.href)}" readonly aria-label="학급 링크">`); }
  };
  document.querySelectorAll('[data-add-revision]').forEach(button => { button.onclick = () => openAddRevision(button.dataset.addRevision); });
  document.querySelectorAll('[data-rating]').forEach(button => { button.onclick = () => saveRating(button); });
  document.querySelectorAll('[data-select-revision]').forEach(button => { button.onclick = () => selectRevision(button); });
  bindShared();
}
function stars(kind, item, blocked) {
  if (item.mine) return '<p class="help">내가 등록한 표현은 다른 친구들이 평가해요.</p>';
  return `<div class="stars" role="group" aria-label="${esc(item.word)} ${kind === 'word' ? '순화 필요성' : '순화어'} 평가">${[1,2,3,4,5].map(n => `<button class="star ${n <= Number(item.my_rating) ? 'on' : ''}" data-rating="${kind}" data-id="${item.id}" data-score="${n}" aria-label="${esc(item.word)} ${n}점" aria-pressed="${Number(item.my_rating) === n}" ${blocked ? 'disabled' : ''}>★</button>`).join('')}<span class="rating-label">${item.my_rating ? `내 평가 ${item.my_rating}점` : '별을 눌러 평가'}</span></div>`;
}
function wordsHtml(words, blocked) {
  if (!words.length) return empty(state.search ? '검색된 표현이 없습니다.' : '아직 등록된 표현이 없어요. 모으기 단계에서 첫 표현을 등록해 보세요.');
  return words.map(word => `<article class="word-card" data-word="${word.id}"><div class="card-head"><span class="badge">${esc(word.category)}</span><span class="help">${word.mine ? '내가 등록' : '우리 반 표현'}</span></div><h3>${esc(word.word)}</h3><p class="definition"><b>뜻</b>${esc(word.meaning)}</p><p class="definition"><b>순화가 필요한 이유</b>${esc(word.reason)}</p>
    <div class="rating-box"><span class="score">순화 필요성 ${score(word.average_rating,word.rating_count)}</span>${state.tab === 'rate' ? stars('word',word,blocked) : ''}</div>
    ${state.tab === 'collect' ? '<p class="help" style="margin-top:14px">등록 완료 · 평가하기에서 서로 별점을 매겨요.</p>' : ''}
    ${state.tab === 'refine' ? `${Number(word.rating_count) ? (word.revisions.some(item => item.mine) ? '<p class="help" style="margin-top:14px">내 순화어 제안이 등록되어 있어요.</p>' : `<button class="button primary" data-add-revision="${word.id}" ${blocked ? 'disabled' : ''}>+ 순화어 제안</button>`) : '<p class="help" style="margin-top:14px">순화 필요성 평가가 1개 이상 모이면 순화어를 제안할 수 있어요.</p>'}${word.revisions.map(revision => revisionHtml(revision,blocked)).join('')}` : ''}</article>`).join('');
}
function revisionHtml(item, blocked) {
  const eligible = Number(item.average_rating) >= 4 && Number(item.rating_count) > 0;
  return `<section class="revision" data-revision="${item.id}"><div class="card-head"><span class="badge ${item.published ? 'gold' : ''}">${item.published ? '최종 사전 편찬' : item.selected ? '교사 선택 · 평점 충족 대기' : '순화어 제안'}</span><span class="help">${item.mine ? '내 제안' : ''}</span></div><h3>${esc(item.word)}</h3><p class="definition"><b>뜻</b>${esc(item.meaning)}</p><p class="definition"><b>바꾼 이유</b>${esc(item.reason)}</p><p class="definition"><b>예문</b>${esc(item.example)}</p><div class="rating-box"><span class="score">순화어 평가 ${score(item.average_rating,item.rating_count)}</span>${stars('revision',item,blocked)}<p class="help">뜻이 잘 전달되고 자연스러울수록 높은 별점을 주세요.</p></div>${state.admin ? `<div class="row"><span class="help">${eligible ? '평점 기준 충족' : '평균 4점 이상부터 편찬 가능'}</span><button class="button ${item.selected ? '' : 'primary'}" data-select-revision="${item.id}" data-selected="${!item.selected}" ${blocked || (!item.selected && !eligible) ? 'disabled' : ''}>${item.selected ? '교사 선택 취소' : '교사 선택 · 사전 편찬'}</button></div>` : ''}</section>`;
}
function publishedHtml(entries) {
  return entries.length ? entries.map(item => `<article class="published-card"><div class="card-head"><span class="badge gold">교사 선택 · 편찬 완료</span><span class="score">${score(item.average_rating,item.rating_count)}</span></div><p class="original">${esc(item.original_word)} →</p><h2>${esc(item.word)}</h2><p class="definition"><b>뜻</b>${esc(item.meaning)}</p><p class="definition"><b>예문</b>${esc(item.example)}</p></article>`).join('') : empty(state.search ? '검색된 순화어가 없습니다.' : '평균 4점 이상인 순화어를 교사가 선택하면 이곳에 편찬됩니다.');
}
function openAddWord() {
  const id = crypto.randomUUID(); const classId = state.classId;
  modal('순화할 우리말 등록', `${field('순화할 표현','word','예: 힐링',80)}<label class="field"><span>표현 유형</span><select name="category">${['비속어','유행어','외래어','신조어','기타'].map(item => `<option>${item}</option>`).join('')}</select></label>${field('이 표현의 뜻','meaning','친구들이 이해할 수 있게 설명해 주세요.',600,true)}${field('순화가 필요한 이유','reason','어떤 점을 바꾸면 좋을까요?',600,true)}`, '등록 완료', async form => {
    await api('addWord',classId,{id,...Object.fromEntries(form)});
    $('#dialog').close(); state.tab = 'rate'; state.offset = 0; state.search = '';
    toast('등록했습니다. 이제 친구들과 상호 평가해 보세요.'); await loadClass();
  });
}
function openAddRevision(wordId) {
  const original = state.data.words.find(item => item.id === wordId); if (!original) return;
  const id = crypto.randomUUID();
  modal('순화어 제안하기', `<p class="notice">원래 표현: <strong>${esc(original.word)}</strong></p>${field('새로 제안하는 순화어','word','더 알맞은 우리말을 적어 주세요.',80)}${field('순화어의 뜻','meaning','원래 의미를 어떻게 담았나요?',600,true)}${field('바꾼 이유','reason','새 표현이 더 좋은 이유를 설명해 주세요.',600,true)}${field('순화어를 사용한 예문','example','새 표현을 넣어 한 문장을 만들어 주세요.',600,true)}`, '순화어 등록', async form => {
    await api('addRevision',wordId,{id,...Object.fromEntries(form)});
    $('#dialog').close(); toast('순화어를 등록했습니다. 친구들의 평가를 기다려 주세요.'); await loadClass();
  });
}
async function saveRating(button) {
  const group = button.closest('.stars'); group.querySelectorAll('button').forEach(item => { item.disabled = true; });
  try {
    await api(button.dataset.rating === 'word' ? 'rateWord' : 'rateRevision',button.dataset.id,Number(button.dataset.score));
    toast(`${button.dataset.score}점으로 평가했습니다.`); await loadClass();
  } catch (error) { toast(error.message,true); group.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
}
async function selectRevision(button) {
  button.disabled = true;
  try { await api('selectRevision',button.dataset.selectRevision,button.dataset.selected === 'true'); toast(button.dataset.selected === 'true' ? '최종 우리말 순화어 사전에 편찬했습니다.' : '교사 선택을 취소했습니다.'); await loadClass(); }
  catch (error) { toast(error.message,true); button.disabled = false; }
}
function openAdmin() {
  if (state.admin) {
    modal('교사·관리자 메뉴', '<p>순화하기 단계에서 높은 평점의 단어를 선택해 최종 사전에 편찬할 수 있습니다.</p><div class="class-actions" style="margin-top:18px"><button type="button" class="button" id="usageButton">저장 용량 확인</button><button type="button" class="button" id="logoutAdmin">관리자 로그아웃</button></div>');
    $('#logoutAdmin').onclick = async () => { try { await api('logoutAdmin'); state.admin = false; $('#dialog').close(); updateAdminButton(); if(state.classId) await loadClass(); else await loadHome(); } catch(error) { toast(error.message,true); } };
    $('#usageButton').onclick = async () => {
      try {
        const data = await api('getUsage');
        const used = (data.databaseBytes/1000000).toFixed(1), limit = (data.writeLimitBytes/1000000).toFixed(0);
        $('#dialog').close();
        modal('데이터 저장 용량', `<p><strong>${used} MB / ${limit} MB</strong></p><div class="meter"><span style="width:${Math.min(100,data.databaseBytes/data.writeLimitBytes*100)}%"></span></div><p class="help">무료 DB 한도 500 MB보다 낮은 450 MB부터 새 저장을 막습니다. 관리자 학급 삭제는 계속 가능합니다.</p>${data.writeBlocked ? errorBox('현재 새 저장이 중단되어 있습니다.') : ''}`);
      } catch(error) { toast(error.message,true); }
    };
    return;
  }
  modal('교사·관리자 입장', '<label class="field"><span>관리자 비밀번호</span><input name="password" type="password" required maxlength="100" autocomplete="current-password"></label><p class="help">학급 삭제와 최종 편찬 단어 선택은 관리자 인증 후 가능합니다.</p>', '관리자로 입장', async form => {
    await api('loginAdmin',form.get('password')); state.admin = true; updateAdminButton(); $('#dialog').close();
    toast('교사·관리자로 입장했습니다.'); if (state.classId) await loadClass(); else await loadHome();
  });
}
function openDeleteClass(room) {
  modal('학급 사전과 연결 자료 삭제', `<p><strong>${esc(roomName(room))}</strong></p><p class="notice error">이 학급의 원래 표현, 별점, 순화어 제안, 최종 편찬 자료가 서버에서도 모두 삭제됩니다. 되돌릴 수 없습니다.</p><label class="field"><span>삭제하려면 아래에 ‘삭제’를 입력해 주세요.</span><input type="text" name="confirm" required pattern="삭제" autocomplete="off"></label>`, '학급과 모든 자료 삭제', async () => {
    await api('deleteClass',room.id); $('#dialog').close(); toast('학급과 연결된 모든 자료를 서버에서 삭제했습니다.');
    if (state.classId === room.id) location.hash = ''; else await loadHome();
  });
}
function bindShared() {
  document.querySelectorAll('[data-enter]').forEach(button => { button.onclick = () => openClass(button.dataset.enter); });
  document.querySelectorAll('[data-delete-class]').forEach(button => { button.onclick = () => { const room = state.classes.find(item => item.id === button.dataset.deleteClass); if (room) openDeleteClass(room); }; });
  document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => { if(button.dataset.page === 'home') { state.homeOffset = Number(button.dataset.offset); loadHome(); } else { state.offset = Number(button.dataset.offset); loadClass(); } }; });
}

$('#adminButton').onclick = openAdmin;
$('#dialog').addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
window.addEventListener('hashchange', navigate);
navigate();
if (AppApi.configured()) api('isAdmin').then(isAdmin => { state.admin = isAdmin; updateAdminButton(); if (!state.classId && isAdmin) loadHome(); }).catch(() => {});
// 정기 전체 조회를 하지 않아 전송량을 아낍니다. 사용자가 새로고침하거나 저장할 때만 최신 자료를 읽습니다.
