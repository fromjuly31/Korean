import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDatabase,createApi,root} from './support/database.mjs';

const database=await createDatabase();
const writer=await database.newUser(),reviewer=await database.newUser();
await database.db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[{dictionary_nickname:'민트초코'},writer]);
const api=await createApi(database,writer);
const first=await api('createClass',{school:'가람고등학교',grade:'1',className:'7'});
const second=await api('createClass',{school:'나래고등학교',grade:'2학년',className:'4반'});
await api('createClass',{school:'아직편찬전학교',grade:'1',className:'1'});
for(let i=0;i<28;i++) {
  const wordId=randomUUID(),revisionId=randomUUID();
  await database.db.query('insert into public.dictionary_words(id,class_id,owner_id,word,category,meaning,reason) values($1,$2,$3,$4,$5,$6,$7)',[wordId,i%2?second.id:first.id,writer,i<2?'킹받네':'원래표현'+i,'유행어','원래 뜻','원래 이유']);
  await database.db.query('insert into public.dictionary_revisions(id,word_id,owner_id,word,meaning,reason,example,selected) values($1,$2,$3,$4,$5,$6,$7,$8)',[revisionId,wordId,writer,i===0?'은근히 약 오르네':i===1?'웃긴데 얄밉다':'순화어'+String(i).padStart(2,'0'),i===0?'<script>window.__unsafe=true</script>':'다 함께 이해할 수 있는 뜻','바꾼 이유',('발표를 준비하며 친구에게 말했어. ').repeat(5),i<26]);
  await database.db.query('insert into public.dictionary_revision_ratings(revision_id,owner_id,rating) values($1,$2,5)',[revisionId,reviewer]);
}
const siteRoot=resolve(fileURLToPath(new URL('site/',root)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.png':'image/png'};
const server=createServer(async(req,res)=>{
  try{
    let path=resolve(siteRoot,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(path!==siteRoot&&!path.startsWith(siteRoot+sep)){res.writeHead(403).end();return;}
    if((await stat(path)).isDirectory())path=resolve(path,'index.html');
    res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(await readFile(path));
  }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser,failNext=false,delayNext=false;
const errors=[];
try {
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  context.setDefaultTimeout(15000);
  await mkdir(new URL('test-results/',root),{recursive:true});
  await context.exposeBinding('__database',async(_,{rpc,args})=>{
    assert.equal(rpc,'dictionary_browse');
    if(failNext){failNext=false;return {data:null,error:{message:'Failed to fetch'}};}
    if(delayNext){delayNext=false;await new Promise(done=>setTimeout(done,700));}
    const result=await database.asUser(null,'select public.dictionary_browse($1,$2,$3,$4) result',[args.p_view,args.p_search,args.p_class_id,args.p_offset],'anon');
    return {data:result.rows[0].result,error:null};
  });
  await context.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:"window.APP_CONFIG={supabaseUrl:'https://test.invalid',supabasePublishableKey:'test'};"}));
  await context.route('**/assets/supabase-*.js',route=>route.fulfill({contentType:'text/javascript',body:"window.supabase={createClient:()=>({rpc:(rpc,args)=>window.__database({rpc,args}),auth:{getSession:async()=>({data:{session:null},error:null}),signInAnonymously:async()=>{throw Error('Dictionary browsing must not sign in');}}})};"}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const settled=async()=>page.waitForFunction(()=>{
    const params=new URLSearchParams(location.hash.slice(1));
    return state.view==='dictionary'&&libraryState.data&&!document.querySelector('#app[aria-busy=true]')
      &&libraryState.tab===(params.get('tab')||'words')
      &&libraryState.classId===(params.get('class')||'')
      &&libraryState.search===(params.get('q')||'')
      &&libraryState.offset===(Number(params.get('page')||1)-1)*24;
  });
  await page.goto(origin);await page.getByRole('link',{name:'사전 입장',exact:true}).waitFor();
  await page.screenshot({path:'test-results/library-home-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/library-home-mobile.png',fullPage:true});
  await page.getByRole('link',{name:'사전 입장',exact:true}).click();await settled();
  assert.equal(await page.getByRole('tab',{name:'단어별 보기'}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.library-entry').count(),24);
  assert.match(await page.locator('.library-stats').innerText(),/26/);
  await page.getByRole('button',{name:'다음',exact:true}).click();await settled();assert.equal(await page.locator('.library-entry').count(),2);
  await page.reload();await settled();assert.equal(await page.locator('.library-entry').count(),2);
  await page.getByRole('tab',{name:'단어별 보기'}).focus();await page.keyboard.press('ArrowRight');await settled();
  assert.equal(await page.getByRole('tab',{name:'반별로 보기'}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.library-class').count(),2);
  assert.equal(await page.getByRole('heading',{name:'1학년 7반',exact:true}).count(),1);
  assert.equal(await page.getByRole('heading',{name:'2학년 4반',exact:true}).count(),1);
  assert.equal(await page.getByText('아직편찬전학교').count(),0);
  await page.getByRole('link',{name:'가람고등학교 · 1학년 7반 사전 보기',exact:true}).click();await settled();
  assert.equal(await page.locator('.library-entry').count(),13);
  assert.equal(await page.getByRole('heading',{name:'1학년 7반의 사전'}).count(),1);
  await page.getByRole('tab',{name:'단어별 보기'}).click();await settled();
  await page.getByRole('searchbox',{name:'사전 단어 검색'}).fill('킹받네');await page.getByRole('button',{name:'사전 검색 실행'}).click();await settled();
  assert.equal(await page.locator('.library-entry').count(),2);
  assert.ok((await page.locator('.entry-author').allTextContents()).every(name=>name.includes('민트초코')));
  assert.ok((await page.locator('.library-entry .definitions').allTextContents()).every(text=>!text.includes('민트초코')));
  assert.match(await page.locator('#libraryResults').innerText(),/1학년 7반/);assert.match(await page.locator('#libraryResults').innerText(),/2학년 4반/);
  assert.equal(await page.evaluate(()=>Boolean(window.__unsafe)),false);
  for(const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${width}`);
  }
  await page.screenshot({path:'test-results/library-words-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/library-words-mobile.png',fullPage:true});
  failNext=true;await page.getByRole('button',{name:'사전 새로고침'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('.library-entry').count(),2);
  await page.getByRole('button',{name:'다시 불러오기'}).click();await settled();assert.equal(await page.getByRole('alert').count(),0);
  await page.getByRole('searchbox',{name:'사전 단어 검색'}).fill('없는말');await page.getByRole('button',{name:'사전 검색 실행'}).click();await settled();await page.getByText('검색된 단어가 없습니다. 원래 표현이나 순화어로 다시 찾아보세요.').waitFor();
  delayNext=true;await page.getByRole('searchbox',{name:'사전 단어 검색'}).fill('킹받네');await page.getByRole('button',{name:'사전 검색 실행'}).click();
  await page.getByRole('tab',{name:'반별로 보기'}).click();await settled();await page.waitForTimeout(900);assert.equal(await page.locator('.library-class').count(),2);assert.equal(await page.locator('.library-entry').count(),0);
  await page.getByRole('searchbox',{name:'사전 학급 검색'}).fill('1학년 7반');await page.getByRole('button',{name:'사전 검색 실행'}).click();await settled();assert.equal(await page.locator('.library-class').count(),1);
  await page.reload();await settled();assert.equal(await page.locator('.library-class').count(),1);
  await page.screenshot({path:'test-results/library-classes-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: public browsing without sign-in, published-only results, cross-class word search, class tabs and suffixes, keyboard tabs, pagination and reload, error recovery, stale response isolation, escaped content, responsive layouts.');
} finally {if(browser)await browser.close();await new Promise(done=>server.close(done));await database.db.close();}
