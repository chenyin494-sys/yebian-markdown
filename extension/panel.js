import { isMarkdown, resolveLocal, headingSlug } from './paths.js';
import { record, scopedKey, encodeSnapshot } from './storage.js';
import { DocumentSession } from './document-session.js';
import { RichMarkdown } from './vendor/rich-editor.js';

const $ = id => document.getElementById(id);
const state = { root: null, entries: [], current: null, session: null, text: '', revision: 0, directories: [], polling: false, busy: false };
let workspaceState = await record(scopedKey('workspace')).catch(() => null) || { libraryId: crypto.randomUUID(), lastPath: '', positions: {} };
try {
  const meta = JSON.parse(localStorage.getItem(scopedKey('workspace-meta')));
  if (meta?.libraryId === workspaceState.libraryId) Object.assign(workspaceState, meta);
} catch { /* Optional position cache. */ }
let rich;
const prefs = (() => { try { return JSON.parse(localStorage.getItem(scopedKey('preferences'))) || {}; } catch { return {}; } })();
let sidebarOpen = prefs.sidebarOpen === true;
let sidebarMode = prefs.sidebarMode === 'outline' ? 'outline' : 'files';
const narrowLayout = matchMedia('(max-width: 679px)');
let fontSize = Math.max(12, Math.min(24, Number(prefs.fontSize) || 15));
document.documentElement.dataset.theme = prefs.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('auto').checked = prefs.auto !== false;
function savePrefs() {
  try { localStorage.setItem(scopedKey('preferences'), JSON.stringify({ theme: document.documentElement.dataset.theme, fontSize, auto: $('auto').checked, sidebarOpen, sidebarMode })); }
  catch { /* Reading remains available when preference storage is full. */ }
}
function applySize() { $('content').style.setProperty('--reading-size', fontSize + 'px'); savePrefs(); }
applySize();
let noticeTimer;
function status(message, error = false) {
  $('status').textContent = message; $('status').classList.toggle('error', error);
  if (error || !sidebarOpen) {
    clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 8000 : 3000);
  }
}
function setSidebar(open, mode = sidebarMode, returnFocus = false) {
  sidebarOpen = open; sidebarMode = mode;
  $('sidebar').hidden = !open;
  $('backdrop').hidden = !open || !narrowLayout.matches;
  $('library').hidden = mode !== 'files'; $('toc').hidden = mode !== 'outline';
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('sidebar-toggle').classList.toggle('selected', open);
  for (const [id, value] of [['files-tab', 'files'], ['outline-tab', 'outline']]) {
    $(id).classList.toggle('selected', mode === value); $(id).setAttribute('aria-pressed', String(mode === value));
  }
  if (returnFocus) $('sidebar-toggle').focus();
  savePrefs();
}
function closeAfterSelection() { if (narrowLayout.matches) setSidebar(false, sidebarMode, true); }
setSidebar(sidebarOpen);
narrowLayout.addEventListener('change', () => setSidebar(sidebarOpen));
$('sidebar-toggle').addEventListener('click', () => setSidebar(!sidebarOpen));
$('files-tab').addEventListener('click', () => setSidebar(true, 'files'));
$('outline-tab').addEventListener('click', () => setSidebar(true, 'outline'));
$('welcome-open').addEventListener('click', () => { setSidebar(true, 'files'); $('folder').focus(); });
for (const id of ['sidebar-close', 'backdrop']) $(id).addEventListener('click', () => setSidebar(false, sidebarMode, true));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && sidebarOpen) setSidebar(false, sidebarMode, true); });
function report(error) {
  if (error.name === 'AbortError') return;
  const messages = { NotAllowedError: '请点击“打开文件夹”重新授予读取权限。', NotFoundError: '文件已移动或删除，请刷新文件列表。', SecurityError: '请通过 Chrome 扩展侧边栏选择文件夹。' };
  status(messages[error.name] || `读取遇到问题：${error.message}`, true);
}
function busy(value) { state.busy = value; for (const id of ['folder', 'files', 'refresh', 'restore']) $(id).disabled = value; }
function saveWorkspace() {
  try { localStorage.setItem(scopedKey('workspace-meta'), JSON.stringify({ libraryId: workspaceState.libraryId, lastPath: workspaceState.lastPath, positions: workspaceState.positions, mode: workspaceState.mode })); } catch { /* Optional. */ }
  return record(scopedKey('workspace'), structuredClone(workspaceState));
}
function rememberPosition() {
  if (!state.current) return;
  workspaceState.positions ||= {};
  workspaceState.positions[state.current.path] = { reader: $('reader').scrollTop, caret: rich?.getCaret() || 0 };
}
let positionTimer;
for (const id of ['reader']) $(id).addEventListener('scroll', () => {
  rememberPosition(); clearTimeout(positionTimer);
  positionTimer = setTimeout(() => { void saveWorkspace().catch(report); }, 200);
});
function sessionChanged(session) {
  if (state.session !== session) return;
  state.text = session.text;
  if (rich && (rich.markdown !== session.text || !rich.originalDoc)) {
    const scroll = $('reader').scrollTop; rich.load(session.text, true); $('reader').scrollTop = scroll;
  }
  $('save-state').hidden = false; $('save-state').textContent = session.message;
  $('save-state').title = `${session.message} · 点击立即保存`;
  $('conflict').hidden = !session.conflict;
  $('external-version').textContent = session.conflict?.text || '';
  $('reading-info').textContent = `${session.text.length.toLocaleString()} 字符`;
  $('current-title').textContent = `${session.dirty ? '● ' : ''}${session.entry.name}`;

}
async function leaveDocument(requireSaved = false) {
  rememberPosition(); clearTimeout(positionTimer);
  if (requireSaved && state.session?.dirty) {
    if (state.session.canWrite) await state.session.save();
    if (state.session.dirty) throw new Error('当前编辑稿已保留，请先保存、处理版本选择或另存为，再切换文件夹。');
  }
  if (state.session) await state.session.deactivate();
  await saveWorkspace();
}

