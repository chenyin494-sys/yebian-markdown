const {chromium}=require('@playwright/test');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
  fs.mkdirSync(path.resolve(__dirname,'../test-artifacts'),{recursive:true});
  const extension=path.resolve(__dirname,'../extension');
  const context=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(__dirname,'rich-profile-')),{
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless:true,viewport:{width:470,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
  });
  const errors=[];
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
    const url=name=>`chrome-extension://${id}/sidepanel.html?scope=${encodeURIComponent('conversation:'+name)}`;
    const page=await context.newPage();page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
    await page.goto(url('rich-alpha'));await page.locator('#folder:not([disabled])').waitFor({state:'attached'});
    const fixture='# 测试标题\n\n原段落，保留 **粗体** 和 *斜体*。\n\n## 章节\n\n- 列表第一项\n- 列表第二项\n\n> 引用原文\n\n| 名称 | 数量 |\n| :--- | ---: |\n| 茶 | 2 |\n\n```js\nconst original = "keep me";\n```\n\n![插图](../../图片/local.svg)\n\n[链接][ref]\n\n[ref]: https://example.com "引用链接"\n\n<div>嵌入的 HTML 原文</div>\n';
    await page.evaluate(async fixture=>{
      const root=await navigator.storage.getDirectory();const novel=await root.getDirectoryHandle('小说',{create:true});
      const chapters=await novel.getDirectoryHandle('正文',{create:true});const tools=await novel.getDirectoryHandle('写作工具',{create:true});
      const images=await root.getDirectoryHandle('图片',{create:true});
      async function write(dir,name,text){const handle=await dir.getFileHandle(name,{create:true});const out=await handle.createWritable();await out.write(text);await out.close();}
      await write(chapters,'第一章.md',fixture);await write(chapters,'第二章.md','# 第二章\n\n另一篇文章。');
      await write(tools,'提纲.md','# 写作提纲');
      await write(images,'local.svg','<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>');
      window.showDirectoryPicker=async()=>root;
    },fixture);
    await page.locator('#sidebar-toggle').click();await page.locator('#folder').click();
    await page.waitForFunction(()=>!document.querySelector('#document').hidden);
    await page.locator('#sidebar-toggle').click();await page.locator('#search').fill('第一章');
    await page.locator('#file-list button').filter({hasText:'第一章.md'}).click();
    await page.locator('#content h1').filter({hasText:'测试标题'}).waitFor();
    async function disk(){return page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const dir=await(await root.getDirectoryHandle('小说')).getDirectoryHandle('正文');return(await(await dir.getFileHandle('第一章.md')).getFile()).text();});}
    async function writeDisk(text){return page.evaluate(async text=>{const root=await navigator.storage.getDirectory();const dir=await(await root.getDirectoryHandle('小说')).getDirectoryHandle('正文');const h=await dir.getFileHandle('第一章.md');const w=await h.createWritable();await w.write(text);await w.close();},text);}
    async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+label);}
    assert.equal(await page.locator('textarea,#preview,#source,.rail').count(),0);
    assert.equal(await page.locator('#content .rich-editor').getAttribute('contenteditable'),'true');
    assert.equal(await disk(),fixture);
    assert.equal(await page.locator('#content strong').textContent(),'粗体');
    assert.equal(await page.locator('#content em').textContent(),'斜体');
    assert.equal(await page.locator('#content table').count(),1);
    await page.waitForFunction(()=>document.querySelector('.local-image img')?.naturalWidth>0);

    const paragraph=page.locator('#content p').filter({hasText:'原段落'});
    const before=await paragraph.evaluate(el=>{const s=getComputedStyle(el);return[s.fontFamily,s.fontSize,s.lineHeight];});
    await paragraph.click();await page.keyboard.press('End');await page.keyboard.insertText(' 新增一句。');
    await until(async()=> (await disk()).includes('新增一句'),'visible paragraph autosave');
    assert.deepEqual(await paragraph.evaluate(el=>{const s=getComputedStyle(el);return[s.fontFamily,s.fontSize,s.lineHeight];}),before);
    let saved=await disk();
    assert.ok(saved.includes('**粗体**'));assert.ok(saved.includes('*斜体*'));
    assert.ok(saved.includes('| :--- | ---: |'));assert.ok(saved.includes('```js\nconst original = "keep me";\n```'));
    assert.ok(saved.includes('![插图](../../图片/local.svg)'));assert.ok(saved.includes('[ref]: https://example.com "引用链接"'));
    assert.ok(saved.includes('<div>嵌入的 HTML 原文</div>'));assert.ok(!saved.includes('blob:'));
    await page.keyboard.press('Control+z');await until(async()=> (await disk())===fixture,'undo restores exact Markdown');
    await page.keyboard.press('Control+y');await until(async()=> (await disk()).includes('新增一句'),'redo saves');

    await page.locator('#content h1').click();await page.keyboard.press('End');await page.keyboard.insertText('已修改');
    await until(async()=> (await disk()).startsWith('# 测试标题已修改'),'heading stays heading');
    const cell=page.locator('#content td p').filter({hasText:'茶'});
    await cell.click();await page.keyboard.press('End');await page.keyboard.insertText('叶');
    await until(async()=> (await disk()).includes('茶叶'),'table edit saved');
    assert.match(await disk(),/---:/);
    assert.equal(await page.locator('#content table').count(),1);

    // Enter creates a paragraph, and rich formatting shortcuts serialize as Markdown.
    await paragraph.click();await page.keyboard.press('End');await page.keyboard.press('Enter');
    await page.keyboard.insertText('新段落');await page.keyboard.press('Control+b');await page.keyboard.insertText('加粗');await page.keyboard.press('Control+b');
    await until(async()=> (await disk()).includes('新段落**加粗**'),'new paragraph and inline formatting');

    // Native folder expansion replaces the flat path list and survives reopening.
    await page.locator('#sidebar-toggle').click();await page.locator('#search').fill('');
    const folder=page.locator('details.tree-folder[data-path="小说/正文"]');
    if(await folder.getAttribute('open')===null)await folder.locator(':scope > summary').click();
    assert.equal(await folder.locator('button').count(),2);
    await folder.locator(':scope > summary').click();assert.equal(await folder.locator('button').first().isVisible(),false);
    await page.reload();await page.locator('#folder:not([disabled])').waitFor({state:'attached'});
    assert.equal(await page.locator('details.tree-folder[data-path="小说/正文"]').getAttribute('open'),null);
    await page.locator('details.tree-folder[data-path="小说/正文"] > summary').click();
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/preview-tree.png')});
    await page.locator('#sidebar-close').click();

    // External changes refresh the same visual editor; local drafts survive conflicts.
    await writeDisk('# 外部更新标题\n\n外部更新段落。');
    await until(async()=>await page.locator('#content h1').textContent()==='外部更新标题','external rendered update');
    const updated=page.locator('#content p').filter({hasText:'外部更新段落'});
    await updated.click();await page.keyboard.press('End');await page.keyboard.insertText('本地草稿');
    await writeDisk('# 外部冲突版本\n\n外部修改');
    await page.locator('#conflict').waitFor();assert.match(await page.locator('#content').textContent(),/本地草稿/);
    await page.reload();await page.locator('#folder:not([disabled])').waitFor({state:'attached'});
    await page.locator('#conflict').waitFor();assert.match(await page.locator('#content').textContent(),/本地草稿/);
    await page.locator('#use-local').click();await until(async()=> (await disk()).includes('本地草稿'),'rich conflict resolution');

    await page.goto(url('rich-beta'));await page.locator('#folder:not([disabled])').waitFor({state:'attached'});assert.equal(await page.locator('#welcome').isVisible(),true);
    await page.goto(url('rich-alpha'));await page.locator('#folder:not([disabled])').waitFor({state:'attached'});assert.match(await page.locator('#content').textContent(),/本地草稿/);
    await page.setViewportSize({width:300,height:700});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:470,height:900});await page.screenshot({path:path.join(__dirname,'../test-artifacts/preview-direct-edit.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: directly editable reading typography; headings/bold/italic/lists/table/image; keyboard edits autosave as Markdown; untouched code/table/reference/HTML preserved; undo/redo; folder tree and expansion persistence; removed duplicate rail; external sync; conflict draft/reload/resolution; independent conversation restore; narrow layout.');
  }finally{await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
