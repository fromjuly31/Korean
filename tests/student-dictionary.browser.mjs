import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,installTestClient,root} from './support/database.mjs';

const database=await createDatabase();
const siteRoot=fileURLToPath(new URL('site/',root));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(request,response)=>{
  try{let path=resolve(siteRoot,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));if(path!==resolve(siteRoot)&&!path.startsWith(siteRoot.endsWith(sep)?siteRoot:siteRoot+sep)){response.writeHead(403).end();return;}if((await stat(path)).isDirectory())path=resolve(path,'index.html');response.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');response.end(await readFile(path));}catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser,dropResponse=false,failRead=false;
const errors=[];
async function newStudent(configured=true){
 const userId=await database.newUser();
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 await context.exposeBinding('__database',async(_source,request)=>{
   if(failRead&&request.rpc==='dictionary_get_class'){failRead=false;return {data:null,error:{message:'Failed to fetch'}};}
   const result=await database.execute(userId,request);
   if(dropResponse&&request.rpc==='dictionary_add_word'){dropResponse=false;return {data:null,error:{message:'Failed to fetch'}};}
   return result;
 });
 await context.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:`window.APP_CONFIG={supabaseUrl:'${configured?'https://test.invalid':''}',supabasePublishableKey:'${configured?'test':''}'};`}));
 await context.route('**/assets/supabase-*.js',route=>route.fulfill({contentType:'text/javascript',body:`(${installTestClient.toString()})('${userId}')`}));
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 return {page,userId,context};
}
const screenshot=async(page,name)=>page.screenshot({path:fileURLToPath(new URL('test-results/'+name+'.png',root)),fullPage:true});
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal overflow');}
async function settled(page){await page.locator('#app[aria-busy=true]').waitFor({state:'detached'});}
try{
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--enable-unsafe-swiftshader']});
 await mkdir(new URL('test-results/',root),{recursive:true});
 const {page:owner,userId:ownerId}=await newStudent();await owner.goto(origin);await owner.getByRole('button',{name:'우리 반 입장',exact:true}).waitFor();
 for(const [width,height] of [[1440,900],[1280,720],[1024,768],[768,1024],[390,844],[375,667],[320,568],[320,480],[844,390],[568,320],[720,450]]){
   await owner.setViewportSize({width,height});await noOverflow(owner);
   assert.equal(await owner.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true,`home must fit ${width}x${height}`);
   for(const name of ['우리 반 입장','새 사전 만들기','사용 설명서'])assert.equal(await owner.getByRole('button',{name,exact:true}).isVisible(),true);
   const entry=await owner.getByRole('link',{name:'사전 입장',exact:true}).boundingBox();
   assert.ok(entry.y>=0&&entry.y+entry.height<=height,`main dictionary entry visible ${width}x${height}`);
 }
 await owner.setViewportSize({width:390,height:844});await screenshot(owner,'atelier-home-mobile');
 await owner.getByRole('button',{name:'사용 설명서',exact:true}).click();
 await owner.getByRole('tab',{name:'교사',exact:true}).focus();await owner.keyboard.press('ArrowLeft');
 assert.equal(await owner.getByRole('tab',{name:'학생',exact:true}).getAttribute('aria-selected'),'true');
 await owner.keyboard.press('Escape');assert.equal(await owner.locator('#dialog').evaluate(e=>e.open),false);
 await owner.getByRole('button',{name:'우리 반 입장',exact:true}).click();
 await owner.getByText('아직 등록된 학급이 없어요. 첫 사전을 만들어 보세요.',{exact:true}).waitFor();
 await owner.getByRole('button',{name:'닫기',exact:true}).click();
 await owner.getByRole('button',{name:'새 사전 만들기',exact:true}).click();
 await owner.getByLabel('학교',{exact:true}).fill('한빛중학교');await owner.getByLabel('학년',{exact:true}).fill('2학년');await owner.getByLabel('반',{exact:true}).fill('3반');
 await owner.getByRole('button',{name:'만들고 입장하기',exact:true}).click();await owner.getByRole('button',{name:'표현 등록',exact:true}).waitFor();
 const roomUrl=owner.url(),roomId=new URLSearchParams(new URL(roomUrl).hash.slice(1)).get('class');
 assert.equal(await owner.getByRole('heading',{name:'2학년 3반의 우리말',exact:true}).count(),1);
 console.log('PASS: 11 viewport sizes fit without home scrolling; manual keyboard controls; mobile class creation');

 await owner.getByRole('button',{name:'표현 등록',exact:true}).click();
 await owner.getByLabel('순화할 표현',{exact:true}).fill('힐링');await owner.getByLabel('표현 유형').selectOption('외래어');
 await owner.getByLabel('이 표현의 뜻').fill('마음이 편안해지는 일');await owner.getByLabel('순화가 필요한 이유').fill('쉬운 우리말로 바꾸고 싶어요.');
 await owner.getByRole('button',{name:'닫기',exact:true}).click();await owner.getByRole('button',{name:'표현 등록',exact:true}).click();
 assert.equal(await owner.getByLabel('순화할 표현',{exact:true}).inputValue(),'힐링','closed draft must survive');
 await owner.setViewportSize({width:390,height:500});
 const submitBox=await owner.getByRole('button',{name:'등록 완료',exact:true}).boundingBox();assert.ok(submitBox.y+submitBox.height<=500,'submit remains above keyboard');
 dropResponse=true;await owner.getByRole('button',{name:'등록 완료',exact:true}).click();await owner.locator('#modalError').filter({hasText:'입력 내용은 유지됩니다'}).waitFor();
 assert.equal(await owner.getByLabel('순화할 표현',{exact:true}).inputValue(),'힐링');
 await owner.getByRole('button',{name:'등록 완료',exact:true}).click();await owner.getByRole('heading',{name:'힐링',exact:true}).waitFor();
 assert.equal((await database.db.query('select count(*)::int as n from public.dictionary_words')).rows[0].n,1);
 assert.equal(await owner.getByRole('button',{name:'힐링 5점',exact:true}).count(),0);
 await owner.setViewportSize({width:390,height:844});
 console.log('PASS: draft restore, keyboard-safe submit, lost-response retry without duplicate, no self rating');

 const {page:peer}=await newStudent();await peer.goto(origin);await peer.getByRole('button',{name:'우리 반 입장',exact:true}).click();
 await peer.getByLabel('학교·학급 검색').fill('한빛');await peer.getByRole('button',{name:'학급 검색',exact:true}).click();await peer.getByRole('button',{name:/한빛중학교.*입장/}).click();
 await peer.locator('[data-tab=rate]').click();await peer.getByRole('button',{name:'힐링 5점',exact:true}).click();await peer.getByText('내 평가 5점',{exact:true}).waitFor();
 await owner.locator('[data-tab=refine]').click();await owner.getByRole('button',{name:'순화어 제안',exact:true}).click();
 await owner.getByLabel('새로 제안하는 순화어').fill('마음쉼');await owner.getByLabel('순화어의 뜻').fill('지친 마음을 편안하게 쉬게 하는 일');await owner.getByLabel('바꾼 이유',{exact:true}).fill('뜻을 더 쉽게 이해할 수 있어요.');await owner.getByLabel('순화어를 사용한 예문').fill('산책하며 마음쉼을 했어.');
 await owner.getByRole('button',{name:'순화어 등록',exact:true}).click();await owner.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
 await peer.locator('[data-tab=refine]').click();await peer.getByRole('button',{name:'마음쉼 3점',exact:true}).click();await peer.getByText('내 평가 3점',{exact:true}).waitFor();
 await peer.locator('[data-tab=published]').click();await peer.getByText('평균 4점 이상인 순화어를 교사가 선택하면 이곳에 편찬됩니다.',{exact:true}).waitFor();
 await peer.reload();await peer.locator('[data-tab=published][aria-current=step]').waitFor();
 const stageUrl=peer.url();await peer.locator('.skip-link').focus();await peer.keyboard.press('Enter');assert.equal(peer.url(),stageUrl);assert.equal(await peer.locator('#app').evaluate(e=>e===document.activeElement),true);
 console.log('PASS: student word rating, revision submission and rating; published stage survives reload');

 const {page:teacher}=await newStudent();await teacher.goto(roomUrl);await teacher.getByRole('button',{name:'교사·관리자',exact:true}).click();
 await teacher.getByLabel('관리자 비밀번호').fill('wrong');await teacher.getByRole('button',{name:'관리자로 입장',exact:true}).click();await teacher.locator('#modalError').filter({hasText:'비밀번호가 다르거나'}).waitFor();
 await teacher.getByLabel('관리자 비밀번호').fill('admin123');await teacher.getByRole('button',{name:'관리자로 입장',exact:true}).click();await teacher.getByText('교사·관리자 모드',{exact:true}).waitFor();
 await teacher.locator('[data-tab=refine]').click();assert.equal(await teacher.getByRole('button',{name:'사전 편찬',exact:true}).isDisabled(),true);
 await peer.locator('[data-tab=refine]').click();await peer.getByRole('button',{name:'마음쉼 5점',exact:true}).click();await peer.getByText('내 평가 5점',{exact:true}).waitFor();
 await teacher.getByRole('button',{name:'새로고침',exact:true}).click();await teacher.getByRole('button',{name:'사전 편찬',exact:true}).click();await teacher.getByText('편찬 완료',{exact:true}).waitFor();
 await peer.locator('[data-tab=published]').click();await peer.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();await screenshot(peer,'atelier-dictionary-desktop');
 for(const width of [320,390,768,1024]){await peer.setViewportSize({width,height:844});await noOverflow(peer);}
 await peer.setViewportSize({width:390,height:844});await screenshot(peer,'atelier-dictionary-mobile');
 await peer.getByLabel('표현 검색',{exact:true}).fill('없는표현');await peer.getByRole('button',{name:'표현 검색 실행'}).click();await peer.getByText('검색된 순화어가 없습니다.',{exact:true}).waitFor();
 await peer.getByLabel('표현 검색',{exact:true}).fill('마음');await peer.getByRole('button',{name:'표현 검색 실행'}).click();await peer.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
 failRead=true;await peer.getByRole('button',{name:'새로고침',exact:true}).click();await peer.locator('#classNotice').getByRole('alert').waitFor();assert.equal(await peer.getByRole('heading',{name:'마음쉼',exact:true}).count(),1);
 await peer.getByRole('button',{name:'새로고침',exact:true}).click();await settled(peer);assert.equal(await peer.locator('#classNotice').getByRole('alert').count(),0);
 await peer.locator('[data-tab=refine]').click();await peer.getByRole('button',{name:'마음쉼 3점',exact:true}).click();await peer.getByText('내 평가 3점',{exact:true}).waitFor();await peer.locator('[data-tab=published]').click();await peer.getByText('평균 4점 이상인 순화어를 교사가 선택하면 이곳에 편찬됩니다.',{exact:true}).waitFor();
 console.log('PASS: teacher publication guard and publication; responsive dictionary, search, read failure recovery, rating drop removes entry');

 // Long student content, safe escaping, paging, and late responses use the real SQL.
 const longWord=('아주 긴 표현 ').repeat(7).trim();
 for(let i=0;i<27;i++)await database.asUser(ownerId,'select public.dictionary_add_word($1,$2,$3,$4,$5,$6)',[randomUUID(),roomId,i===0?longWord:'추가표현'+String(i).padStart(2,'0'),'기타',('친구와 함께 이해할 수 있는 뜻입니다. ').repeat(12),i===0?'<script>window.__unsafe=true</script>':'순화할 이유']);
 await owner.locator('[data-tab=collect]').click();await settled(owner);assert.equal(await owner.locator('.word-card').count(),25);
 await owner.getByRole('button',{name:'다음',exact:true}).click();await settled(owner);assert.equal(await owner.locator('.word-card').count(),3);
 await owner.reload();await settled(owner);assert.equal(await owner.locator('.word-card').count(),3,'page survives reload');
 await owner.getByRole('button',{name:'이전',exact:true}).click();await settled(owner);
 await owner.getByLabel('표현 검색',{exact:true}).fill('아주 긴');await owner.getByRole('button',{name:'표현 검색 실행'}).click();await owner.getByRole('heading',{name:longWord,exact:true}).waitFor();
 for(const width of [320,390,768,1024,1440]){await owner.setViewportSize({width,height:844});await noOverflow(owner);const overflowing=await owner.locator('.word-card').evaluateAll(cards=>cards.filter(c=>c.scrollWidth>c.clientWidth+1).length);assert.equal(overflowing,0);}
 assert.equal(await owner.evaluate(()=>Boolean(window.__unsafe)),false);
 await owner.setViewportSize({width:320,height:568});await screenshot(owner,'atelier-long-answer-mobile');
 await owner.context().grantPermissions(['clipboard-read','clipboard-write']);await owner.getByRole('button',{name:'링크 복사',exact:true}).click();
 assert.equal(await owner.evaluate(()=>navigator.clipboard.readText()),roomUrl.split('#')[0]+'#class='+roomId);
 console.log('PASS: long student answers, HTML escaping, real pagination, retained page, canonical share link');

 await database.db.exec('update public.dictionary_settings set write_limit_bytes=1');await owner.getByRole('button',{name:'새로고침',exact:true}).click();await owner.getByText('무료 저장 용량 보호를 위해 새 저장을 중단했어요.',{exact:true}).waitFor();assert.equal(await owner.getByRole('button',{name:'표현 등록',exact:true}).isDisabled(),true);
 await teacher.getByRole('button',{name:'교사 메뉴',exact:true}).click();await teacher.getByRole('button',{name:'저장 용량 확인',exact:false}).click();await teacher.getByText('현재 새 저장이 중단되어 있습니다.',{exact:true}).waitFor();await teacher.getByRole('button',{name:'닫기',exact:true}).click();
 await teacher.getByRole('button',{name:'교사 메뉴',exact:true}).click();await teacher.getByRole('button',{name:'학급 삭제',exact:false}).click();await teacher.getByLabel('삭제하려면 ‘삭제’를 입력해 주세요.').fill('삭제');await teacher.getByRole('button',{name:'학급과 모든 자료 삭제',exact:true}).click();await teacher.getByRole('button',{name:'우리 반 입장',exact:true}).waitFor();
 for(const table of ['class_dictionaries','dictionary_words','dictionary_word_ratings','dictionary_revisions','dictionary_revision_ratings'])assert.equal((await database.db.query('select count(*)::int as n from public.'+table)).rows[0].n,0,table);
 await peer.getByRole('button',{name:'새로고침',exact:true}).click();await peer.getByText('삭제되었거나 없는 학급입니다. 학급 목록으로 돌아가 주세요.',{exact:true}).waitFor();
 await teacher.getByRole('button',{name:'교사 메뉴',exact:true}).click();await teacher.getByRole('button',{name:'관리자 로그아웃',exact:false}).click();await teacher.getByRole('button',{name:'교사·관리자',exact:true}).waitFor();
 const {page:disconnected}=await newStudent(false);await disconnected.goto(origin);await disconnected.getByRole('button',{name:'우리 반 입장',exact:true}).click();await disconnected.getByText('데이터 저장소 연결을 준비하고 있습니다. 연결이 완료되면 학급을 만들고 저장할 수 있어요.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: capacity protection, admin usage and cascade delete, stale class, logout, connection errors; no browser errors');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await database.db.close();}
