// ── State ───────────────────────────────────────────

let notes = [];
let currentDoc = null;
let currentPage = 0;
let pages = [];
let syncing = false;
let renderGen = 0;

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
}

// ── Notes tree ──────────────────────────────────────

async function refreshNotes() {
  try { notes = await window.api.getNotes(); } catch { notes = []; }
  renderTree();
}

function renderTree() {
  const tree = $('#tree');
  if (!notes.length) {
    tree.innerHTML = '<div class="tree-empty">No notes synced</div>';
    return;
  }
  tree.innerHTML = buildItems(notes);
}

// ── SVG glyph icons ─────────────────────────────────

const ICON = {
  folder: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5z"/></svg>`,
  notebook: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="1.5" width="9.5" height="13" rx="1.5"/><line x1="6" y1="1.5" x2="6" y2="14.5"/><line x1="8" y1="5" x2="11" y2="5"/><line x1="8" y1="7.5" x2="11" y2="7.5"/><line x1="8" y1="10" x2="10" y2="10"/></svg>`,
  quickSheet: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5l3 3V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5z"/><path d="M9.5 1.5V5h3"/><path d="M8.5 7.5L7 10h2l-1.5 2.5"/></svg>`,
  pdf: `<svg class="tree-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5l3 3V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5z"/><path d="M9.5 1.5V5h3"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="10.5" x2="11" y2="10.5"/></svg>`,
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
          <span class="tree-name">${esc(item.name)}</span>
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

  // Scroll back to top when switching pages
  $('#page-container').scrollTo({ top: 0 });

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
  if (syncing) return;
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
  const status = $('#sync-status');
  if (data.phase === 'downloading') {
    const pct = Math.round((data.current / data.total) * 100);
    status.innerHTML =
      `${esc(data.message)}<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } else {
    status.textContent = data.message;
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
