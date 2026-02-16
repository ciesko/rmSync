// ── State ───────────────────────────────────────────

let notes = [];
let currentDoc = null;
let currentPage = 0;
let pages = [];
let syncing = false;
let uploading = false;
let renderGen = 0;
let zoomLevel = 1;   // 1 = fit-width (default)

// ── DOM helpers ─────────────────────────────────────

const $ = (s) => document.querySelector(s);

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ── Init ────────────────────────────────────────────

async function init() {
  bindEvents();
  const settings = await window.api.getSettings();
  if (!settings.hasPassword) showSettings();
  await refreshNotes();
}

function bindEvents() {
  // Tree — delegated click
  $('#tree').addEventListener('click', (e) => {
    const label = e.target.closest('.tree-label');
    if (!label) return;

    if (label.dataset.action === 'folder') {
      const chevron = label.querySelector('.tree-chevron');
      const children = label.nextElementSibling;
      chevron.classList.toggle('expanded');
      children.classList.toggle('collapsed');
    } else if (label.dataset.action === 'doc') {
      openDocument(label.dataset.uuid, label);
    }
  });

  // Page navigation
  $('#btn-prev').addEventListener('click', () => showPage(currentPage - 1));
  $('#btn-next').addEventListener('click', () => showPage(currentPage + 1));

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!$('#settings-overlay').classList.contains('hidden')) {
      if (e.key === 'Escape') hideSettings();
      return;
    }
    if (e.key === 'ArrowLeft')  showPage(currentPage - 1);
    if (e.key === 'ArrowRight') showPage(currentPage + 1);
  });

  // Toolbar
  $('#btn-sync').addEventListener('click', doSync);
  $('#btn-settings').addEventListener('click', showSettings);

  // Settings modal
  $('#btn-cancel').addEventListener('click', hideSettings);
  $('#settings-overlay').addEventListener('click', (e) => {
    if (e.target === $('#settings-overlay')) hideSettings();
  });
  $('#btn-pick-folder').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (folder) $('#set-storage').value = folder;
  });
  $('#btn-save').addEventListener('click', saveSettings);

  // Sync progress stream
  window.api.onSyncProgress(onProgress);

  // Trackpad pinch-to-zoom & pan on page container
  const container = $('#page-container');
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;  // only intercept pinch (ctrlKey on macOS trackpad)
    e.preventDefault();

    // Find the visible element (canvas or image)
    const canvas = $('#page-canvas');
    const img = $('#page-image');
    const target = !canvas.classList.contains('hidden') ? canvas
                 : !img.classList.contains('hidden') ? img : null;
    if (!target) return;

    // Compute min zoom: fit-height
    const containerH = container.clientHeight - 60;
    const containerW = container.clientWidth - 120;
    const natW = target.tagName === 'CANVAS' ? target.width : (target.naturalWidth || target.offsetWidth);
    const natH = target.tagName === 'CANVAS' ? target.height : (target.naturalHeight || target.offsetHeight);
    const fitHeightScale = containerH / (natH * (containerW / natW));
    const minZoom = Math.min(1, fitHeightScale);

    const prevZoom = zoomLevel;
    const delta = -e.deltaY * 0.01;
    zoomLevel = Math.max(minZoom, Math.min(5, zoomLevel + delta));

    // Scale from top-left; adjust scroll to keep pointer position stable
    const rect = target.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;

    target.style.transform = `scale(${zoomLevel})`;

    const ratio = zoomLevel / prevZoom;
    container.scrollLeft = container.scrollLeft * ratio + pointerX * (ratio - 1);
    container.scrollTop  = container.scrollTop  * ratio + pointerY * (ratio - 1);
  }, { passive: false });

  // PDF upload — sidebar drop zone & file picker
  const dropArea = $('#upload-droparea');
  const uploadStatus = $('#upload-status');

  dropArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropArea.classList.add('drag-over');
  });
  dropArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
  });
  dropArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const paths = [];
    for (const file of e.dataTransfer.files) {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        paths.push(window.api.getPathForFile(file));
      }
    }
    if (paths.length > 0) uploadPdfs(paths);
  });

  $('#btn-upload-pick').addEventListener('click', async () => {
    const paths = await window.api.pickPdfs();
    if (paths && paths.length > 0) uploadPdfs(paths);
  });
}

