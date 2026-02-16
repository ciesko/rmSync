const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const store = require('./lib/store');
const sync = require('./lib/sync');
const notes = require('./lib/notes');
const ssh = require('./lib/ssh');
const pdfUpload = require('./lib/pdfUpload');
const { parseRmFile, colorForId, opacityForTool, strokeWidth, PEN } = require('./lib/rmparser');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

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
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return result.filePaths;
});

ipcMain.handle('upload-pdfs', async (_, filePaths) => {
  const s = store.load();
  if (!s.password) throw new Error('Password not set — open Settings first.');

  win?.webContents.send('sync-progress', {
    phase: 'connecting', message: 'Connecting to reMarkable…',
  });

  const { conn, sftp } = await ssh.connect(s);
  try {
    const results = [];
    const errors = [];

    for (let i = 0; i < filePaths.length; i++) {
      const name = path.basename(filePaths[i], '.pdf');
      win?.webContents.send('sync-progress', {
        phase: 'uploading',
        message: `Uploading ${name}`,
        current: i + 1,
        total: filePaths.length,
      });
      try {
        const r = await pdfUpload.uploadPdf(conn, sftp, filePaths[i], name);
        results.push(r);
      } catch (err) {
        errors.push(name);
      }
    }

    if (results.length > 0) {
      win?.webContents.send('sync-progress', {
        phase: 'restarting', message: 'Refreshing reMarkable…',
      });
      await pdfUpload.restartXochitl(conn);
    }

    const msg = errors.length
      ? `Uploaded ${results.length}, failed ${errors.length}: ${errors.join(', ')}`
      : `Uploaded ${results.length} PDF${results.length !== 1 ? 's' : ''}`;

    win?.webContents.send('sync-progress', { phase: 'done', message: msg, error: errors.length > 0 });
    return results;
  } finally {
    conn.end();
  }
});
