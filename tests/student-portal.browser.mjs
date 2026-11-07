import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {createDatabase,root} from './support/database.mjs';

const database=await createDatabase(),siteRoot=resolve(fileURLToPath(new URL('site/',root)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.png':'image/png'};
const server=createServer(async(req,res)=>{try{let path=resolve(siteRoot,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(path!==siteRoot&&!path.startsWith(siteRoot+sep)){res.writeHead(403).end();return;}if((await stat(path)).isDirectory())path=resolve(path,'index.html');res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser,lastEvent=0,dropResponse=false,queue=Promise.resolve();
const contexts=[],errors=[];
function installClient(){
 window.__channels=[];
 window.__dispatchChange=message=>window.__channels.filter(c=>c.topic===message.topic).forEach(c=>c.callback({payload:message.payload}));
 window.supabase={createClient:(_url,_key,options)=>{
   const scope=options.auth.storageKey==='dictionary-student-auth'?'student':'teacher';window.__authScope=scope;
   return {rpc:(rpc,args)=>window.__database({rpc,args,scope}),auth:{getSession:async()=>({data:{session:{user:{id:scope}}},error:null}),signInAnonymously:async()=>({data:{},error:null})},
     channel(topic){const channel={topic,on(_type,_filter,callback){this.callback=callback;return this;},subscribe(callback){window.__channels.push(this);callback('SUBSCRIBED');return this;}};return channel;},removeChannel(channel){window.__channels=window.__channels.filter(c=>c!==channel);}};
 }};
}
function pump(){queue=queue.then(async()=>{const events=(await database.db.query('select * from realtime.test_events where id>$1 order by id',[lastEvent])).rows;if(!events.length)return;lastEvent=Number(events.at(-1).id);for(const context of contexts)for(const page of context.pages())if(!page.isClosed())await page.evaluate(events=>events.forEach(event=>window.__dispatchChange?.(event)),events).catch(()=>{});});return queue;}
async function client(){
 const teacherId=await database.newUser(),studentId=await database.newUser();
 const context=await browser.newContext({viewport:{width:390,height:844}});contexts.push(context);
 context.setDefaultTimeout(20000);
 await context.exposeBinding('__database',async(_source,request)=>{const result=await database.execute(request.scope==='student'?studentId:teacherId,request);await pump();if(dropResponse&&request.rpc==='dictionary_add_word'){dropResponse=false;return {data:null,error:{message:'Failed to fetch'}};}return result;});
 await context.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:"window.APP_CONFIG={supabaseUrl:'https://test.invalid',supabasePublishableKey:'test'};"}));
 await context.route('**/assets/supabase-*.js',route=>route.fulfill({contentType:'text/javascript',body:`(${installClient.toString()})()`}));
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 return {page:await context.newPage(),context,teacherId,studentId};
}
const shot=async(page,name)=>{await page.evaluate(()=>window.scrollTo(0,0));return page.screenshot({path:'test-results/'+name+'.png',fullPage:true});};
const noOverflow=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal overflow');
const settled=async page=>page.waitForFunction(()=>state.view==='class'&&state.data&&!document.querySelector('#app[aria-busy=true]'));
async function join(page,url,nickname){await page.goto(url);await page.getByLabel('닉네임',{exact:true}).fill(nickname);assert.equal(await page.locator('[data-tab]').count(),0);await page.getByRole('button',{name:'입장하기',exact:true}).click();await page.getByLabel('순화할 표현',{exact:true}).waitFor();}
async function fillWord(page,word){await page.getByLabel('순화할 표현',{exact:true}).fill(word);await page.getByLabel('이 표현의 뜻').fill('마음이 편안해지는 것');await page.getByLabel('순화가 필요한 이유').fill('알기 쉬운 우리말로 바꾸고 싶어요.');}
try{
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--enable-unsafe-swiftshader']});await mkdir('test-results',{recursive:true});
 const teacher=await client(),t=teacher.page;await t.goto(origin);
 for(const [width,height] of [[1440,900],[1280,720],[768,1024],[390,844],[320,568],[320,480],[568,320]]){await t.setViewportSize({width,height});await noOverflow(t);assert.equal(await t.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true,`home fit ${width}x${height}`);}
 assert.match(await t.locator('.brand').innerText(),/우리말 사전 편찬/);await t.setViewportSize({width:1440,height:1000});
 await t.getByRole('button',{name:'새 사전 만들기',exact:true}).click();await t.getByLabel('사전 제목').fill('1-7 파이팅');await t.getByRole('button',{name:'만들고 입장하기',exact:true}).click();
 await t.getByLabel('학생 입장 링크').waitFor();const roomUrl=t.url(),roomId=new URLSearchParams(new URL(roomUrl).hash.slice(1)).get('class'),entry=await t.getByLabel('학생 입장 링크').inputValue();
 assert.ok(entry.includes('/student.html#'));assert.equal(new URLSearchParams(new URL(entry).hash.slice(1)).get('stage'),'collect');
 const png=PNG.sync.read(await t.locator('.student-qr').screenshot());const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.equal(decoded?.data,entry,'QR must decode to actual student URL');
 assert.equal(await t.getByRole('button',{name:'표현 등록',exact:true}).count(),0);assert.equal(await t.locator('[data-rating]').count(),0);
 await t.locator('[data-tab=rate]').click();await t.getByLabel('학생 입장 링크').waitFor();assert.equal(new URLSearchParams(new URL(await t.getByLabel('학생 입장 링크').inputValue()).hash.slice(1)).get('stage'),'rate');await t.locator('[data-tab=collect]').click();await t.getByLabel('학생 입장 링크').waitFor();
 console.log('PASS: renamed teacher app, responsive home, stage-specific student links, decoded QR and teacher-only monitoring');
 const a=await client(),b=await client();await join(a.page,entry,'달빛책갈피');await join(b.page,entry,'소다팝');
 await t.waitForFunction(()=>state.data.activity.students===2);
 for(const width of [320,375,390,768,1280]){await a.page.setViewportSize({width,height:844});await noOverflow(a.page);assert.equal(await a.page.locator('.student-tabs [data-tab]').count(),3);}
 await a.page.setViewportSize({width:390,height:844});assert.equal(await a.page.getByRole('button',{name:'관리자 로그인',exact:true}).count(),0);
 await a.page.getByLabel('순화할 표현',{exact:true}).fill('임시 초안');await a.page.locator('[data-tab=refine]').click();await settled(a.page);await a.page.locator('[data-tab=collect]').click();await a.page.getByLabel('순화할 표현',{exact:true}).waitFor();assert.equal(await a.page.getByLabel('순화할 표현',{exact:true}).inputValue(),'임시 초안');
 await fillWord(a.page,'힐링');dropResponse=true;await a.page.getByRole('button',{name:'표현 등록',exact:true}).click();await a.page.locator('#studentFormError').filter({hasText:'입력 내용은 유지됩니다'}).waitFor();
 await a.page.getByRole('button',{name:'표현 등록',exact:true}).click();await a.page.getByText('등록했어요. 평가하기와 순화하기도 자유롭게 참여해 보세요.',{exact:true}).waitFor();
 await t.getByRole('heading',{name:'힐링',exact:true}).waitFor();assert.equal(await t.evaluate(()=>state.data.wordCount),1);
 await a.page.getByLabel('순화할 표현',{exact:true}).fill('돌아올 초안');await a.page.getByLabel('순화할 표현',{exact:true}).focus();await a.page.evaluate(()=>window.__draftInput=document.querySelector('[name=word]'));
 await fillWord(b.page,'킹받네');await b.page.getByRole('button',{name:'표현 등록',exact:true}).click();await t.getByRole('heading',{name:'킹받네',exact:true}).waitFor();
 await a.page.waitForFunction(()=>state.data.wordCount===2);assert.equal(await a.page.getByLabel('순화할 표현',{exact:true}).inputValue(),'돌아올 초안');assert.equal(await a.page.evaluate(()=>window.__draftInput===document.querySelector('[name=word]')),true,'live response must preserve focused form DOM');
 await a.page.reload();await a.page.getByLabel('순화할 표현',{exact:true}).waitFor();assert.equal(await a.page.locator('#studentNicknameForm').count(),0);assert.equal(await a.page.getByLabel('순화할 표현',{exact:true}).inputValue(),'돌아올 초안');
 await a.page.evaluate(()=>window.scrollTo(0,450));assert.ok((await a.page.locator('.student-tabs').boundingBox()).y<=1,'activity navigator stays at screen top');await shot(a.page,'student-mobile-collect');
 console.log('PASS: initial nickname gate, free stage navigation, retained drafts, lost-response retry and mobile-to-PC live response without replacing form');
 await b.page.locator('[data-tab=rate]').click();await b.page.getByRole('button',{name:'힐링 5점',exact:true}).click();await b.page.getByText('내 평가 5점',{exact:true}).waitFor();
 await a.page.locator('[data-tab=refine]').click();await a.page.getByRole('button',{name:'순화어 제안',exact:true}).click();
 await a.page.getByLabel('새로 제안하는 순화어').fill('마음쉼');await a.page.getByLabel('순화어의 뜻').fill('편안히 쉬는 시간');await a.page.getByLabel('바꾼 이유',{exact:true}).fill('뜻이 쉽게 전해져요.');await a.page.getByLabel('순화어를 사용한 예문').fill('산책하며 마음쉼을 했어.');assert.equal(await a.page.getByLabel('닉네임',{exact:true}).count(),0);await a.page.getByText('작성자 · 달빛책갈피',{exact:true}).waitFor();
 await a.page.getByRole('button',{name:'순화어 등록',exact:true}).click();await a.page.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
 await b.page.locator('[data-tab=refine]').click();await b.page.getByRole('button',{name:'마음쉼 3점',exact:true}).click();await b.page.getByText('내 평가 3점',{exact:true}).waitFor();await shot(b.page,'student-mobile-refine');
 await t.locator('[data-tab=approval]').click();await t.getByRole('button',{name:'승인',exact:true}).waitFor();assert.equal(await t.evaluate(()=>state.admin),false);assert.equal(await t.locator('#dialog').evaluate(el=>el.open),false);
 await t.getByRole('button',{name:'승인',exact:true}).click();await t.getByRole('tab',{name:/승인 완료/}).click();await t.getByText('편찬 완료',{exact:true}).waitFor();
 await b.page.getByText('편찬 완료',{exact:true}).waitFor();
 const revisionId=(await database.db.query('select id from public.dictionary_revisions')).rows[0].id;
 assert.match(await b.page.evaluate(async id=>{try{await AppApi.call('selectRevision',id,false);return '';}catch(e){return e.message;}},revisionId),/학생 전용/);
 await b.page.getByRole('button',{name:'마음쉼 1점',exact:true}).click();await t.locator('[data-tab=published]').click();await t.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();assert.match(await t.locator('.entry-class').innerText(),/달빛책갈피/);
 await shot(t,'teacher-live-response-desktop');
 const preview=await teacher.context.newPage();await join(preview,entry,'미리보기');assert.equal(await preview.evaluate(()=>window.__authScope),'student');assert.equal(await t.evaluate(()=>window.__authScope),'teacher');await preview.close();
 console.log('PASS: automatic nickname attribution, candidate rating, live approval without password, independent teacher/student sessions, students cannot approve');
 assert.equal(await t.locator('[data-edit-item]').count(),0);await t.getByRole('button',{name:'관리자 로그인',exact:true}).click();await t.getByLabel('관리자 비밀번호').fill('bad');await t.getByRole('button',{name:'로그인',exact:true}).click();await t.locator('#modalError').filter({hasText:'비밀번호'}).waitFor();
 await t.getByLabel('관리자 비밀번호').fill('admin123');await t.getByRole('button',{name:'로그인',exact:true}).click();await t.getByRole('button',{name:'마음쉼 순화어 수정',exact:true}).click();
 await t.getByLabel('순화어',{exact:true}).fill('마음쉬기');await t.getByRole('button',{name:'수정 저장',exact:true}).click();await t.getByRole('heading',{name:'마음쉬기',exact:true}).waitFor();await b.page.getByRole('heading',{name:'마음쉬기',exact:true}).waitFor();
 await t.locator('[data-tab=collect]').click();await t.getByRole('button',{name:'힐링 표현 수정',exact:true}).click();await t.getByLabel('이 표현의 뜻').fill('마음이 편히 쉬는 시간');await t.getByRole('button',{name:'수정 저장',exact:true}).click();await t.getByText('마음이 편히 쉬는 시간',{exact:true}).waitFor();
 await t.getByRole('button',{name:'킹받네 표현 삭제',exact:true}).click();await t.getByLabel('삭제하려면 ‘삭제’를 입력해 주세요.').fill('삭제');await t.getByRole('button',{name:'삭제하기',exact:true}).click();await t.waitForFunction(()=>state.data.wordCount===1);
 await t.locator('[data-tab=published]').click();await t.getByRole('button',{name:'마음쉬기 순화어 삭제',exact:true}).click();await t.getByLabel('삭제하려면 ‘삭제’를 입력해 주세요.').fill('삭제');await t.getByRole('button',{name:'삭제하기',exact:true}).click();await t.getByText('교사가 승인한 순화어가 이곳에 편찬됩니다.',{exact:true}).waitFor();await b.page.waitForFunction(()=>state.data.revisionCount===0);
 await t.getByRole('button',{name:'관리자 메뉴',exact:true}).click();await t.getByRole('button',{name:'관리자 로그아웃',exact:false}).click();await t.getByRole('button',{name:'관리자 로그인',exact:true}).waitFor();assert.equal(await t.locator('[data-edit-item]').count(),0);assert.equal(await t.evaluate(()=>state.teacher),true);
 console.log('PASS: admin123-only content editing, original/proposal deletion, cascade cleanup, live PC-to-mobile edits, logout preserves password-free teacher authority');
 await t.getByRole('button',{name:'관리자 로그인',exact:true}).click();await t.getByLabel('관리자 비밀번호').fill('admin123');await t.getByRole('button',{name:'로그인',exact:true}).click();await t.getByRole('button',{name:'관리자 메뉴',exact:true}).click();await t.getByRole('button',{name:'사전 삭제',exact:false}).click();await t.getByLabel('삭제하려면 ‘삭제’를 입력해 주세요.').fill('삭제');await t.getByRole('button',{name:'사전과 모든 자료 삭제',exact:true}).click();await t.getByRole('button',{name:'사전 열기',exact:true}).waitFor();
 await b.page.getByRole('alert').filter({hasText:'삭제되었거나 없는 사전'}).waitFor();
 for(const table of ['class_dictionaries','dictionary_words','dictionary_revisions','dictionary_word_ratings','dictionary_revision_ratings','dictionary_student_sessions','dictionary_student_links'])assert.equal(Number((await database.db.query('select count(*) n from public.'+table)).rows[0].n),0,table);
 const invalid=await a.context.newPage();await invalid.goto(origin+'/student.html');await invalid.getByText('교사가 공유한 QR이나 학생 입장 링크로 들어와 주세요.',{exact:true}).waitFor();assert.equal(await invalid.locator('.dictionary-enter').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: classroom deletion broadcasts to students, invalid student URL never opens teacher app, no page errors');
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));await database.db.close();}
