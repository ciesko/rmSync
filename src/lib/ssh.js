const { Client } = require('ssh2');

function connect({ host, username, password }) {
  return new Promise((resolve, reject) => {
    if (!host || typeof host !== 'string') {
      return reject(new Error(`Invalid host: "${host}"`));
    }

    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`Connection timed out to ${host}:22`));
    }, 15000);

    conn.on('ready', () => {
      clearTimeout(timer);
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve({ conn, sftp });
      });
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.connect({ host, port: 22, username, password });
  });
}

function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(err);
      resolve(list);
    });
  });
}

async function listRecursive(sftp, basePath) {
  const results = [];

  async function walk(dir, rel) {
    const entries = await readdir(sftp, dir);
    for (const entry of entries) {
      const full = dir + '/' + entry.filename;
      const relPath = rel ? rel + '/' + entry.filename : entry.filename;
      const isDir = (entry.attrs.mode & 0o40000) !== 0;

      results.push({
        path: relPath,
        fullPath: full,
        isDir,
        mtime: entry.attrs.mtime,
        size: entry.attrs.size || 0,
      });

      if (isDir) await walk(full, relPath);
    }
  }

  await walk(basePath, '');
  return results;
}

function download(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function writeFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on('error', reject);
    stream.end(content, 'utf8', resolve);
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { out += d; });
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Command failed (${code}): ${out}`));
        resolve(out);
      });
    });
  });
}

module.exports = { connect, listRecursive, download, upload, writeFile, exec };
