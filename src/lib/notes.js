const fs = require('fs');
const path = require('path');

function extractPageEntries(content) {
  const rawPages = content?.cPages?.pages;

  if (Array.isArray(rawPages) && rawPages.length) {
    const pages = rawPages
      .map((page, index) => ({
        id: page?.id,
        idx: page?.idx?.value,
        order: index,
        deleted: !!page?.deleted?.value,
      }))
      .filter((page) => page.id && !page.deleted)
      .sort((left, right) => {
        if (left.idx && right.idx && left.idx !== right.idx) {
          return left.idx.localeCompare(right.idx);
        }
        return left.order - right.order;
      });

    if (content.pageCount && pages.length > content.pageCount) {
      return pages.slice(-content.pageCount);
    }
    return pages;
  }

  const legacyIds = Array.isArray(content?.pages) ? content.pages : [];
  return legacyIds
    .filter((id) => typeof id === 'string' && id.length)
    .map((id, order) => ({ id, order }));
}

function loadNotes(storagePath) {
  const rawDir = path.join(storagePath, 'raw');
  if (!fs.existsSync(rawDir)) return [];

  const items = {};

  for (const file of fs.readdirSync(rawDir)) {
    if (!file.endsWith('.metadata')) continue;
    const uuid = file.slice(0, -9);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
      let content = {};
      const contentFile = path.join(rawDir, uuid + '.content');
      if (fs.existsSync(contentFile)) {
        content = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
      }
      const pageEntries = extractPageEntries(content);
      const pageIds = pageEntries.map((page) => page.id);

      items[uuid] = {
        uuid,
        name: meta.visibleName || 'Untitled',
        type: meta.type,
        parent: meta.parent || '',
        deleted: !!meta.deleted,
        lastModified: meta.lastModified,
        pinned: !!meta.pinned,
        fileType: content.fileType || '',
        pageCount: content.pageCount || pageIds.length,
        pages: pageIds,
      };
    } catch {}
  }

  // Build folder path lookup from parent chain
  function folderPath(uuid) {
    const parts = [];
    let id = items[uuid]?.parent;
    while (id && items[id]) {
      parts.unshift(items[id].name);
      id = items[id].parent;
    }
    return parts.length ? '/' + parts.join('/') : '/';
  }

  function buildTree(parentId) {
    return Object.values(items)
      .filter((i) => !i.deleted && i.parent !== 'trash' && i.parent === parentId)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'CollectionType' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((item) => ({
        ...item,
        folderPath: item.type !== 'CollectionType' ? folderPath(item.uuid) : undefined,
        children:
          item.type === 'CollectionType' ? buildTree(item.uuid) : undefined,
      }));
  }

  return buildTree('');
}

function getDocumentPages(storagePath, uuid) {
  const rawDir = path.join(storagePath, 'raw');
  const pages = [];

  let content = {};
  try {
    content = JSON.parse(
      fs.readFileSync(path.join(rawDir, uuid + '.content'), 'utf8')
    );
  } catch {}

  const pageEntries = extractPageEntries(content);
  const pageIds = pageEntries.map((page) => page.id);
  const count = Math.max(content.pageCount || 0, pageIds.length, 1);

  for (let i = 0; i < count; i++) {
    const page = { index: i, id: pageIds[i] || null };

    // Thumbnail — try page-UUID then index naming, both .png and .jpg
    const thumbDir = path.join(rawDir, uuid + '.thumbnails');
    const thumbCandidates = [];
    if (page.id) thumbCandidates.push(`${page.id}.png`, `${page.id}.jpg`);
    thumbCandidates.push(`${i}.png`, `${i}.jpg`);
    for (const name of thumbCandidates) {
      const p = path.join(thumbDir, name);
      if (fs.existsSync(p)) { page.thumbnail = p; break; }
    }

    // Cached render
    const cacheDir = path.join(rawDir, uuid + '.cache');
    const cacheCandidates = [];
    if (page.id) cacheCandidates.push(`${page.id}.png`, `${page.id}.jpg`);
    cacheCandidates.push(`${i}.png`, `${i}.jpg`);
    for (const name of cacheCandidates) {
      const p = path.join(cacheDir, name);
      if (fs.existsSync(p)) { page.cache = p; break; }
    }

    // Stroke data (.rm file)
    const rmDir = path.join(rawDir, uuid);
    if (page.id) {
      const rmPath = path.join(rmDir, page.id + '.rm');
      if (fs.existsSync(rmPath)) page.rmPath = rmPath;
    }

    // Original PDF
    const pdfPath = path.join(rawDir, uuid + '.pdf');
    if (fs.existsSync(pdfPath)) page.pdfPath = pdfPath;

    pages.push(page);
  }

  return pages;
}

function getPageImage(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
}

module.exports = { loadNotes, getDocumentPages, getPageImage };