async function scan(root) {
  const entries = [];
  const directories = [];
  let skipped = 0;
  async function walk(dir, prefix = '') {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') {
        if (['.git', 'node_modules', '.svn'].includes(name)) continue;
        directories.push(path);
        try { await walk(handle, path + '/'); } catch { skipped++; }
      } else if (isMarkdown(name)) entries.push({ path, name, handle });
    }
  }
  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
  return { entries, directories, skipped };
}

function renderList() {
  const query = $('search').value.toLocaleLowerCase();
  const entries = state.entries.filter(entry => entry.path.toLocaleLowerCase().includes(query));
  $('count').textContent = `${entries.length} / ${state.entries.length} 篇`;
  $('file-list').replaceChildren();
  const tree = { folders: new Map(), files: [] };
  function folderAt(parts) {
    let node = tree; let path = '';
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      if (!node.folders.has(name)) node.folders.set(name, { name, path, folders: new Map(), files: [] });
      node = node.folders.get(name);
    }
    return node;
  }
  if (!query) for (const directory of state.directories || []) folderAt(directory.split('/'));
  for (const entry of entries) {
    const parts = entry.path.split('/'); parts.pop(); folderAt(parts).files.push(entry);
  }
  const expanded = new Set(workspaceState.expanded || []);
  function addFile(parent, entry) {
    const button = document.createElement('button');
    const icon = document.createElement('span'); icon.className = 'md-icon'; icon.textContent = 'M↓'; icon.setAttribute('aria-hidden','true');
    const name = document.createElement('span'); name.className = 'tree-file-name'; name.textContent = entry.name;
    button.append(icon, name);
    button.title = entry.path;
    button.classList.toggle('active', state.current?.path === entry.path);
    button.setAttribute('aria-current', String(state.current?.path === entry.path));
    button.addEventListener('click', () => { if (!state.busy) openEntry(entry).then(closeAfterSelection).catch(report); });
    parent.append(button);
  }
  function renderNode(node, parent) {
    for (const child of [...node.folders.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}))) {
      const details=document.createElement('details'); details.className='tree-folder'; details.dataset.path=child.path;
      details.open=!!query || expanded.has(child.path);
      const summary=document.createElement('summary'); summary.textContent=child.name; summary.title=child.path;
      const children=document.createElement('div'); children.className='tree-children';
      details.append(summary,children);renderNode(child,children);parent.append(details);
      if(!children.childNodes.length){const p=document.createElement('p');p.className='muted';p.textContent='暂无 Markdown 文件';children.append(p);}
      details.addEventListener('toggle',()=>{
        if(query || !details.isConnected)return;
        const current=new Set(workspaceState.expanded || []);
        if(details.open)current.add(child.path);else current.delete(child.path);
        workspaceState.expanded=[...current];void saveWorkspace().catch(report);
      });
    }
    for(const entry of node.files)addFile(parent,entry);
  }
  renderNode(tree,$('file-list'));
  if (!entries.length) {
    const p = document.createElement('p'); p.className = 'muted';
    p.textContent = query ? '试试其他文件名或路径。' : '选择的文件夹里有 Markdown 文件时，会显示在这里。';
    $('file-list').append(p);
  }
}
function clearDocument() {
  state.revision++; state.current = null; state.session = null; state.text = ''; state.renderedText = undefined;
  rich?.destroy(); rich = null; $('content').replaceChildren(); $('toc').replaceChildren();
  $('document').hidden = true; $('welcome').hidden = false;
  $('reading-info').textContent = '本地文档'; $('save-state').hidden = true; $('conflict').hidden = true;
  $('current-title').textContent = '页边'; $('current-title').title = '页边 · 本地 Markdown';
}
async function useRoot(root, remember = true) {
  const result = await scan(root);
  if (state.current) await leaveDocument(true);
  const sameRoot = workspaceState.root && await workspaceState.root.isSameEntry(root);
  if (!sameRoot) workspaceState = { libraryId: crypto.randomUUID(), lastPath: '', positions: {} };
  workspaceState.root = root; workspaceState.files = null;
  clearDocument(); state.root = root; state.entries = result.entries; state.directories = result.directories;
  $('folder-name').textContent = root.name; $('search').value = ''; $('restore').hidden = true;
  renderList();
  await saveWorkspace();
  status(`已读取 ${result.entries.length} 篇文档${result.skipped ? `，${result.skipped} 个目录待重新授权` : ' · 文件内容保留在本机'}`);
  const entry = state.entries.find(item => item.path === workspaceState.lastPath) || state.entries[0];
  if (entry) await openEntry(entry);
}
async function openFiles(files, restoring = false) {
  const entries = Array.from(files).filter(file => isMarkdown(file.name)).map(file => ({ path: file.name, name: file.name, ...(file.kind === 'file' ? { handle: file } : { file }) }));
  if (!entries.length) { status('请选择 .md、.markdown、.mdown 或 .mkd 文件。', true); return; }
  if (state.current) await leaveDocument(true);
  if (!restoring) workspaceState = { libraryId: crypto.randomUUID(), lastPath: '', positions: {} };
  workspaceState.root = null; workspaceState.files = Array.from(files);
  await saveWorkspace();
  clearDocument(); state.root = null; state.entries = entries; state.directories = [];
  $('folder-name').textContent = '已选择的文件'; $('search').value = ''; $('restore').hidden = true;
  renderList(); status(entries[0].handle ? '已绑定到当前对话 · 编辑后自动保存' : '文件快照已打开 · 另存为后可持续编辑同步');
  await openEntry(entries.find(item => item.path === workspaceState.lastPath) || entries[0]);
}
async function localFile(path) {
  if (!state.root) throw new Error('请选择图片所在的文件夹');
  const parts = path.split('/'); let dir = state.root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(parts.at(-1))).getFile();
}
function jump(hash) {
  let id; try { id = decodeURIComponent(hash); } catch { return; }
  const heading = (state.headings || []).find(item => item.id === id);
  if (heading) rich.jump(heading.pos);
}

