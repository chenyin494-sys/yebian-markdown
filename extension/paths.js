export const isMarkdown = name => /\.(md|markdown|mdown|mkd)$/i.test(name);

// Resolve only inside the directory explicitly selected by the reader.
export function resolveLocal(base, href) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const [pathAndQuery, hash = ''] = href.split('#');
  let path;
  try { path = decodeURIComponent(pathAndQuery.split('?')[0]).replaceAll('\\', '/'); }
  catch { return null; }
  const parts = path.startsWith('/') ? [] : base.split('/').slice(0, -1);
  if (!path) return { path: base, hash };
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return { path: parts.join('/'), hash };
}

export function headingSlug(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
}
