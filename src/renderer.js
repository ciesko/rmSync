// ── State ───────────────────────────────────────────

let notes = [];
let currentDoc = null;
let currentPage = 0;
let pages = [];
let syncing = false;
let uploading = false;
let renderGen = 0;
let pageDirection = 'right'; // 'left' or 'right'
let zoomLevel = 1;   // 1 = fit-width (default)
let savedCollapseState = new Map(); // folder collapse state before search
let seenPages = new Set();
let animatingStrokes = false;
let gridMode = false;
let temporalMode = false;

// ── DOM helpers ─────────────────────────────────────

const $ = (s) => document.querySelector(s);

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ── Init ────────────────────────────────────────────

async function init() {
  // Connection dot starts hidden
  const connDot = $('#conn-dot');
  if (connDot) connDot.classList.add('hidden');

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
  $('#btn-prev').addEventListener('click', () => navigatePage(currentPage - 1));
  $('#btn-next').addEventListener('click', () => navigatePage(currentPage + 1));

  // Replay button
  $('#btn-replay').addEventListener('click', () => {
    const key = currentDoc + ':' + currentPage;
    seenPages.delete(key);
    showPage(currentPage);
  });

  // Temporal mode toggle
  $('#btn-temporal').addEventListener('click', () => {
    temporalMode = !temporalMode;
    $('#btn-temporal').classList.toggle('active', temporalMode);
    // Re-render current page to apply/remove temporal coloring
    const key = currentDoc + ':' + currentPage;
    seenPages.delete(key); // force non-animated re-render path
    seenPages.add(key);    // but mark as seen so it doesn't animate
    showPage(currentPage);
  });

  // Grid toggle
  $('#btn-grid').addEventListener('click', toggleGridView);

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!$('#settings-overlay').classList.contains('hidden')) {
      if (e.key === 'Escape') hideSettings();
      return;
    }
    if (e.key === 'Escape') {
      document.body.classList.remove('focus-mode');
      return;
    }
    if ((e.key === 'f' || e.key === 'F') && currentDoc && !e.metaKey && !e.ctrlKey) {
      document.body.classList.toggle('focus-mode');
      return;
    }
    if ((e.key === 't' || e.key === 'T') && currentDoc && !e.metaKey && !e.ctrlKey) {
      temporalMode = !temporalMode;
      $('#btn-temporal').classList.toggle('active', temporalMode);
      const key = currentDoc + ':' + currentPage;
      seenPages.delete(key);
      seenPages.add(key);
      showPage(currentPage);
      return;
    }
    if ((e.key === 'g' || e.key === 'G') && currentDoc && !e.metaKey && !e.ctrlKey) {
      toggleGridView();
      return;
    }
    if (e.key === 'ArrowLeft')  navigatePage(currentPage - 1);
    if (e.key === 'ArrowRight') navigatePage(currentPage + 1);
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

  // Auto-sync: silently refresh note list
  window.api.onAutoSyncComplete(async () => {
    notes = await window.api.getNotes();
    renderTree();
  });

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

  // Focus mode — double-click page to toggle
  $('#page-container').addEventListener('dblclick', () => {
    if (currentDoc) document.body.classList.toggle('focus-mode');
  });

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

  // Search / filter
  const searchInput = $('#search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterTree(searchInput.value.trim());
    });
  }
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

  // Re-apply search filter if active
  const searchInput = $('#search-input');
  if (searchInput && searchInput.value.trim()) {
    filterTree(searchInput.value.trim());
  }
}