function updateOutline(headings) {
  const ids = new Set(); $('toc').replaceChildren();
  for (const heading of headings) {
    const base = headingSlug(heading.text); let id = base; let index = 1;
    while (ids.has(id)) id = base + '-' + index++;
    ids.add(id); heading.id = id;
    const button = document.createElement('button'); button.textContent = heading.text;
    button.dataset.level = heading.level;
    button.addEventListener('click', () => { closeAfterSelection(); rich.jump(heading.pos); });
    $('toc').append(button);
  }
  state.headings = headings;
  if (!headings.length) { const p=document.createElement('p'); p.className='muted'; p.textContent='文章中的标题会显示在这里。'; $('toc').append(p); }
}
async function followLink(href) {
  if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return; }
  const resolved=resolveLocal(state.current?.path || '',href || '');
  if (!resolved) { status('此链接适合在对应的应用中打开。'); return; }
  if (resolved.path === state.current?.path) { jump(resolved.hash); return; }
  const next=state.entries.find(entry=>entry.path===resolved.path);
  if (next) { try { await openEntry(next); jump(resolved.hash); } catch(error){report(error);} }
  else status('请打开包含该链接目标的文件夹，再点击跳转。');
}
function createRichEditor() {
  rich?.destroy(); $('content').replaceChildren();
  rich=new RichMarkdown($('content'), {
    image:async src=>{ const resolved=resolveLocal(state.current?.path || '',src || ''); return resolved && state.root ? localFile(resolved.path) : null; },
    change:text=>state.session?.edit(text),
    outline:updateOutline,
    link:followLink,
    authorize:()=>{
      const session=state.session;
      if (!session?.entry.handle || session.canWrite || session.permissionAttempted) return;
      session.permissionAttempted=true;
      session.authorize().then(granted=>{ if(granted)session.schedule(); }).catch(report);
    },
    composing:value=>{ if(state.session){state.session.composing=value;if(value)clearTimeout(state.session.timer);else state.session.schedule();} }
  });
}