async function uploadPdfs(filePaths) {
  if (syncing || uploading) return;
  uploading = true;

  const btn = $('#btn-sync');
  const us = $('#upload-status');
  btn.classList.add('syncing');
  us.className = '';
  us.textContent = 'Uploading…';

  try {
    await window.api.uploadPdfs(filePaths);
  } catch (err) {
    onUploadProgress({ phase: 'done', message: `Upload failed: ${err.message}`, error: true });
  }
  btn.classList.remove('syncing');
  uploading = false;
}

// ── Notes tree ──────────────────────────────────────

async function refreshNotes() {
  try { notes = await window.api.getNotes(); } catch { notes = []; }
  renderTree();
}

/** Recursively collect all PDFs from the tree, removing them from their folders. */
function extractPdfs(items) {
  const pdfs = [];
  const rest = [];
  for (const item of items) {
    if (item.type !== 'CollectionType' && item.fileType === 'pdf') {
      pdfs.push(item);
    } else if (item.type === 'CollectionType' && item.children) {
      const childPdfs = extractPdfs(item.children);
      pdfs.push(...childPdfs.pdfs);
      const folder = { ...item, children: childPdfs.rest };
      // Keep folder only if it still has non-PDF children
      if (folder.children.length > 0) rest.push(folder);
    } else {
      rest.push(item);
    }
  }
  return { pdfs, rest };
}

function renderTree() {
  const tree = $('#tree');
  if (!notes.length) {
    tree.innerHTML = '<div class="tree-empty">No notes synced</div>';
    return;
  }
  const { rest, pdfs } = extractPdfs(notes);
  let html = buildItems(rest);
  if (pdfs.length) {
    html += `<div class="tree-section-label">PDFs</div>`;
    html += buildItems(pdfs);
  }
  tree.innerHTML = html;
}

// ── SVG glyph icons ─────────────────────────────────

const ICON = {
  folder: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5z"/></svg>`,
  notebook: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="1.5" width="9.5" height="13" rx="1.5"/><line x1="6" y1="1.5" x2="6" y2="14.5"/><line x1="8" y1="5" x2="11" y2="5"/><line x1="8" y1="7.5" x2="11" y2="7.5"/><line x1="8" y1="10" x2="10" y2="10"/></svg>`,
  quickSheet: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5l3 3V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5z"/><path d="M9.5 1.5V5h3"/><path d="M8.5 7.5L7 10h2l-1.5 2.5"/></svg>`,
  pdf: `<svg class="tree-icon tree-icon-pdf" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5l3 3V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5z"/><path d="M9.5 1.5V5h3"/><text x="8" y="11.5" text-anchor="middle" font-size="5" font-weight="600" stroke="none" fill="currentColor">PDF</text></svg>`,
  epub: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5z"/><path d="M6 1v14"/><line x1="8" y1="5" x2="11" y2="5"/><line x1="8" y1="7.5" x2="11" y2="7.5"/></svg>`,
};

function docIcon(item) {
  if (item.type === 'CollectionType') return ICON.folder;
  // Detect Quick sheets by name (system-created notebook on reMarkable)
  if (/^quick\s*sheets?$/i.test(item.name)) return ICON.quickSheet;
  if (item.fileType === 'pdf') return ICON.pdf;
  if (item.fileType === 'epub') return ICON.epub;
  return ICON.notebook;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d)) return '';
  const now = new Date();
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

function docMeta(item) {
  const parts = [];
  const date = formatDate(item.lastModified);
  if (date) parts.push(date);
  if (item.folderPath && item.folderPath !== '/') parts.push(item.folderPath);
  if (item.pageCount > 0) parts.push(`${item.pageCount}p`);
  return parts.length ? `<span class="tree-meta">${esc(parts.join(' · '))}</span>` : '';
}

