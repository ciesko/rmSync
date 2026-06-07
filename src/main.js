const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const store = require('./lib/store');
const sync = require('./lib/sync');
const notes = require('./lib/notes');
const ssh = require('./lib/ssh');
const pdfUpload = require('./lib/pdfUpload');
const markdownUpload = require('./lib/markdownUpload');
const { parseRmFile, colorForId, opacityForTool, strokeWidth, PEN } = require('./lib/rmparser');

let win;
const iconPath = path.join(__dirname, 'icon.png');

function createWindow() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  startAutoSync();
});
app.on('window-all-closed', () => app.quit());

// ── Auto-sync ────────────────────────────────────────
const AUTO_SYNC_MS = 60 * 60 * 1000;      // 60 minutes
const RETRY_MS     = 30 * 60 * 1000;      // 30 minutes on failure
let autoSyncTimer = null;

function scheduleAutoSync(delayMs) {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(doAutoSync, delayMs);
}

function startAutoSync() {
  scheduleAutoSync(AUTO_SYNC_MS);
}

async function doAutoSync() {
  try {
    const s = store.load();
    if (!s.password) { scheduleAutoSync(RETRY_MS); return; }
    await sync.sync(s, (progress) => {
      win?.webContents.send('sync-progress', progress);
    });
    win?.webContents.send('sync-progress', { phase: 'done', message: 'Auto-synced' });
    // Reload notes in renderer
    win?.webContents.send('auto-sync-complete');
    scheduleAutoSync(AUTO_SYNC_MS);
  } catch {
    scheduleAutoSync(RETRY_MS);
  }
}

// ── IPC ──────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  const s = store.load();
  return {
    host: s.host,
    username: s.username,
    storagePath: s.storagePath,
    hasPassword: !!s.password,
  };
});

ipcMain.handle('save-settings', (_, incoming) => {
  const current = store.load();
  store.save({
    host: incoming.host || current.host,
    username: incoming.username || current.username,
    storagePath: incoming.storagePath || current.storagePath,
    password: incoming.password || current.password,
  });
  return true;
});

ipcMain.handle('sync-notes', async () => {
  const s = store.load();
  if (!s.password) {
    throw new Error('Password not set — open Settings first.');
  }
  return sync.sync(s, (progress) => {
    win?.webContents.send('sync-progress', progress);
  });
});

ipcMain.handle('get-notes', () => {
  const s = store.load();
  return notes.loadNotes(s.storagePath);
});

ipcMain.handle('get-pages', (_, uuid) => {
  const s = store.load();
  return notes.getDocumentPages(s.storagePath, uuid);
});

ipcMain.handle('get-page-image', (_, imagePath) => {
  return notes.getPageImage(imagePath);
});

// Ramer–Douglas–Peucker simplification (iterative to avoid stack overflow on
// long continuous-write strokes). Drops near-collinear points whose deviation
// is below EPSILON in .rm coordinate units — visually lossless but cuts the
// point count (and therefore IPC size + canvas draw calls) substantially.
const RDP_EPSILON = 1.4;

