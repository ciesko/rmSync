const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  host: '10.11.99.1',
  username: 'root',
  storagePath: path.join(os.homedir(), '.rmsync'),
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const settings = { ...DEFAULTS, ...raw };
    if (raw.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
      settings.password = safeStorage.decryptString(
        Buffer.from(raw.passwordEncrypted, 'base64')
      );
    }
    delete settings.passwordEncrypted;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  const toSave = {
    host: settings.host,
    username: settings.username,
    storagePath: settings.storagePath,
  };
  if (settings.password) {
    if (safeStorage.isEncryptionAvailable()) {
      toSave.passwordEncrypted = safeStorage
        .encryptString(settings.password)
        .toString('base64');
    }
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2));
}

module.exports = { load, save, DEFAULTS };