function buildItems(items) {
  return items.map((item) => {
    if (item.type === 'CollectionType') {
      return `
        <div class="tree-item">
          <div class="tree-label" data-action="folder">
            <span class="tree-chevron">›</span>
            ${ICON.folder}
            <span class="tree-name">${esc(item.name)}</span>
          </div>
          <div class="tree-children collapsed">
            ${item.children ? buildItems(item.children) : ''}
          </div>
        </div>`;
    }
    return `
      <div class="tree-item">
        <div class="tree-label${currentDoc === item.uuid ? ' selected' : ''}"
             data-action="doc" data-uuid="${item.uuid}">
          <span class="tree-chevron spacer">›</span>
          ${docIcon(item)}
          <span class="tree-name-col">
            <span class="tree-name">${esc(item.name)}</span>
            ${docMeta(item)}
          </span>
        </div>
      </div>`;
  }).join('');
}

// ── Document view ───────────────────────────────────

async function openDocument(uuid, labelEl) {
  // Highlight
  $('#tree').querySelectorAll('.tree-label.selected')
    .forEach((el) => el.classList.remove('selected'));
  if (labelEl) labelEl.classList.add('selected');

  currentDoc = uuid;
  currentPage = 0;
  pages = await window.api.getPages(uuid);

  const name = labelEl
    ? labelEl.querySelector('.tree-name').textContent
    : 'Document';

  $('#doc-title').textContent = name;
  $('#empty-state').classList.add('hidden');
  $('#doc-view').classList.remove('hidden');

  showPage(0);
}

async function showPage(index) {
  if (index < 0 || index >= pages.length) return;
  currentPage = index;
  const gen = ++renderGen;

  $('#btn-prev').disabled = index === 0;
  $('#btn-next').disabled = index >= pages.length - 1;
  $('#page-indicator').textContent = `${index + 1} / ${pages.length}`;

  const page = pages[index];

  // Scroll back to top and reset zoom when switching pages
  zoomLevel = 1;
  $('#page-canvas').style.transform = '';
  $('#page-image').style.transform = '';
  $('#page-container').scrollTo({ top: 0, left: 0 });

  const canvas = $('#page-canvas');
  const img = $('#page-image');
  const placeholder = $('#page-placeholder');

  // Hide all display elements while loading to prevent stale content
  canvas.classList.add('hidden');
  img.classList.add('hidden');
  placeholder.classList.add('hidden');

  // Prefer high-res stroke rendering from .rm file
  if (page.rmPath) {
    try {
      const strokes = await window.api.getPageStrokes(page.rmPath);
      if (gen !== renderGen) return; // stale — user already navigated away
      renderStrokes(canvas, strokes);
      canvas.classList.remove('hidden');
      return;
    } catch {
      if (gen !== renderGen) return;
    }
  }

  // Fall back to cached render or thumbnail
  const imagePath = page.cache || page.thumbnail;
  if (imagePath) {
    const src = await window.api.getPageImage(imagePath);
    if (gen !== renderGen) return;
    img.src = src;
    img.classList.remove('hidden');
  } else {
    placeholder.classList.remove('hidden');
  }
}

// ── Stroke rendering ────────────────────────────────

// reMarkable coordinate system: simple pages have X centered around 0
// (-702 .. +702); text-grouped pages may use a different X origin.
// Y starts at 0 and grows downward; scrollable pages can exceed
// the 1872 px viewport.
const RM_WIDTH = 1404;
const RM_PAGE_HEIGHT = 1872;