let navigationQueue = Promise.resolve();
function openEntry(entry) {
  const task = navigationQueue.catch(() => {}).then(async () => {
    if (state.current === entry && state.session) { await state.session.poll(); return; }
    if (state.current) await leaveDocument();
    const session = new DocumentSession(entry, scopedKey(`draft:${workspaceState.libraryId}:${entry.path}`), sessionChanged);
    state.current = entry; state.session = session;
    createRichEditor();
    await session.initialize();
    $('current-title').title = entry.path;
    $('document').hidden = false; $('welcome').hidden = true;
    const position = workspaceState.positions?.[entry.path] || {};
    rich.restoreCaret(position.caret); $('reader').scrollTop = position.reader || 0;
    if (workspaceState.lastPath !== entry.path || !workspaceState.expanded) {
      const expanded=new Set(workspaceState.expanded || []); const parts=entry.path.split('/'); parts.pop();
      for(let i=1;i<=parts.length;i++)expanded.add(parts.slice(0,i).join('/'));
      workspaceState.expanded=[...expanded];
    }
    renderList(); workspaceState.lastPath = entry.path; await saveWorkspace();
  });
  navigationQueue = task.catch(() => {}); return task;
}

$('folder').addEventListener('click', async () => {
  try {
    const promise = window.showDirectoryPicker({ mode: 'readwrite', id: 'markdown-library' });
    busy(true); const root = await promise; await useRoot(root); if (state.current) closeAfterSelection();
  } catch (error) { report(error); } finally { busy(false); }
});
$('files').addEventListener('click', async () => {
  try {
    if (!window.showOpenFilePicker) { $('file-input').click(); return; }
    const picked = window.showOpenFilePicker({ multiple: true, types: [{ description: 'Markdown 文档', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] } }] });
    busy(true); await openFiles(await picked); closeAfterSelection();
  } catch (error) { report(error); } finally { busy(false); }
});
$('file-input').addEventListener('change', async event => { try { await openFiles(event.target.files); if (state.current) closeAfterSelection(); } catch (error) { report(error); } event.target.value = ''; });
$('refresh').addEventListener('click', async () => {
  busy(true);
  try {
    if (state.root) {
      const { entries, directories, skipped } = await scan(state.root); state.entries = entries; state.directories = directories;
      const current = entries.find(entry => entry.path === state.current?.path);
      if (current) {
        // Keep an active draft while refreshing the directory listing.
        if (state.session) await state.session.poll(); else await openEntry(current);
      } else { if (state.current) await leaveDocument(); clearDocument(); if (entries[0]) await openEntry(entries[0]); }
      renderList(); status(`已刷新 ${entries.length} 篇文档${skipped ? `，${skipped} 个目录待重新授权` : ''}`);
    } else status('选择文件夹可读取最新内容；单文件模式可通过“打开文件”重新载入。');
  } catch (error) { report(error); } finally { busy(false); }
});
$('search').addEventListener('input', renderList);
$('theme').addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; savePrefs(); });
$('smaller').addEventListener('click', () => { fontSize = Math.max(12, fontSize - 1); applySize(); });
$('larger').addEventListener('click', () => { fontSize = Math.min(24, fontSize + 1); applySize(); });
$('auto').addEventListener('change', savePrefs);
async function saveCurrent() {
  const session = state.session; if (!session) return;
  try {
    if (!session.entry.handle) { await saveAs(); return; }
    if (await session.authorize()) await session.save();
  } catch (error) { report(error); }
}
for (const id of ['save', 'save-state']) $(id).addEventListener('click', saveCurrent);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrent(); }
});
async function saveAs() {
  const session = state.session; if (!session) { status('先选择一篇文档，再另存为。'); return; }
  try {
    const text = session.text;
    const handle = await window.showSaveFilePicker({ suggestedName: session.entry.name, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
    const stream = await handle.createWritable();
    try { await stream.write(encodeSnapshot(text, session.format)); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
    if (!session.entry.handle && state.session === session) {
      session.entry.handle = handle; session.entry.name = handle.name; session.entry.path = handle.name;
      session.key = scopedKey(`draft:${workspaceState.libraryId}:${handle.name}`);
      session.base = text; session.canWrite = true; session.conflict = null; session.message = '已保存';
      workspaceState.files = state.entries.map(entry => entry.handle || entry.file);
      workspaceState.lastPath = handle.name; await saveWorkspace(); await session.persist(); session.emit(); session.schedule(); renderList();
    }
    status(`已另存为 ${handle.name}`);
  } catch (error) { report(error); }
}
for (const id of ['save-as', 'conflict-copy']) $(id).addEventListener('click', saveAs);
$('use-external').addEventListener('click', () => { state.session?.chooseExternal().catch(report); });
$('use-local').addEventListener('click', async () => {
  const session = state.session; if (!session?.conflict) return;
  const external = session.conflict;
  try { if (await session.authorize()) await session.save(external); } catch (error) { report(error); }
});
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); document.body.classList.remove('dragging');
  const items = Array.from(event.dataTransfer.items);
  const files = Array.from(event.dataTransfer.files);
  try {
    const handles = await Promise.all(items.filter(item => item.kind === 'file').map(item => item.getAsFileSystemHandle?.()));
    await openFiles(handles.length && handles.every(handle => handle?.kind === 'file') ? handles : files);
  } catch (error) { report(error); }
});
async function synchronize() {
  if (!$('auto').checked || state.busy || state.polling || !state.session || document.hidden) return;
  state.polling = true;
  try { await state.session.poll(); }
  finally { state.polling = false; }
}
setInterval(synchronize, 800);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    rememberPosition(); void saveWorkspace().catch(report); void state.session?.persist();
    if (state.session?.canWrite && !state.session.composing) void state.session.save();
  }
  else void synchronize();
});
window.addEventListener('focus', () => { void synchronize(); });
window.addEventListener('pagehide', () => { rememberPosition(); void saveWorkspace(); void state.session?.persist(); });

