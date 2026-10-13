import { record, readSnapshot, encodeSnapshot } from './storage.js';

// One session owns one file. UI switches never retarget an in-flight write.
export class DocumentSession {
  constructor(entry, key, onChange) {
    this.entry = entry; this.key = key; this.onChange = onChange;
    this.base = ''; this.text = ''; this.format = { eol: '\n', bom: false };
    this.conflict = null; this.saving = false; this.active = true;
    this.canWrite = false; this.composing = false; this.queue = Promise.resolve();
    this.draftQueue = Promise.resolve(); this.message = '已同步';
  }
  get dirty() { return this.text !== this.base; }
  emit() { if (this.active) this.onChange(this); }
  async disk() { return readSnapshot(this.entry.handle ? await this.entry.handle.getFile() : this.entry.file); }
  async initialize() {
    const disk = await this.disk(); this.base = disk.text; this.text = disk.text; this.format = disk;
    let draft = await record(this.key);
    try {
      const emergency = JSON.parse(localStorage.getItem(this.key));
      if (emergency && (!draft || emergency.updatedAt >= draft.updatedAt)) draft = emergency;
    } catch { /* IndexedDB remains the primary draft store. */ }
    if (draft && draft.text !== disk.text && draft.text !== draft.base) {
      this.base = draft.base; this.text = draft.text; this.format = draft.format || disk;
      this.conflict = disk.text === draft.base ? null : disk;
      this.message = this.conflict ? '两边均有修改' : '已恢复草稿';
    }
    if (this.entry.handle) this.canWrite = await this.entry.handle.queryPermission({ mode: 'readwrite' }) === 'granted';
    this.emit();
    // Restored drafts stay reviewable until the reader chooses to save or edits.
  }
  persist() {
    const data = { base: this.base, text: this.text, format: this.format, path: this.entry.path, handle: this.entry.handle, updatedAt: Date.now() };
    // A synchronous copy survives panel teardown immediately after a keystroke.
    try {
      if (this.dirty) localStorage.setItem(this.key, JSON.stringify({ base: data.base, text: data.text, format: data.format, updatedAt: data.updatedAt }));
      else localStorage.removeItem(this.key);
    } catch { /* Large drafts are still stored in IndexedDB. */ }
    this.draftQueue = this.draftQueue.catch(() => {}).then(() => record(this.key, data));
    this.draftQueue.catch(() => { this.message = '草稿保存失败，请保留当前页面并点击保存'; this.emit(); });
    return this.draftQueue;
  }
  edit(text) {
    this.text = text; this.message = this.dirty ? '待保存' : '已保存';
    void this.persist(); this.emit(); this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.active && this.canWrite && this.dirty && !this.conflict && !this.composing) {
      this.timer = setTimeout(() => { void this.save(); }, 600);
    }
  }
  run(job) {
    const result = this.queue.catch(() => {}).then(job);
    this.queue = result.catch(() => {});
    return result;
  }
  async authorize() {
    // Call directly from a click or Ctrl+S so Chrome receives the user gesture.
    if (!this.entry.handle) return false;
    this.canWrite = await this.entry.handle.requestPermission({ mode: 'readwrite' }) === 'granted';
    if (!this.canWrite) { this.message = '草稿已保留 · 点击保存授予写入权限'; this.emit(); }
    return this.canWrite;
  }
  async acceptDisk(disk) {
    this.base = disk.text; this.text = disk.text; this.format = disk; this.conflict = null;
    this.message = '已同步外部修改'; await this.persist(); this.emit();
  }
  markConflict(disk) {
    this.conflict = disk; this.message = '两边均有修改';
    void this.persist(); this.emit();
  }
  poll() {
    return this.run(async () => {
      if (!this.active || !this.entry.handle || this.saving || this.composing) return;
      try {
        const disk = await this.disk();
        if (disk.text === this.base) { if (this.conflict) { this.conflict = null; this.emit(); this.schedule(); } return; }
        if (!this.dirty || disk.text === this.text) await this.acceptDisk(disk);
        else this.markConflict(disk);
      } catch (error) { this.message = `同步暂停：${error.message}`; this.emit(); }
    });
  }
  save(forceAgainst = null) {
    clearTimeout(this.timer);
    return this.run(async () => {
      if (!this.dirty) return true;
      if (!this.entry.handle || !this.canWrite) {
        this.message = this.entry.handle ? '草稿已保留 · 点击保存授权' : '草稿已保留 · 另存为本地文件';
        await this.persist(); this.emit(); return false;
      }
      if (this.conflict && !forceAgainst) { this.emit(); return false; }
      this.saving = true; this.message = '正在保存…'; this.emit();
      let stream;
      try {
        // Other instances of this extension serialize writes to matching names.
        return await navigator.locks.request(`page-margin:${this.entry.name}`, async () => {
          const disk = await this.disk();
          const expected = forceAgainst ? forceAgainst.text : this.base;
          if (disk.text !== expected) {
            if (disk.text === this.text) { await this.acceptDisk(disk); return true; }
            this.markConflict(disk); return false;
          }
          const text = this.text;
          // Keep the pre-write content locally, including the external version
          // explicitly replaced by a conflict resolution.
          await record(`${this.key}:backup`, { ...disk, updatedAt: Date.now() });
          stream = await this.entry.handle.createWritable();
          await stream.write(encodeSnapshot(text, disk));
          const latest = await this.disk();
          if (latest.text !== disk.text) {
            await stream.abort(); stream = null; this.markConflict(latest); return false;
          }
          await stream.close(); stream = null;
          this.base = text; this.format = disk; this.conflict = null;
          this.message = this.dirty ? '待保存' : '已保存';
          await this.persist(); this.emit(); return true;
        });
      } catch (error) {
        if (stream) await stream.abort().catch(() => {});
        this.message = `保存暂停：${error.message}`; await this.persist().catch(() => {}); this.emit(); return false;
      } finally {
        this.saving = false; this.emit();
        // Further keystrokes while writing are saved by the next debounce.
        if (this.dirty && !this.conflict && this.message === '待保存') this.schedule();
      }
    });
  }
  async chooseExternal() {
    return this.run(async () => {
      await record(`${this.key}:local-copy`, { text: this.text, base: this.base, updatedAt: Date.now() });
      await this.acceptDisk(await this.disk());
    });
  }
  async deactivate() {
    clearTimeout(this.timer);
    if (this.dirty && this.canWrite && !this.conflict && !this.composing) await this.save();
    await this.persist(); this.active = false;
  }
}