function filterTree(query) {
  const tree = $('#tree');
  const allItems = tree.querySelectorAll('.tree-item');

  if (!query) {
    // Restore: remove search-hidden, restore original collapse state
    allItems.forEach((item) => item.classList.remove('search-hidden'));
    savedCollapseState.forEach((wasCollapsed, el) => {
      if (wasCollapsed) el.classList.add('collapsed');
      else el.classList.remove('collapsed');
    });
    savedCollapseState.clear();
    return;
  }

  // Save collapse state on first search keystroke
  if (savedCollapseState.size === 0) {
    tree.querySelectorAll('.tree-children').forEach((el) => {
      savedCollapseState.set(el, el.classList.contains('collapsed'));
    });
  }

  const lowerQuery = query.toLowerCase();

  allItems.forEach((item) => {
    const nameEl = item.querySelector(':scope > .tree-label .tree-name');
    const nameText = nameEl ? nameEl.textContent.toLowerCase() : '';
    const childrenContainer = item.querySelector(':scope > .tree-children');

    if (childrenContainer) {
      // Folder: check if any descendant matches
      const descendants = childrenContainer.querySelectorAll('.tree-item');
      let hasMatch = false;
      descendants.forEach((d) => {
        const dName = d.querySelector(':scope > .tree-label .tree-name');
        if (dName && dName.textContent.toLowerCase().includes(lowerQuery)) {
          hasMatch = true;
        }
      });
      if (hasMatch || nameText.includes(lowerQuery)) {
        item.classList.remove('search-hidden');
        childrenContainer.classList.remove('collapsed');
      } else {
        item.classList.add('search-hidden');
      }
    } else {
      // Leaf item
      if (nameText.includes(lowerQuery)) {
        item.classList.remove('search-hidden');
      } else {
        item.classList.add('search-hidden');
      }
    }
  });
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
  document.body.classList.remove('focus-mode');
  // Highlight
  $('#tree').querySelectorAll('.tree-label.selected')
    .forEach((el) => el.classList.remove('selected'));
  if (labelEl) labelEl.classList.add('selected');

  currentDoc = uuid;
  currentPage = 0;
  seenPages.clear();
  pages = await window.api.getPages(uuid);

  const name = labelEl
    ? labelEl.querySelector('.tree-name').textContent
    : 'Document';

  $('#doc-title').textContent = name;
  $('#empty-state').classList.add('hidden');
  $('#doc-view').classList.remove('hidden');

  gridMode = false;
  $('#btn-grid').classList.remove('active');
  $('#page-grid').classList.add('hidden');
  $('#page-container').classList.remove('hidden');

  showPage(0);
}

function navigatePage(index) {
  if (index < 0 || index >= pages.length) return;
  pageDirection = index > currentPage ? 'right' : 'left';
  showPage(index);
}

function animatePageEnter(el) {
  if (!el) return;
  const cls = pageDirection === 'right' ? 'page-enter-right' : 'page-enter-left';
  el.classList.remove('page-enter-right', 'page-enter-left');
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

async function showPage(index) {
  if (index < 0 || index >= pages.length) return;
  currentPage = index;
  const gen = ++renderGen;

  $('#btn-prev').disabled = index === 0;
  $('#btn-next').disabled = index >= pages.length - 1;
  $('#page-indicator').textContent = `${index + 1} / ${pages.length}`;

  // Page progress bar
  const progressFill = $('#page-progress-fill');
  if (progressFill) {
    const pct = pages.length <= 1 ? 100 : ((index + 1) / pages.length) * 100;
    progressFill.style.width = pct + '%';
  }

  const page = pages[index];

  // Scroll back to top and reset zoom when switching pages
  zoomLevel = 1;
  $('#page-canvas').style.transform = '';
  $('#page-image').style.transform = '';

  const container = $('#page-container');
  container.scrollTo({ top: 0, left: 0 });

  // Crossfade out
  container.style.transition = 'opacity 0.15s ease';
  container.style.opacity = '0';

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
      const pageKey = currentDoc + ':' + index;
      if (!seenPages.has(pageKey)) {
        seenPages.add(pageKey);
        animateStrokes(canvas, strokes, gen);
      } else {
        renderStrokes(canvas, strokes);
      }
      canvas.classList.remove('hidden');
      animatePageEnter(canvas);
      requestAnimationFrame(() => { container.style.opacity = '1'; });
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
    animatePageEnter(img);
  } else {
    placeholder.classList.remove('hidden');
  }

  // Crossfade in
  requestAnimationFrame(() => { container.style.opacity = '1'; });
}

