const themes = {
  atelier: { title: '말이 모여,<br><span>우리 반이 되다.</span>', caption: '01 / SOFT WORD ATELIER', name: '말랑 공방' },
  orbit: { title: '우리의 말,<br><span>새로운 궤도.</span>', caption: '02 / OUR WORD UNIVERSE', name: '말의 우주' },
  play: { title: '한 글자씩,<br><span>새로운 세계.</span>', caption: '03 / WORDS AT PLAY', name: '워드 플레이' }
};
const query = new URLSearchParams(location.search);
const theme = Object.hasOwn(themes, query.get('theme')) ? query.get('theme') : 'atelier';
document.body.dataset.theme = theme;
document.title = `${themes[theme].name} · 우리말 사전 테마`;
document.querySelector('#heroTitle').innerHTML = themes[theme].title;
document.querySelector('.theme-caption').textContent = themes[theme].caption;
document.querySelector('meta[name=theme-color]').content = theme === 'orbit' ? '#10132e' : '#f7f6f0';
const rooms = [
  {school:'한빛중학교',grade:'2학년',room:'3반',symbol:'가'},
  {school:'푸른초등학교',grade:'5학년',room:'1반',symbol:'나'},
  {school:'새봄중학교',grade:'1학년',room:'2반',symbol:'다'}
];
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderRooms(search = '') {
  const found = rooms.filter(r => `${r.school} ${r.grade} ${r.room}`.includes(search.trim()));
  document.querySelector('#classGrid').innerHTML = found.length ? found.map((r,i) => `<article class="class-card"><span class="class-icon" aria-hidden="true">${escape(r.symbol)}</span><p>${escape(r.school)}</p><h3>${escape(r.grade)} ${escape(r.room)}</h3><button type="button" class="enter" aria-label="${escape(r.school)} ${escape(r.grade)} ${escape(r.room)} 미리보기" data-room="${i}">↗</button></article>`).join('') : '<p class="empty">찾는 학급이 없어요.</p>';
  document.querySelectorAll('[data-room]').forEach(button => button.onclick = () => showDictionary(found[Number(button.dataset.room)]));
}
renderRooms();
document.querySelector('.search').onsubmit = event => { event.preventDefault();renderRooms(document.querySelector('#classSearch').value); };
document.querySelector('#classSearch').oninput = event => renderRooms(event.target.value);
const dialog = document.querySelector('#dialog');
const form = document.querySelector('#dialogForm');
document.querySelector('.dialog-close').onclick = () => dialog.close();
function showDictionary(room = rooms[0]) {
  document.querySelector('#dialogTitle').textContent = `${room.grade} ${room.room}의 우리말`;
  document.querySelector('#dialogBody').innerHTML = '<div class="sample-entry"><small>힐링 →</small><h3>마음쉼</h3><p>지친 마음을 편안하게 쉬게 하는 일.</p></div><div class="sample-entry"><small>챌린지 →</small><h3>함께도전</h3><p>친구와 함께 새로운 일에 도전하는 것.</p></div><p class="dialog-note">디자인 미리보기 · 실제 저장 자료가 아닙니다.</p>';
  form.onsubmit = event => event.preventDefault();
  dialog.showModal();
}
document.querySelector('[data-dictionary]').onclick = () => showDictionary();
document.querySelectorAll('[data-create]').forEach(button => button.onclick = () => {
  document.querySelector('#dialogTitle').textContent = '우리 반 사전 만들기';
  document.querySelector('#dialogBody').innerHTML = '<label>학교<input name="school" required maxlength="80" placeholder="학교 이름" autocomplete="off"></label><label>학년<input name="grade" required maxlength="20" placeholder="예: 2학년"></label><label>반<input name="room" required maxlength="40" placeholder="예: 3반"></label><button class="cta" type="submit">사전 만들기 <span>↗</span></button><p class="dialog-note">디자인 미리보기 · 실제 자료는 저장하지 않습니다.</p>';
  form.onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    rooms.unshift({...data,symbol:'새'});
    document.querySelector('#classSearch').value = '';
    renderRooms();dialog.close();
    document.querySelector('#classrooms').scrollIntoView({behavior:'smooth'});
    const toast = document.querySelector('.toast');toast.textContent = '미리보기 학급을 만들었어요.';toast.hidden = false;setTimeout(() => toast.hidden = true,3500);
  };
  dialog.showModal();
});
await document.fonts.ready;
try {
  const { startScene } = await import('./scene.js');
  startScene(theme);
  if(parent!==window)parent.postMessage({type:'preview-ready'},location.origin);
} catch(error) {
  console.error('Preview scene:',error);
  document.querySelector('#scene').innerHTML = '<div style="display:grid;place-items:center;height:100%;font-size:160px;filter:drop-shadow(0 20px 24px #0002)">📖</div>';
  document.body.dataset.scene = 'fallback';
}
