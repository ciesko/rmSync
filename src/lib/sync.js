const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');

const REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl';
const MANIFEST = '.sync-manifest.json';

function loadManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(dir, data) {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(data));
}

async function sync(settings, onProgress) {
  const rawDir = path.join(settings.storagePath, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  onProgress({ phase: 'connecting', message: 'Connecting to reMarkable…' });
  const { conn, sftp } = await ssh.connect(settings);

  try {
    onProgress({ phase: 'listing', message: 'Scanning remote files…' });
    const remote = await ssh.listRecursive(sftp, REMOTE_PATH);
    const manifest = loadManifest(rawDir);
    const newManifest = {};
    const toDownload = [];

    for (const f of remote) {
      newManifest[f.path] = { mtime: f.mtime, size: f.size, isDir: f.isDir };

      if (f.isDir) {
        fs.mkdirSync(path.join(rawDir, f.path), { recursive: true });
      } else {
        const prev = manifest[f.path];
        if (!prev || prev.mtime !== f.mtime || prev.size !== f.size) {
          toDownload.push(f);
        }
      }
    }

    // Remove files deleted on device
    const remoteSet = new Set(remote.map((f) => f.path));
    for (const p of Object.keys(manifest)) {
      if (!remoteSet.has(p) && !manifest[p].isDir) {
        try { fs.unlinkSync(path.join(rawDir, p)); } catch {}
      }
    }

    // Download changed files
    const total = toDownload.length;
    for (let i = 0; i < total; i++) {
      const f = toDownload[i];
      const dest = path.join(rawDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      onProgress({
        phase: 'downloading',
        message: path.basename(f.path),
        current: i + 1,
        total,
      });
      await ssh.download(sftp, f.fullPath, dest);
    }

    saveManifest(rawDir, newManifest);
    onProgress({
      phase: 'done',
      message: `Done — ${total} file${total !== 1 ? 's' : ''} updated`,
    });
    return { downloaded: total, total: remote.length };
  } finally {
    conn.end();
  }
}

module.exports = { sync };