// ── Grid View ───────────────────────────────────────

function toggleGridView() {
  gridMode = !gridMode;
  const btn = $('#btn-grid');
  const grid = $('#page-grid');
  const container = $('#page-container');
  
  btn.classList.toggle('active', gridMode);
  
  if (gridMode) {
    container.classList.add('hidden');
    grid.classList.remove('hidden');
    renderGrid();
  } else {
    grid.classList.add('hidden');
    container.classList.remove('hidden');
  }
}

async function renderGrid() {
  const grid = $('#page-grid');
  grid.innerHTML = '';
  
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const cell = document.createElement('div');
    cell.className = 'grid-page' + (i === currentPage ? ' active' : '');
    cell.dataset.index = i;
    
    // Try to render a small preview
    if (page.rmPath) {
      try {
        const strokes = await window.api.getPageStrokes(page.rmPath);
        const miniCanvas = document.createElement('canvas');
        miniCanvas.width = 351; // RM_WIDTH / 4
        miniCanvas.height = 468; // RM_PAGE_HEIGHT / 4
        const ctx = miniCanvas.getContext('2d');
        
        // Scale down
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 351, 468);
        ctx.scale(0.25, 0.25);
        
        // Find bounds (same as renderStrokes)
        let minX = Infinity;
        const visible = strokes.filter(s => !s.isEraser);
        for (const s of visible) {
          for (const p of s.points) {
            if (p.x < minX) minX = p.x;
          }
        }
        if (!isFinite(minX)) minX = 0;
        ctx.translate(-minX, 0);
        
        for (const s of strokes) {
          if (s.isEraser) continue;
          const comp = s.isHighlighter ? 'multiply' : 'source-over';
          drawStroke(ctx, s, s.color, s.opacity, comp);
        }
        
        cell.appendChild(miniCanvas);
      } catch {
        // Fall through to thumbnail/placeholder
      }
    }
    
    if (!cell.children.length) {
      const imagePath = page.cache || page.thumbnail;
      if (imagePath) {
        try {
          const src = await window.api.getPageImage(imagePath);
          const imgEl = document.createElement('img');
          imgEl.src = src;
          imgEl.alt = `Page ${i + 1}`;
          cell.appendChild(imgEl);
        } catch {}
      }
    }
    
    if (!cell.children.length) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'aspect-ratio: 3/4; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 11px;';
      placeholder.textContent = `Page ${i + 1}`;
      cell.appendChild(placeholder);
    }
    
    // Page number badge
    const num = document.createElement('span');
    num.className = 'grid-page-num';
    num.textContent = i + 1;
    cell.appendChild(num);
    
    cell.addEventListener('click', () => {
      gridMode = false;
      $('#btn-grid').classList.remove('active');
      $('#page-grid').classList.add('hidden');
      $('#page-container').classList.remove('hidden');
      currentPage = i;
      showPage(i);
    });
    
    grid.appendChild(cell);
  }
}

// ── Stroke rendering ────────────────────────────────

// reMarkable coordinate system: simple pages have X centered around 0
// (-702 .. +702); text-grouped pages may use a different X origin.
// Y starts at 0 and grows downward; scrollable pages can exceed
// the 1872 px viewport.
const RM_WIDTH = 1404;
const RM_PAGE_HEIGHT = 1872;

