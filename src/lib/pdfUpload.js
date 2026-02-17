'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ssh = require('./ssh');

const REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl';

function uuid() {
  return crypto.randomUUID();
}

function buildMetadata(visibleName) {
  const now = Date.now().toString();
  return JSON.stringify({
    createdTime: now,
    lastModified: now,
    lastOpened: '',
    lastOpenedPage: 0,
    new: true,
    parent: '',
    pinned: false,
    source: '',
    type: 'DocumentType',
    visibleName,
  }, null, 4);
}

function buildContent(fileSize) {
  return JSON.stringify({
    coverPageNumber: 0,
    documentMetadata: {},
    extraMetadata: {},
    fileType: 'pdf',
    fontName: '',
    formatVersion: 2,
    lineHeight: -1,
    orientation: 'portrait',
    pageCount: 0,
    pageTags: [],
    sizeInBytes: String(fileSize),
    tags: [],
    textAlignment: 'justify',
    textScale: 1,
    zoomMode: 'bestFit',
  }, null, 4);
}

/**
 * Remove all files for a given UUID (cleanup on failure).
 * Silently ignores errors — the files may not exist yet.
 */
async function cleanupUuid(conn, id) {
  try {
    await ssh.exec(conn, `rm -f ${REMOTE_PATH}/${id}.metadata ${REMOTE_PATH}/${id}.content ${REMOTE_PATH}/${id}.pdf`);
  } catch {}
}

/**
 * Upload a single PDF to the reMarkable.
 * If any step fails, all files for this UUID are removed (rollback).
 * Does NOT restart xochitl — caller should batch and restart once.
 */
async function uploadPdf(conn, sftp, localPdfPath, visibleName) {
  const id = uuid();
  const fileSize = fs.statSync(localPdfPath).size;
  const remotePdf      = `${REMOTE_PATH}/${id}.pdf`;
  const remoteMetadata = `${REMOTE_PATH}/${id}.metadata`;
  const remoteContent  = `${REMOTE_PATH}/${id}.content`;

  try {
    // Upload PDF blob first (inert without metadata), then content, then
    // metadata last — metadata is what makes the document discoverable,
    // so it must only appear once all other files are in place.
    await ssh.upload(sftp, localPdfPath, remotePdf);
    await ssh.writeFile(sftp, remoteContent, buildContent(fileSize));
    await ssh.writeFile(sftp, remoteMetadata, buildMetadata(visibleName));
  } catch (err) {
    await cleanupUuid(conn, id);
    throw new Error(`Failed to upload "${visibleName}": ${err.message}`);
  }

  return { id, visibleName };
}

/**
 * Signal xochitl to rescan documents.
 * SIGUSR1 is no longer supported on recent firmware — use systemctl restart.
 */
async function restartXochitl(conn) {
  await ssh.exec(conn, 'systemctl restart xochitl');
}

module.exports = { uploadPdf, restartXochitl };
