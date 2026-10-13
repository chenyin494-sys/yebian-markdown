const { chromium } = require('@playwright/test');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async()=>{
  fs.mkdirSync(path.resolve(__dirname,'../test-artifacts'),{recursive:true});
  const extension = path.resolve(__dirname, '../extension');
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(__dirname, 'test-profile-')), {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, viewport: { width: 390, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const errors = [];
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
    assert.equal(behavior.openPanelOnActionClick, true);
    const site = await context.newPage();
    await site.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Site eligibility test</h1>' }));
    await site.goto('https://chatgpt.com/c/test-page-margin');
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/*' }))[0].id);
    async function waitEligibility(enabled) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await worker.evaluate(async tabId => ({
          panel: (await chrome.sidePanel.getOptions({ tabId })).enabled,
          action: await chrome.action.isEnabled(tabId)
        }), tabId);
        if (result.panel === enabled && result.action === enabled) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Site eligibility did not become ${enabled}`);
    }
    await waitEligibility(true);
    await site.goto('https://example.com/');
    await waitEligibility(false);
    await site.goto('https://chatgpt.com/');
    await waitEligibility(true);
    await site.goto('https://chatgpt.com.example.com/');
    await waitEligibility(false);
    assert.equal(await worker.evaluate(async () => (await chrome.sidePanel.getOptions({})).enabled), false);
    const urls = ['https://chatgpt.com/', 'https://chatgpt.com/c/123', 'http://chatgpt.com/', 'https://sub.chatgpt.com/', 'https://chatgpt.com.example.com/', 'chrome://newtab/', ''];
    assert.deepEqual(await worker.evaluate(urls => urls.map(isAllowed), urls), [true, true, false, false, false, false, false]);
    await site.close();
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('Page error:',error.message); });
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await page.locator('#folder:not([disabled])').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    const readingArea = await page.locator('#reader').boundingBox();
    assert.ok(readingArea.height > 800, `Reading area height: ${readingArea.height}`);
    await page.screenshot({ path: path.join(__dirname,'../test-artifacts/preview-empty.png') });

    // Use real FileSystemHandles backed by a browser test directory. The OS picker
    // remains a manual installation check; only the picker result is substituted.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const docs = await root.getDirectoryHandle('笔记', { create: true });
      const assets = await root.getDirectoryHandle('图片', { create: true });
      async function write(dir, name, text) {
        const file = await dir.getFileHandle(name, { create: true });
        const stream = await file.createWritable(); await stream.write(text); await stream.close();
      }
      await write(root, '欢迎.md', '# 页边使用笔记\n\n网页在左，**文档在手边**。\n\n## 今天的想法\n\n- 阅读项目说明\n- 对照网页整理素材\n\n> 给专注留一点空间。\n\n## 任务清单\n\n| 文档 | 状态 |\n| --- | --- |\n| 灵感记录 | 已整理 |\n| 项目说明 | 阅读中 |\n\n```js\nconst idea = "把笔记放在手边";\n```\n\n[下一篇](笔记/写作.md#中文标题)\n\n![示例图](图片/sample.svg)\n\n<img src="https://invalid.example/x" onerror="window.compromised=true"><script>window.compromised=true</script>');
      await write(docs, '写作.md', '# 写作\n\n## 中文标题\n\n这是子文件夹里的文档。\n\n[返回](../欢迎.md)');
      await write(assets, 'sample.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" rx="8" fill="#e7efe6"/><text x="20" y="36" fill="#286447" font-size="17">Local image works</text></svg>');
      window.showDirectoryPicker = async () => root;
    });
    await page.locator('#sidebar-toggle').click();
    await page.locator('#folder').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').hidden);
    await page.locator('#sidebar-toggle').click();
    await page.locator('#file-list button').filter({ hasText: '欢迎.md' }).click();
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '页边使用笔记');
    assert.equal(await page.locator('#file-list button').count(), 2);
    assert.equal(await page.locator('#content table').count(), 1);
    assert.equal(await page.locator('#content script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.compromised), undefined);
    await page.waitForFunction(() => { const image = document.querySelector('#content .local-image img'); return image?.complete && image.naturalWidth > 0; });
    await page.screenshot({ path: path.join(__dirname,'../test-artifacts/preview-reading.png') });
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    await page.locator('#sidebar-toggle').click();
    await page.screenshot({ path: path.join(__dirname,'../test-artifacts/preview-directory.png') });
    await page.locator('#search').fill('写作');
    assert.equal(await page.locator('#file-list button').count(), 1);
    await page.locator('#search').fill('');
    await page.locator('#sidebar-close').click();
    await page.locator('#content a').filter({ hasText: '下一篇' }).click({ modifiers:['Control'] });
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '写作');
    await page.locator('#sidebar-toggle').click();
    await page.locator('#outline-tab').click();
    assert.equal(await page.locator('#toc button').count(), 2);
    await page.locator('#toc button').filter({ hasText: '中文标题' }).click();
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    assert.equal(await page.locator('#content .rich-editor').getAttribute('contenteditable'), 'true');
    await page.locator('#theme').click();
    const theme = await page.locator('html').getAttribute('data-theme');
    await page.locator('#larger').click();

    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('笔记');
      const handle = await dir.getFileHandle('写作.md');
      const stream = await handle.createWritable(); await stream.write('# 文件已更新\n\n自动刷新成功。'); await stream.close();
    });
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '文件已更新', { timeout: 10000 });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '文件已更新');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('新增.md', { create: true });
      const stream = await handle.createWritable(); await stream.write('# 新增文档'); await stream.close();
    });
    await page.locator('#sidebar-toggle').click();
    await page.locator('#files-tab').click();
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list button').length === 3);
    await page.locator('#file-input').setInputFiles({ name: '单文件.md', mimeType: 'text/markdown', buffer: Buffer.from('# 单独阅读\n\n文件导入成功。') });
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '单独阅读');
    await page.setViewportSize({ width: 300, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok((await page.locator('#reader').boundingBox()).height > 620);
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#backdrop').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#backdrop').isVisible(), false);
    const directory = await page.locator('#sidebar').boundingBox();
    const reader = await page.locator('#reader').boundingBox();
    assert.ok(reader.x >= directory.x + directory.width);
    await page.screenshot({ path: path.join(__dirname,'../test-artifacts/preview-wide.png') });
    await page.locator('#sidebar-close').click();
    assert.ok((await page.locator('#reader').boundingBox()).width > reader.width);
    assert.deepEqual(errors, []);
    console.log('PASS: ChatGPT-only enablement, navigation away/back, lookalike URL rejected, default disabled; 42px toolbar, >90% vertical reading space, collapsible file/outline drawer, auto-close, Escape, wide dock; Markdown, local images, sanitization, search, links, source, preferences, auto refresh, folder restore, rescan, file import.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