// A saved handle may require a fresh user gesture to renew read permission.
busy(true);
try {
  const root = workspaceState.root;
  if (root) {
    if (await root.queryPermission({ mode: 'read' }) === 'granted') await useRoot(root, false);
    else {
      $('restore').hidden = false; $('restore').textContent = `继续读取“${root.name}”`;
      setSidebar(true, 'files');
      $('restore').addEventListener('click', async () => {
        try {
          const permission = root.requestPermission({ mode: 'readwrite' }); busy(true);
          if (await permission === 'granted') await useRoot(root, false);
          else status('点击“打开文件夹”可重新选择要阅读的目录。');
        } catch (error) { report(error); } finally { busy(false); }
      });
    }
  } else if (workspaceState.files?.length) {
    const files = workspaceState.files;
    const handles = files.filter(file => file.kind === 'file');
    if ((await Promise.all(handles.map(handle => handle.queryPermission({ mode: 'read' })))).every(value => value === 'granted')) {
      await openFiles(files, true);
    } else {
      $('restore').hidden = false; $('restore').textContent = '继续读取当前对话的文档'; setSidebar(true, 'files');
      $('restore').addEventListener('click', async () => {
        try {
          const permissions = handles.map(handle => handle.requestPermission({ mode: 'readwrite' }));
          if ((await Promise.all(permissions)).every(value => value === 'granted')) await openFiles(files, true);
        } catch (error) { report(error); }
      });
    }
  }
} catch (error) { status('选择文件夹即可开始阅读。'); }
finally { busy(false); }