function renderStrokes(canvas, strokes) {
  // Separate strokes into categories for correct layering.
  const highlights = [];
  const regular    = [];
  const erasers    = [];

  for (const s of strokes) {
    if (s.isEraser)          erasers.push(s);
    else if (s.isHighlighter) highlights.push(s);
    else                      regular.push(s);
  }

  // Find actual extents (X may be centered or absolute depending on page
  // type; Y can scroll beyond the default viewport).
  let minX = Infinity, maxX = -Infinity, maxY = RM_PAGE_HEIGHT;
  const visibleStrokes = highlights.concat(regular);
  for (const s of visibleStrokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  // Fall back to centered coordinate system when there are no visible strokes
  if (!isFinite(minX)) { minX = 0; maxX = RM_WIDTH; }

  const canvasH = Math.ceil(maxY) + 40;

  canvas.width = RM_WIDTH;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // Paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, RM_WIDTH, canvasH);

  // Shift so that the leftmost stroke aligns to the canvas edge.
  ctx.save();
  ctx.translate(-minX, 0);

  // ── Render in three passes for correct visual layering ──
  //
  // Pass 1: Highlights (bottom layer) — use 'multiply' so underlying
  //         strokes remain visible through the highlight wash.
  for (const stroke of highlights) {
    drawStroke(ctx, stroke, stroke.color, stroke.opacity, 'multiply');
  }

  // Pass 2: Regular pen strokes (middle layer) — on top of highlights
  for (const stroke of regular) {
    drawStroke(ctx, stroke, stroke.color, stroke.opacity, 'source-over');
  }

  // Pass 3: Erasers (top layer) — removes both pen strokes and highlights
  for (const stroke of erasers) {
    drawStroke(ctx, stroke, '#ffffff', 1.0, 'destination-out');
  }

  ctx.restore();
}

function drawStroke(ctx, stroke, color, opacity, compositeOp) {
  const pts = stroke.points;
  if (pts.length < 2) {
    if (pts.length === 1) {
      ctx.globalCompositeOperation = compositeOp;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  ctx.globalCompositeOperation = compositeOp;
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Draw with variable-width segments using quadratic curves
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const w = (p0.w + p1.w) / 2;

    ctx.lineWidth = w;
    ctx.beginPath();

    if (i === 0) {
      ctx.moveTo(p0.x, p0.y);
    } else {
      const prev = pts[i - 1];
      ctx.moveTo((prev.x + p0.x) / 2, (prev.y + p0.y) / 2);
    }

    // Quadratic curve through current point to midpoint with next
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
    ctx.stroke();
  }

  // Final segment to last point
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  ctx.lineWidth = last.w;
  ctx.beginPath();
  ctx.moveTo((prev.x + last.x) / 2, (prev.y + last.y) / 2);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();

  // Reset
  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';
}

// ── Sync ────────────────────────────────────────────

async function doSync() {
  if (syncing || uploading) return;
  syncing = true;

  const btn = $('#btn-sync');
  const status = $('#sync-status');
  btn.classList.add('syncing');
  status.classList.remove('hidden');
  status.textContent = 'Starting…';

  try {
    await window.api.syncNotes();
    await refreshNotes();
    // Re-open current doc if still exists
    if (currentDoc) {
      const label = $('#tree').querySelector(`[data-uuid="${currentDoc}"]`);
      if (label) openDocument(currentDoc, label);
    }
  } catch (err) {
    status.innerHTML = `<span style="color:#c44">${esc(err.message)}</span>`;
  } finally {
    syncing = false;
    btn.classList.remove('syncing');
    setTimeout(() => status.classList.add('hidden'), 4000);
  }
}

function onProgress(data) {
  // Route upload-related phases to the sidebar upload status
  if (uploading) return onUploadProgress(data);
  const status = $('#sync-status');
  if (data.phase === 'downloading') {
    const pct = Math.round((data.current / data.total) * 100);
    status.innerHTML =
      `${esc(data.message)}<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } else {
    status.textContent = data.message;
  }
}

function onUploadProgress(data) {
  const us = $('#upload-status');
  us.classList.remove('hidden', 'success', 'error');
  if (data.phase === 'uploading') {
    const pct = Math.round((data.current / data.total) * 100);
    us.innerHTML =
      `${esc(data.message)}<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } else if (data.phase === 'done') {
    us.textContent = data.message;
    us.classList.add(data.error ? 'error' : 'success');
    setTimeout(() => us.classList.add('hidden'), 5000);
  } else {
    us.textContent = data.message;
  }
}

// ── Settings ────────────────────────────────────────

async function showSettings() {
  const s = await window.api.getSettings();
  $('#set-host').value = s.host || '';
  $('#set-username').value = s.username || '';
  $('#set-password').value = '';
  $('#set-password').placeholder = s.hasPassword
    ? '••••••••  (leave blank to keep)'
    : 'Enter device password';
  $('#set-storage').value = s.storagePath || '';
  $('#settings-overlay').classList.remove('hidden');
}

function hideSettings() {
  $('#settings-overlay').classList.add('hidden');
}

async function saveSettings() {
  const data = {
    host: $('#set-host').value.trim(),
    username: $('#set-username').value.trim(),
    storagePath: $('#set-storage').value.trim(),
  };
  const pw = $('#set-password').value;
  if (pw) data.password = pw;

  await window.api.saveSettings(data);
  hideSettings();
  await refreshNotes();
}

// ── Start ───────────────────────────────────────────

init();
