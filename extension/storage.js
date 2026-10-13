export const scope = new URLSearchParams(location.search).get('scope') || 'standalone';
export const scopedKey = name => `${scope}:${name}`;

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('page-margin', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function record(key, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('settings');
      const request = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('本地记录保存已中止'));
    });
  } finally { db.close(); }
}

export async function readSnapshot(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的 Markdown 文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('这份文件使用其他编码，请先在编辑器中转换为 UTF-8 再打开。'); }
  return {
    text: text.replace(/\r\n?/g, '\n'),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
    signature: `${file.lastModified}:${file.size}`
  };
}

export function encodeSnapshot(text, format) {
  return (format.bom ? '\uFEFF' : '') + text.replace(/\r\n?/g, '\n').replace(/\n/g, format.eol || '\n');
}
