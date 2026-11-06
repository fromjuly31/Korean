import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createDatabase,installTestClient,root } from './support/database.mjs';

const database = await createDatabase();
const files = new Set(['index.html','app.js','style.css','config.js','supabase-api.js']);
const server = createServer(async (request,response) => {
  const file = new URL(request.url,'http://localhost').pathname.slice(1) || 'index.html';
  if(!files.has(file)) {response.writeHead(404).end();return;}
  response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
  response.end(await readFile(new URL('site/'+file,root)));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
let dropResponse = false;
async function newStudent(configured = true) {
  const userId = await database.newUser();
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  await context.exposeBinding('__database',async (_source,request) => {
    const result = await database.execute(userId,request);
    if(dropResponse && request.rpc==='dictionary_add_word') {
      dropResponse=false; return {data:null,error:{message:'Failed to fetch'}};
    }
    return result;
  });
  if(configured) await context.route('**/config.js',route => route.fulfill({contentType:'text/javascript',body:"window.APP_CONFIG={supabaseUrl:'https://test.invalid',supabasePublishableKey:'test'};"}));
  await context.route('https://**/*',route => route.fulfill({contentType:'text/javascript',body:`(${installTestClient.toString()})('${userId}')`}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message)); return page;
}
const screenshot=async(page,name)=>page.screenshot({path:fileURLToPath(new URL('test-results/'+name+'.png',root)),fullPage:true});
try {
  browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  await mkdir(new URL('test-results/',root),{recursive:true});
  const owner = await newStudent(); await owner.goto(origin);
  await owner.getByText('아직 등록된 학급이 없어요. 우리 학급의 첫 사전을 만들어 보세요.').waitFor();
  assert.equal(await owner.locator('input[type=password]').count(),0);
  await screenshot(owner,'home-desktop');
  await owner.setViewportSize({width:390,height:844});
  assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await screenshot(owner,'home-mobile');
  await owner.getByRole('button',{name:'+ 우리 학급 만들기'}).click();
  await owner.getByLabel('학교',{exact:true}).fill('한빛중학교');
  await owner.getByLabel('학년',{exact:true}).fill('2학년');
  await owner.getByLabel('반',{exact:true}).fill('3반');
  await owner.getByRole('button',{name:'만들고 입장하기'}).click();
  await owner.getByRole('button',{name:'+ 순화할 말 등록'}).waitFor();
  const roomUrl = owner.url();
  await owner.setViewportSize({width:1280,height:900});
  console.log('PASS: 첫 접속에 코드·비밀번호 없음, 모바일에서 학급 생성·입장');

  await owner.getByRole('button',{name:'+ 순화할 말 등록'}).click();
  await owner.getByLabel('순화할 표현',{exact:true}).fill('힐링');
  await owner.getByLabel('표현 유형').selectOption('외래어');
  await owner.getByLabel('이 표현의 뜻').fill('마음이 편안해지는 일');
  await owner.getByLabel('순화가 필요한 이유').fill('쉬운 우리말로 바꾸고 싶어요.');
  dropResponse=true;
  await owner.getByRole('button',{name:'등록 완료',exact:true}).click();
  await owner.locator('#modalError').filter({hasText:'입력 내용은 유지됩니다'}).waitFor();
  assert.equal(await owner.getByLabel('순화할 표현',{exact:true}).inputValue(),'힐링');
  await owner.getByRole('button',{name:'등록 완료',exact:true}).click();
  await owner.getByRole('heading',{name:'힐링',exact:true}).waitFor();
  assert.equal((await database.db.query('select count(*)::int as n from public.dictionary_words')).rows[0].n,1);
  assert.equal(await owner.getByRole('button',{name:'힐링 5점',exact:true}).count(),0);
  console.log('PASS: 표현 등록, 저장 응답 유실 시 입력 보존·중복 없이 재시도, 자기 평가 차단');

  const peer = await newStudent(); await peer.goto(origin);
  await peer.getByRole('button',{name:'학급 입장 →',exact:true}).click();
  await peer.locator('[data-tab=rate]').click();
  await peer.getByRole('button',{name:'힐링 5점',exact:true}).click();
  await peer.getByText('내 평가 5점',{exact:true}).waitFor();
  await owner.locator('[data-tab=refine]').click();
  await owner.getByRole('button',{name:'+ 순화어 제안'}).click();
  await owner.getByLabel('새로 제안하는 순화어').fill('마음쉼');
  await owner.getByLabel('순화어의 뜻').fill('지친 마음을 편안하게 쉬게 하는 일');
  await owner.getByLabel('바꾼 이유',{exact:true}).fill('뜻을 더 쉽게 이해할 수 있어요.');
  await owner.getByLabel('순화어를 사용한 예문').fill('산책하며 마음쉼을 했어.');
  await owner.getByRole('button',{name:'순화어 등록',exact:true}).click();
  await owner.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
  await peer.locator('[data-tab=refine]').click();
  await peer.getByRole('button',{name:'마음쉼 5점',exact:true}).click();
  await peer.getByText('내 평가 5점',{exact:true}).waitFor();
  await peer.locator('[data-tab=published]').click();
  await peer.getByText('평균 4점 이상인 순화어를 교사가 선택하면 이곳에 편찬됩니다.',{exact:true}).waitFor();
  console.log('PASS: 원본 별점 → 순화어 제안 → 순화어 별점, 고평점만으로 자동 편찬되지 않음');

  const teacher = await newStudent(); await teacher.goto(roomUrl);
  await teacher.getByRole('button',{name:'교사·관리자',exact:true}).click();
  await teacher.getByLabel('관리자 비밀번호').fill('wrong');
  await teacher.getByRole('button',{name:'관리자로 입장',exact:true}).click();
  await teacher.locator('#modalError').filter({hasText:'비밀번호가 다르거나'}).waitFor();
  await teacher.getByLabel('관리자 비밀번호').fill('admin123');
  await teacher.getByRole('button',{name:'관리자로 입장',exact:true}).click();
  await teacher.getByText('교사·관리자 모드',{exact:true}).waitFor();
  await teacher.locator('[data-tab=refine]').click();
  await teacher.getByRole('button',{name:'교사 선택 · 사전 편찬',exact:true}).click();
  await teacher.getByText('최종 사전 편찬',{exact:true}).waitFor();
  await peer.getByRole('button',{name:'새로고침',exact:true}).click();
  await peer.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
  await screenshot(peer,'dictionary-desktop');
  await peer.setViewportSize({width:390,height:844});
  assert.equal(await peer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await screenshot(peer,'dictionary-mobile');
  await peer.reload(); await peer.locator('[data-tab=published]').click();
  await peer.getByRole('heading',{name:'마음쉼',exact:true}).waitFor();
  console.log('PASS: admin123 서버 인증 → 교사 선택 → 학생 최종 사전 표시, 새로고침·모바일 유지');

  await database.db.exec('update public.dictionary_settings set write_limit_bytes=1');
  await owner.locator('[data-tab=collect]').click();
  await owner.getByText('무료 저장 용량 보호를 위해 새 저장을 중단했어요.',{exact:true}).waitFor();
  assert.equal(await owner.getByRole('button',{name:'+ 순화할 말 등록'}).isDisabled(),true);
  await teacher.getByRole('button',{name:'새로고침',exact:true}).click();
  await teacher.getByRole('button',{name:'학급 삭제',exact:true}).click();
  await teacher.getByLabel('삭제하려면 아래에 ‘삭제’를 입력해 주세요.').fill('삭제');
  await teacher.getByRole('button',{name:'학급과 모든 자료 삭제',exact:true}).click();
  await teacher.getByText('아직 등록된 학급이 없어요. 우리 학급의 첫 사전을 만들어 보세요.').waitFor();
  for(const table of ['class_dictionaries','dictionary_words','dictionary_word_ratings','dictionary_revisions','dictionary_revision_ratings']) {
    assert.equal((await database.db.query('select count(*)::int as n from public.'+table)).rows[0].n,0,table);
  }
  await peer.getByRole('button',{name:'새로고침',exact:true}).click();
  await peer.getByText('삭제되었거나 없는 학급입니다. 학급 목록으로 돌아가 주세요.',{exact:true}).waitFor();
  console.log('PASS: 무료 용량 저장 차단, 관리자 학급 삭제와 DB 전체 하위 자료 삭제');

  const disconnected=await newStudent(false);await disconnected.goto(origin);
  await disconnected.getByText('데이터 저장소 연결을 준비하고 있습니다. 연결이 완료되면 학급을 만들고 저장할 수 있어요.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: DB 미연결 상태를 명확히 표시, 브라우저 실행 오류 없음');
} finally {
  if(browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
  await database.db.close();
}