// Temporal gradient: muted gray → sage → teal accent
function temporalColor(t) {
  // t is 0..1 (0 = oldest, 1 = newest)
  // Three-stop gradient: #B8B7B0 → #7A9E9C → #3A7D7B
  let r, g, b;
  if (t < 0.5) {
    const u = t * 2; // 0..1 within first half
    r = Math.round(184 + (122 - 184) * u);
    g = Math.round(183 + (158 - 183) * u);
    b = Math.round(176 + (156 - 176) * u);
  } else {
    const u = (t - 0.5) * 2; // 0..1 within second half
    r = Math.round(122 + (58 - 122) * u);
    g = Math.round(158 + (125 - 158) * u);
    b = Math.round(156 + (123 - 156) * u);
  }
  return `rgb(${r},${g},${b})`;
}

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
  for (let i = 0; i < regular.length; i++) {
    const stroke = regular[i];
    const color = temporalMode ? temporalColor(regular.length > 1 ? i / (regular.length - 1) : 1) : stroke.color;
    drawStroke(ctx, stroke, color, stroke.opacity, 'source-over');
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

async function animateStrokes(canvas, strokes, gen) {
  const highlights = [];
  const regular    = [];
  const erasers    = [];

  for (const s of strokes) {
    if (s.isEraser)          erasers.push(s);
    else if (s.isHighlighter) highlights.push(s);
    else                      regular.push(s);
  }

  const visibleStrokes = highlights.concat(regular);

  let minX = Infinity, maxX = -Infinity, maxY = RM_PAGE_HEIGHT;
  for (const s of visibleStrokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) { minX = 0; maxX = RM_WIDTH; }

  const canvasH = Math.ceil(maxY) + 40;
  canvas.width = RM_WIDTH;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, RM_WIDTH, canvasH);
  ctx.save();
  ctx.translate(-minX, 0);

  // Draw highlights instantly (fast, bottom layer)
  for (const stroke of highlights) {
    drawStroke(ctx, stroke, stroke.color, stroke.opacity, 'multiply');
  }

  // Animate regular strokes
  const totalStrokes = regular.length;
  const rawDelay = totalStrokes > 0 ? 600 / totalStrokes : 0;
  const delay = Math.max(2, Math.min(15, rawDelay));

  animatingStrokes = true;
  const replayBtn = $('#btn-replay');
  if (replayBtn) replayBtn.classList.add('animating');

  for (let i = 0; i < regular.length; i++) {
    if (gen !== renderGen) {
      animatingStrokes = false;
      if (replayBtn) replayBtn.classList.remove('animating');
      return;
    }
    const color = temporalMode ? temporalColor(regular.length > 1 ? i / (regular.length - 1) : 1) : regular[i].color;
    drawStroke(ctx, regular[i], color, regular[i].opacity, 'source-over');
    await new Promise(r => setTimeout(r, delay));
  }

  // Apply erasers instantly at the end
  for (const stroke of erasers) {
    drawStroke(ctx, stroke, '#ffffff', 1.0, 'destination-out');
  }

  ctx.restore();
  animatingStrokes = false;
  if (replayBtn) replayBtn.classList.remove('animating');
}

// ── Sync ────────────────────────────────────────────

async function doSync() {
  if (syncing || uploading) return;
  syncing = true;

  const btn = $('#btn-sync');
  const status = $('#sync-status');
  const connDot = $('#conn-dot');
  btn.classList.add('syncing');
  status.classList.remove('hidden');
  status.classList.add('active');
  status.textContent = 'Starting…';

  // Connection dot: pulsing during sync
  if (connDot) {
    connDot.classList.remove('hidden', 'connected', 'error');
    connDot.classList.add('pulsing');
  }

  let syncError = false;
  try {
    await window.api.syncNotes();
    await refreshNotes();
    // Re-open current doc if still exists
    if (currentDoc) {
      const label = $('#tree').querySelector(`[data-uuid="${currentDoc}"]`);
      if (label) openDocument(currentDoc, label);
    }
  } catch (err) {
    syncError = true;
    status.innerHTML = `<span style="color:#c44">${esc(err.message)}</span>`;
  } finally {
    syncing = false;
    btn.classList.remove('syncing');

    // Connection dot: show result
    if (connDot) {
      connDot.classList.remove('pulsing');
      if (syncError) {
        connDot.classList.add('error');
        setTimeout(() => { connDot.classList.remove('error'); connDot.classList.add('hidden'); }, 5000);
      } else {
        connDot.classList.add('connected');
        setTimeout(() => { connDot.classList.remove('connected'); connDot.classList.add('hidden'); }, 3000);
      }
    }

    // Sync status slide-out: remove active, then hide after CSS transition
    status.classList.remove('active');
    setTimeout(() => status.classList.add('hidden'), 400);
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
