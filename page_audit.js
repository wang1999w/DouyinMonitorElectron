/**
 * 全面页面结构探查
 * 逐页分析：首页 → 搜索结果 → 视频页 → 博主主页
 * 每页截图 + DOM分析 + 元素位置记录
 */
const { app, BrowserWindow, BrowserView, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const DIR = path.join(__dirname, 'page_audit');
let dw;
function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function js(s) { try { return await dw.executeJavaScript(s); } catch(e) { return null; } }
async function shot(name) { try { if(!fs.existsSync(DIR))fs.mkdirSync(DIR,{recursive:true}); const img=await dw.capturePage(); fs.writeFileSync(path.join(DIR,name+'.png'),img.toPNG()); log(`  截图: ${name}.png`); } catch(e){log(`  截图失败: ${e.message}`);} }

app.whenReady().then(async () => {
  for (const p of ['bytedance','sslocal','snssdk','aweme']) { try{protocol.handle(p,()=>new Response('',{status:200}));}catch(e){} }

  const mw = new BrowserWindow({width:1400,height:900,webPreferences:{contextIsolation:true}});
  mw.loadFile(path.join(__dirname,'renderer/index.html'));
  const bv = new BrowserView({webPreferences:{nodeIntegration:false,contextIsolation:true,disableBlinkFeatures:'AutomationControlled',webSecurity:false}});
  mw.setBrowserView(bv);
  bv.setBounds({x:0,y:0,width:840,height:900});
  dw = bv.webContents;

  async function inspectPage(label) {
    log(`\n========== ${label} ==========`);
    await shot(label);

    // URL和标题
    const url = await js('location.href');
    const title = await js('document.title');
    log(`URL: ${url}`);
    log(`标题: ${title}`);

    // 所有 data-e2e 元素
    const e2e = await js(`(function(){
      return Array.from(document.querySelectorAll('[data-e2e]')).map(e=>{
        const r=e.getBoundingClientRect();
        return {e2e:e.getAttribute('data-e2e'),tag:e.tagName,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),text:(e.innerText||'').substring(0,40)};
      }).filter(e=>e.w>0&&e.h>0);
    })()`);
    log(`data-e2e元素: ${e2e.length}个`);
    e2e.forEach(e=>log(`  [${e.e2e}] ${e.tag} (${e.x},${e.y}) ${e.w}x${e.h} "${e.text}"`));

    // 所有可见 input
    const inputs = await js(`(function(){
      return Array.from(document.querySelectorAll('input')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).map(e=>{
        const r=e.getBoundingClientRect();
        return {type:e.type,ph:e.placeholder.substring(0,20),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};
      });
    })()`);
    log(`input元素: ${inputs.length}个`);
    inputs.forEach(i=>log(`  type=${i.ph?"\""+i.ph+"\"":""} pos=(${i.x},${i.y}) ${i.w}x${i.h}`));

    // 视频链接
    const vids = await js(`(function(){
      const s=new Set();
      document.querySelectorAll('a[href*="/video/"]').forEach(a=>{
        const m=(a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
        if(m)s.add(m[1]);
      });
      return s.size;
    })()`);
    log(`视频链接: ${vids}个`);

    // 用户链接
    const users = await js(`(function(){
      const s=new Set();
      document.querySelectorAll('a[href*="/user/"]').forEach(a=>{
        const m=(a.getAttribute('href')||'').match(/\\/user\\/(\\w+)/);
        if(m)s.add(m[1]);
      });
      return s.size;
    })()`);
    log(`用户链接: ${users}个`);

    // 评论相关
    const comments = await js(`(function(){
      return {
        sideCard: !!document.querySelector('#videoSideCard'),
        sideCardW: document.querySelector('#videoSideCard')?.clientWidth||0,
        commentList: !!document.querySelector('[data-e2e="comment-list"]'),
        commentItems: document.querySelectorAll('[data-e2e="comment-list"]>div>div').length,
        commentIcon: !!document.querySelector('[data-e2e="comment-icon"]'),
        commentIconText: document.querySelector('[data-e2e="comment-icon"]')?.parentElement?.innerText?.substring(0,20)||'',
       抢首评: document.body.innerText.includes('抢首评')
      };
    })()`);
    log(`评论区: sideCard=${comments.sideCard}(w=${comments.sideCardW}) list=${comments.commentList} items=${comments.commentItems} icon=${comments.commentIcon}(${comments.commentIconText}) 抢首评=${comments['抢首评']}`);
  }

  // ===== 首页 =====
  dw.loadURL('https://www.douyin.com');
  await sleep(8000);
  await js('Object.defineProperty(navigator,"webdriver",{get:()=>false})').catch(()=>{});
  await inspectPage('01_首页');

  // ===== 搜索 =====
  log('\n========== 搜索操作 ==========');
  // 输入
  await js(`document.querySelector('[data-e2e="searchbar-input"]').focus();document.querySelector('[data-e2e="searchbar-input"]').click();`);
  await sleep(500);
  await dw.insertText('#双眼皮');
  await sleep(800);
  log('输入完成');

  // 关闭下拉菜单
  await dw.sendInputEvent({type:'mouseMove',x:400,y:400});
  await sleep(300);
  await dw.sendInputEvent({type:'mouseDown',x:400,y:400,button:'left',clickCount:1});
  await sleep(50);
  await dw.sendInputEvent({type:'mouseUp',x:400,y:400,button:'left',clickCount:1});
  await sleep(500);
  log('下拉菜单已关闭');

  // 重新聚焦搜索框
  await js(`document.querySelector('[data-e2e="searchbar-input"]').focus();`);
  await sleep(300);

  // Enter 搜索
  await dw.sendInputEvent({type:'keyDown',key:'Enter',keyCode:13});
  await sleep(50,100);
  await dw.sendInputEvent({type:'keyUp',key:'Enter',keyCode:13});
  log('已按回车搜索');
  await sleep(8000);

  await inspectPage('02_搜索结果');

  // ===== 点击视频标签 =====
  log('\n========== 切换视频标签 ==========');
  const tabPos = await js(`(function(){
    const tabs=document.querySelectorAll('span');
    for(const t of tabs){
      if(t.innerText.trim()==='视频'){
        const r=t.getBoundingClientRect();
        if(r.width>10&&r.height>10&&r.y>30&&r.y<200)
          return{x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`);
  log(`视频标签位置: ${JSON.stringify(tabPos)}`);
  if(tabPos){
    await dw.sendInputEvent({type:'mouseMove',x:tabPos.x,y:tabPos.y});
    await sleep(200);
    await dw.sendInputEvent({type:'mouseDown',x:tabPos.x,y:tabPos.y,button:'left',clickCount:1});
    await sleep(50);
    await dw.sendInputEvent({type:'mouseUp',x:tabPos.x,y:tabPos.y,button:'left',clickCount:1});
    await sleep(3000);
    await inspectPage('03_视频标签');
  }

  // ===== 筛选 =====
  log('\n========== 筛选操作 ==========');
  const filterPos = await js(`(function(){
    for(const el of document.querySelectorAll('*')){
      const t=(el.innerText||'').trim();
      if(t.includes('筛选')&&t.length<10){
        const r=el.getBoundingClientRect();
        if(r.width>20&&r.width<120&&r.y>30&&r.y<300)
          return{x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`);
  log(`筛选按钮: ${JSON.stringify(filterPos)}`);
  if(filterPos){
    // 悬停打开
    await dw.sendInputEvent({type:'mouseMove',x:filterPos.x,y:filterPos.y});
    await sleep(2500);
    await inspectPage('04_筛选面板');

    // 点击"最新发布"
    const sortPos = await js(`(function(){
      for(const el of document.querySelectorAll('*')){
        const t=(el.innerText||'').trim();
        if(t==='最新发布'){
          const r=el.getBoundingClientRect();
          if(r.width>10&&r.height>10&&r.y>50)return{x:r.x+r.width/2,y:r.y+r.height/2};
        }
      }
      return null;
    })()`);
    log(`最新发布位置: ${JSON.stringify(sortPos)}`);
    if(sortPos){
      await dw.sendInputEvent({type:'mouseMove',x:sortPos.x,y:sortPos.y});
      await sleep(200);
      await dw.sendInputEvent({type:'mouseDown',x:sortPos.x,y:sortPos.y,button:'left',clickCount:1});
      await sleep(50);
      await dw.sendInputEvent({type:'mouseUp',x:sortPos.x,y:sortPos.y,button:'left',clickCount:1});
      await sleep(1500);
      await inspectPage('05_选择排序');
    }

    // 关闭筛选
    await dw.sendInputEvent({type:'mouseMove',x:filterPos.x,y:filterPos.y});
    await sleep(200);
    await dw.sendInputEvent({type:'mouseDown',x:filterPos.x,y:filterPos.y,button:'left',clickCount:1});
    await sleep(50);
    await dw.sendInputEvent({type:'mouseUp',x:filterPos.x,y:filterPos.y,button:'left',clickCount:1});
    await sleep(2000);
    await inspectPage('06_筛选后');
  }

  log('\n=== 审计完成 ===');
  await sleep(2000);
  app.quit();
});
