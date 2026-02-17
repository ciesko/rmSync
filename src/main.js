const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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

ipcMain.handle('get-page-strokes', (_, rmPath) => {
  const fs = require('fs');
  const buf = fs.readFileSync(rmPath);
  const lines = parseRmFile(buf);
  // Pre-compute rendering props so renderer doesn't need the parser
  return lines.map((ln) => ({
    color: colorForId(ln.color),
    opacity: opacityForTool(ln.tool),
    tool: ln.tool,
    thicknessScale: ln.thicknessScale,
    isEraser: ln.tool === PEN.ERASER || ln.tool === PEN.ERASER_AREA,
    isHighlighter: ln.tool === PEN.HIGHLIGHTER_1 || ln.tool === PEN.HIGHLIGHTER_2,
    points: ln.points.map((p) => ({
      x: p.x,
      y: p.y,
      w: strokeWidth(p, ln.thicknessScale, ln.tool),
    })),
  }));
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.filePaths[0] || null;
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
