const {chromium} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  const extension = path.resolve(__dirname,'../extension');
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(__dirname,'resize-profile-')), {
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless:true, viewport:{width:1000,height:800},
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage(); const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const url = scope=>`chrome-extension://${id}/sidepanel.html?scope=conversation:${scope}`;
    const sidebar = page.locator('#sidebar'); const handle = page.locator('#sidebar-resizer');
    const width = async()=>Math.round((await sidebar.boundingBox()).width);
    async function ready() { await page.locator('#folder:not([disabled])').waitFor({state:'attached'}); }
    async function drag(delta, release=true) {
      const box=await handle.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+120); await page.mouse.down();
      await page.mouse.move(box.x+box.width/2+delta,box.y+120,{steps:8});
      if(release) await page.mouse.up();
    }
    await page.goto(url('resize-one')); await ready();
    assert.equal(await handle.isVisible(),false);
    await page.locator('#sidebar-toggle').click();
    assert.equal(await width(),280);
    const readerBefore=(await page.locator('#reader').boundingBox()).width;
    await drag(130); assert.equal(await width(),410);
    assert.equal((await page.locator('#reader').boundingBox()).width,readerBefore-130);
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('resizing-sidebar')),false);
    await page.reload(); await ready(); assert.equal(await width(),410);
    await page.locator('#sidebar-close').click(); assert.equal(await handle.isVisible(),false);
    await page.locator('#sidebar-toggle').click(); assert.equal(await width(),410);
    await page.goto(url('resize-two')); await ready();
    await page.locator('#sidebar-toggle').click(); assert.equal(await width(),280);
    await page.goto(url('resize-one')); await ready(); assert.equal(await width(),410);
    await drag(80,false); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await width(),410); assert.equal(await sidebar.isVisible(),true);
    await handle.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await width(),400);
    await page.keyboard.press('Shift+ArrowRight'); assert.equal(await width(),440);
    await page.keyboard.press('End'); assert.equal(await width(),740);
    await page.keyboard.press('Home'); assert.equal(await width(),180);
    await drag(-150); assert.equal(await width(),180);
    await handle.dblclick(); assert.equal(await width(),280);
    await drag(160); assert.equal(await width(),440);
    await page.setViewportSize({width:700,height:800});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===440);
    await page.setViewportSize({width:680,height:800});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===420);
    await page.setViewportSize({width:1000,height:800});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===440);
    await page.setViewportSize({width:390,height:800});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===362);
    await drag(-122); assert.equal(await width(),240);
    assert.equal((await page.locator('#reader').boundingBox()).width,390);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await handle.dblclick(); assert.equal(await width(),300);
    await page.setViewportSize({width:1000,height:800});
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===280);
    // Capture the real layout with a local Markdown document.
    await page.evaluate(async()=>{
      const root=await navigator.storage.getDirectory();
      const file=await root.getFileHandle('阅读笔记.md',{create:true});
      const writer=await file.createWritable();
      await writer.write('# 文档就在手边\n\n拖动目录右侧的分隔线，调整目录与正文的宽度。\n\n## 今天的记录\n\n- 查看文件夹中的笔记\n- 点击正文直接编辑\n- 自动保存到本地文件\n\n> 把更多空间留给正在阅读的内容。');
      await writer.close(); window.showDirectoryPicker=async()=>root;
    });
    await page.locator('#folder').click(); await page.locator('#content h1').waitFor();
    await drag(50);
    fs.mkdirSync(path.resolve(__dirname,'../test-artifacts'),{recursive:true});
    await page.screenshot({path:path.resolve(__dirname,'../test-artifacts/resize.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: divider drag, reader reflow, width limits, per-conversation persistence, reopen, keyboard sizing, Escape cancellation, double-click reset, responsive clamping and overlay resizing.');
  } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