function decimatePoints(pts) {
  const n = pts.length;
  if (n <= 2) return pts;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const eps2 = RDP_EPSILON * RDP_EPSILON;
  const stack = [[0, n - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    const ax = pts[first].x, ay = pts[first].y;
    const bx = pts[last].x,  by = pts[last].y;
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;

    let maxDist2 = -1;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = pts[i].x - ax, py = pts[i].y - ay;
      let dist2;
      if (segLen2 === 0) {
        dist2 = px * px + py * py;
      } else {
        const cross = px * dy - py * dx;
        dist2 = (cross * cross) / segLen2;
      }
      if (dist2 > maxDist2) { maxDist2 = dist2; idx = i; }
    }

    if (maxDist2 > eps2 && idx !== -1) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

ipcMain.handle('get-page-strokes', (_, rmPath) => {
  const fs = require('fs');
  const buf = fs.readFileSync(rmPath);
  const lines = parseRmFile(buf);
  // Pre-compute rendering props so renderer doesn't need the parser
  return lines.map((ln) => {
    let points = ln.points.map((p) => ({
      x: p.x,
      y: p.y,
      w: strokeWidth(p, ln.thicknessScale, ln.tool),
    }));
    points = decimatePoints(points);

    // Pre-compute bounds so the renderer never has to re-scan every point
    // (used for canvas tiling and per-tile stroke culling).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    return {
      color: colorForId(ln.color),
      opacity: opacityForTool(ln.tool),
      tool: ln.tool,
      thicknessScale: ln.thicknessScale,
      isEraser: ln.tool === PEN.ERASER || ln.tool === PEN.ERASER_AREA,
      isHighlighter: ln.tool === PEN.HIGHLIGHTER_1 || ln.tool === PEN.HIGHLIGHTER_2,
      minX, maxX, minY, maxY,
      points,
    };
  });
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.filePaths[0] || null;
});

// Opens the macOS Privacy > Local Network settings pane so the user can
// (re-)grant rmSync access without hunting through System Settings.
ipcMain.handle('open-network-settings', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
    );
    return true;
  }
  return false;
});

ipcMain.handle('pick-pdfs', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: ['pdf', 'md'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('upload-pdfs', async (_, filePaths) => {
  const s = store.load();
  if (!s.password) throw new Error('Password not set — open Settings first.');

  win?.webContents.send('sync-progress', {
    phase: 'connecting', message: 'Connecting to tablet…',
  });

  const { conn, sftp } = await ssh.connect(s);
  try {
    const results = [];
    const errors = [];

    for (let i = 0; i < filePaths.length; i++) {
      const ext = path.extname(filePaths[i]).toLowerCase();
      const name = path.basename(filePaths[i], ext);
      win?.webContents.send('sync-progress', {
        phase: 'uploading',
        message: `Uploading ${name}`,
        current: i + 1,
        total: filePaths.length,
      });
      try {
        let r;
        if (ext === '.md') {
          r = await markdownUpload.uploadMarkdown(conn, sftp, filePaths[i], name);
        } else {
          r = await pdfUpload.uploadPdf(conn, sftp, filePaths[i], name);
        }
        results.push(r);
      } catch (err) {
        errors.push(name);
      }
    }

    if (results.length > 0) {
      win?.webContents.send('sync-progress', {
        phase: 'restarting', message: 'Refreshing tablet…',
      });
      await pdfUpload.restartXochitl(conn);
    }

    const msg = errors.length
      ? `Uploaded ${results.length}, failed ${errors.length}: ${errors.join(', ')}`
      : `Uploaded ${results.length} file${results.length !== 1 ? 's' : ''}`;

    win?.webContents.send('sync-progress', { phase: 'done', message: msg, error: errors.length > 0 });
    return results;
  } finally {
    conn.end();
  }
});

ipcMain.handle('delete-document', async (_, uuid) => {
  const s = store.load();
  if (!s.password) throw new Error('Password not set — open Settings first.');

  const REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl';
  const { conn, sftp } = await ssh.connect(s);
  try {
    // Stop xochitl before deleting to prevent corruption
    await ssh.exec(conn, 'systemctl stop xochitl');
    try {
      // Remove all files for this UUID on the device
      await ssh.exec(conn, `rm -rf ${REMOTE_PATH}/${uuid} ${REMOTE_PATH}/${uuid}.*`);
    } finally {
      // Always restart xochitl, even if delete failed
      await ssh.exec(conn, 'systemctl start xochitl');
    }
  } finally {
    conn.end();
  }

  // Remove local sync files
  const rawDir = path.join(s.storagePath, 'raw');
  const fs = require('fs');
  const entries = fs.readdirSync(rawDir).filter(f => f.startsWith(uuid));
  for (const entry of entries) {
    const full = path.join(rawDir, entry);
    fs.rmSync(full, { recursive: true, force: true });
  }
});
