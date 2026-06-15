'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const PDFDocument = require('pdfkit');
const ssh = require('./ssh');

const REMOTE_PATH = '/home/root/.local/share/remarkable/xochitl';

// reMarkable display: 1404×1872 px at 226 DPI → 157.2mm × 209.6mm
// PDFKit uses points (1mm = 2.835pt)
const RM_WIDTH_PT  = 445.7;
const RM_HEIGHT_PT = 594.2;
const MARGIN = 40;

// DejaVu Sans Mono TTF — supports Unicode box-drawing, arrows, etc.
// Built-in Courier uses WinAnsi encoding which mangles non-Latin chars.
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const MONO_REGULAR = path.join(FONT_DIR, 'DejaVuSansMono.ttf');
const MONO_BOLD    = path.join(FONT_DIR, 'DejaVuSansMono-Bold.ttf');

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  mono: 'DejaVuMono',
  monoBold: 'DejaVuMono-Bold',
};

/** Decode common HTML entities that marked emits. */
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

/**
 * Decode entities and collapse markdown soft line breaks.
 * Editors hard-wrap source at ~80 cols; in markdown a single newline inside a
 * paragraph is a space, not a line break. Genuine hard breaks arrive as separate
 * `br` tokens, so collapsing `\n` here is safe.
 */
function inlineText(str) {
  return decodeEntities(str).replace(/[ \t]*\n[ \t]*/g, ' ');
}

// --- Image embedding -------------------------------------------------------
const IMG_TIMEOUT_MS = 8000;
const IMG_MAX_BYTES = 10 * 1024 * 1024;

/** Identify embeddable formats by magic bytes (PDFKit supports PNG + JPEG). */
function isEmbeddableImage(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;                    // JPEG
  return false;
}

/**
 * Load a single image to a Buffer, or null on any failure. Never throws.
 * Remote: fetch with timeout + size cap. Local: read relative to the md file.
 */
async function fetchImage(href, mdDir) {
  try {
    let buf;
    if (/^https?:\/\//i.test(href)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
      try {
        const res = await fetch(href, { signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok) return null;
        buf = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } else {
      const clean = href.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
      const resolved = path.isAbsolute(clean) ? clean : path.resolve(mdDir || '.', clean);
      buf = await fs.promises.readFile(resolved);
    }
    if (!buf || buf.length === 0 || buf.length > IMG_MAX_BYTES) return null;
    if (!isEmbeddableImage(buf)) return null;
    return buf;
  } catch (err) {
    console.warn(`[markdownUpload] image skipped (${href}): ${err.message}`);
    return null;
  }
}

/** Recursively collect every image href in the token tree. */
function collectImageHrefs(tokens, set = new Set()) {
  if (!tokens) return set;
  for (const t of tokens) {
    if (t.type === 'image' && t.href) set.add(t.href);
    if (t.tokens) collectImageHrefs(t.tokens, set);
    if (t.items) collectImageHrefs(t.items, set);
    if (t.header) collectImageHrefs(t.header, set);
    if (t.rows) for (const row of t.rows) collectImageHrefs(row, set);
  }
  return set;
}

/** Prefetch all images into a Map<href, Buffer|null>. One bad image is isolated. */
async function loadImages(tokens, mdDir) {
  const cache = new Map();
  const hrefs = [...collectImageHrefs(tokens)];
  await Promise.all(hrefs.map(async (h) => { cache.set(h, await fetchImage(h, mdDir)); }));
  return cache;
}

/** Draw an embedded image as a centered block, preserving aspect ratio.
 *  Returns true on success, false if PDFKit rejects the image (caller falls back). */
function drawImageBlock(doc, buf, x, width) {
  const maxH = RM_HEIGHT_PT - 2 * MARGIN;
  let drawW = width, drawH = Math.min(width, maxH);
  try {
    const img = doc.openImage(buf);
    if (img && img.width && img.height) {
      const scale = Math.min(width / img.width, maxH / img.height, 1);
      drawW = img.width * scale;
      drawH = img.height * scale;
    }
  } catch {
    return false;
  }

  const prevY = doc.y;
  doc.moveDown(0.2);
  if (doc.y + drawH > RM_HEIGHT_PT - MARGIN) doc.addPage();
  const y = doc.y;
  const drawX = x + Math.max(0, (width - drawW) / 2);
  try {
    doc.image(buf, drawX, y, { width: drawW, height: drawH });
  } catch {
    doc.y = prevY;
    return false;
  }
  doc.y = y + drawH;
  doc.moveDown(0.4);
  return true;
}

const HEADING_SIZES = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };
const BODY_SIZE = 11;
const CODE_SIZE = 9.5;
const CODE_MARGIN = 12;       // tighter margins for code blocks (vs 40pt body)
const MIN_CODE_SIZE = 6;      // smallest readable on 226 DPI e-ink (~19px tall)
const LINE_GAP = 4;

/** Extract plain text from a table cell, preferring decoded inline text over raw
 *  markdown (so images render as alt text, not `![...](...)`). */
function cellText(cell) {
  if (cell.tokens && cell.tokens.length) {
    return inlineText(cell.tokens.map(t => t.text || t.raw || '').join(''));
  }
  return inlineText(cell.text || '');
}

/**
 * Render markdown tokens into a PDFKit document.
 * Handles headings, paragraphs, code blocks, lists, blockquotes, tables, and hrs.
 */
function renderTokens(doc, tokens, opts = {}) {
  const indent = opts.indent || 0;
  const contentWidth = RM_WIDTH_PT - 2 * MARGIN - indent;

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const size = HEADING_SIZES[token.depth] || BODY_SIZE;
        if (doc.y > MARGIN + 20) doc.moveDown(0.6);
        doc.font(FONTS.bold).fontSize(size);
        renderInline(doc, token.tokens, contentWidth, indent);
        if (token.depth <= 2) {
          doc.moveTo(MARGIN + indent, doc.y + 2)
             .lineTo(MARGIN + indent + contentWidth, doc.y + 2)
             .lineWidth(token.depth === 1 ? 1.5 : 0.5)
             .stroke('#000');
          doc.moveDown(0.3);
        }
        doc.moveDown(0.3);
        break;
      }
      case 'paragraph': {
        doc.font(FONTS.regular).fontSize(BODY_SIZE);
        renderInline(doc, token.tokens, contentWidth, indent);
        doc.moveDown(0.5);
        break;
      }
      case 'code': {
        doc.moveDown(0.3);
        const codeText = decodeEntities(token.text);
        const codeBoxW = RM_WIDTH_PT - 2 * CODE_MARGIN - indent;
        const codePad = 4;
        const codeX = CODE_MARGIN + indent + codePad;
        const codeW = codeBoxW - 2 * codePad;

        // Auto-shrink: find the widest line and pick a font size that fits
        doc.font(FONTS.mono).fontSize(CODE_SIZE);
        const lines = codeText.split('\n');
        const maxLineW = Math.max(...lines.map(l => doc.widthOfString(l)));
        let fontSize = CODE_SIZE;
        if (maxLineW > codeW) {
          fontSize = Math.max(MIN_CODE_SIZE, CODE_SIZE * (codeW / maxLineW));
          doc.fontSize(fontSize);
        }

        const textH = doc.heightOfString(codeText, { width: codeW, lineGap: 2 });
        const boxH = textH + 12;
        // Page break if needed
        if (doc.y + boxH > RM_HEIGHT_PT - MARGIN) doc.addPage();
        const boxY = doc.y;
        doc.save()
           .roundedRect(CODE_MARGIN + indent, boxY, codeBoxW, boxH, 3)
           .fill('#f0f0f0')
           .restore();
        doc.fill('#000').text(codeText, codeX, boxY + 6, {
          width: codeW, lineGap: 2,
        });
        doc.y = boxY + boxH + 4;
        doc.moveDown(0.3);
        break;
      }
      case 'blockquote': {
        const bqX = MARGIN + indent;
        const startY = doc.y + 2;
        doc.x = bqX + 12;
        renderTokens(doc, token.tokens, { indent: indent + 12 });
        // Draw left border
        doc.save()
           .moveTo(bqX + 3, startY)
           .lineTo(bqX + 3, doc.y - 2)
           .lineWidth(2.5)
           .stroke('#888')
           .restore();
        doc.moveDown(0.3);
        break;
      }
      case 'list': {
        const items = token.items;
        const bulletW = token.ordered ? 22 : 14;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const bullet = token.ordered ? `${token.start + i}.` : '\u2022';
          const bulletX = MARGIN + indent;
          const itemIndent = indent + bulletW;
          const itemWidth = RM_WIDTH_PT - 2 * MARGIN - itemIndent;
          const bulletY = doc.y;

          // Draw bullet separately (no continued) so it doesn't constrain text width
          doc.font(token.ordered ? FONTS.bold : FONTS.regular).fontSize(BODY_SIZE);
          doc.text(bullet, bulletX, bulletY, { width: bulletW, lineGap: LINE_GAP });

          // Reset Y so item text aligns with the bullet
          doc.y = bulletY;

          // Render item inline content at the indented offset
          if (item.tokens && item.tokens.length > 0) {
            for (const sub of item.tokens) {
              if (sub.type === 'text' && sub.tokens) {
                doc.font(FONTS.regular).fontSize(BODY_SIZE);
                renderInline(doc, sub.tokens, itemWidth, itemIndent);
              } else if (sub.type === 'paragraph' && sub.tokens) {
                doc.font(FONTS.regular).fontSize(BODY_SIZE);
                renderInline(doc, sub.tokens, itemWidth, itemIndent);
              } else if (sub.type === 'list') {
                doc.moveDown(0.2);
                renderTokens(doc, [sub], { indent: itemIndent });
              }
            }
          }
          doc.moveDown(0.2);
        }
        doc.moveDown(0.3);
        break;
      }
      case 'table': {
        doc.moveDown(0.3);
        const cols = token.header.length;
        const colW = contentWidth / cols;
        const cellPad = 4;
        const drawRow = (cells, isHeader) => {
          const rowY = doc.y;
          doc.font(isHeader ? FONTS.bold : FONTS.regular).fontSize(BODY_SIZE - 1);
          let maxH = 14;
          for (let c = 0; c < cells.length; c++) {
            const text = cellText(cells[c]);
            const h = doc.heightOfString(text, { width: colW - 2 * cellPad }) + 2 * cellPad;
            if (h > maxH) maxH = h;
          }
          if (doc.y + maxH > RM_HEIGHT_PT - MARGIN) doc.addPage();
          const finalY = doc.y;
          if (isHeader) {
            doc.save().rect(MARGIN + indent, finalY, contentWidth, maxH).fill('#e8e8e8').restore();
          }
          doc.fill('#000');
          for (let c = 0; c < cells.length; c++) {
            const text = cellText(cells[c]);
            doc.text(text, MARGIN + indent + c * colW + cellPad, finalY + cellPad, {
              width: colW - 2 * cellPad, lineGap: 1,
            });
          }
          // Borders
          doc.save().lineWidth(0.5).strokeColor('#000');
          for (let c = 0; c <= cols; c++) {
            const x = MARGIN + indent + c * colW;
            doc.moveTo(x, finalY).lineTo(x, finalY + maxH).stroke();
          }
          doc.moveTo(MARGIN + indent, finalY).lineTo(MARGIN + indent + contentWidth, finalY).stroke();
          doc.moveTo(MARGIN + indent, finalY + maxH).lineTo(MARGIN + indent + contentWidth, finalY + maxH).stroke();
          doc.restore();
          doc.y = finalY + maxH;
        };
        drawRow(token.header, true);
        for (const row of token.rows) drawRow(row, false);
        doc.moveDown(0.5);
        break;
      }
      case 'hr': {
        doc.moveDown(0.5);
        doc.save()
           .moveTo(MARGIN + indent, doc.y)
           .lineTo(MARGIN + indent + contentWidth, doc.y)
           .lineWidth(1).stroke('#000').restore();
        doc.moveDown(0.5);
        break;
      }
      case 'space': break;
      default: {
        // Fallback: render raw text if available
        if (token.text) {
          doc.font(FONTS.regular).fontSize(BODY_SIZE)
             .text(decodeEntities(token.text), MARGIN + indent, doc.y, { width: contentWidth, lineGap: LINE_GAP });
          doc.moveDown(0.3);
        }
      }
    }
  }
}

/** Render inline tokens (bold, italic, code, links, images, plain text). */
function renderInline(doc, tokens, width, indent) {
  if (!tokens || tokens.length === 0) return;
  const x = MARGIN + (indent || 0);
  const cache = doc._imageCache;

  // Resolve image parts to either an embedded block or an alt/link text fallback.
  const parts = [];
  for (const p of flattenInline(tokens)) {
    if (p.image) {
      const buf = cache ? cache.get(p.href) : null;
      if (buf) { parts.push({ block: buf, alt: p.alt, href: p.href, font: p.font, size: p.size }); continue; }
      parts.push({ text: p.alt || p.href, font: p.font, size: p.size, link: p.href });
    } else {
      parts.push(p);
    }
  }

  let startRun = true;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (part.block) {
      if (drawImageBlock(doc, part.block, x, width)) { startRun = true; continue; }
      // PDFKit rejected the image — degrade to alt text / link.
      part = { text: part.alt || part.href, font: part.font, size: part.size, link: part.href };
    }
    const next = parts[i + 1];
    const continued = !!(next && !next.block);
    doc.font(part.font).fontSize(part.size);
    doc.text(part.text, startRun ? x : undefined, startRun ? doc.y : undefined, {
      width, continued, lineGap: LINE_GAP,
      link: part.link || undefined,
      underline: !!part.link,
    });
    startRun = false;
  }
}

function flattenInline(tokens, parentFont) {
  const parts = [];
  const font = parentFont || FONTS.regular;
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        if (t.tokens) {
          parts.push(...flattenInline(t.tokens, font));
        } else {
          parts.push({ text: inlineText(t.text), font, size: BODY_SIZE });
        }
        break;
      case 'strong':
        parts.push(...flattenInline(t.tokens, font === FONTS.italic ? FONTS.boldItalic : FONTS.bold));
        break;
      case 'em':
        parts.push(...flattenInline(t.tokens, font === FONTS.bold ? FONTS.boldItalic : FONTS.italic));
        break;
      case 'codespan':
        parts.push({ text: decodeEntities(t.text), font: FONTS.mono, size: CODE_SIZE });
        break;
      case 'link':
        parts.push(...flattenInline(t.tokens, font).map(p => ({ ...p, link: t.href })));
        break;
      case 'image':
        parts.push({ image: true, href: t.href, alt: t.text || '', font, size: BODY_SIZE });
        break;
      case 'del':
        parts.push({ text: inlineText(t.text || (t.tokens ? t.tokens.map(x => x.text || x.raw || '').join('') : '')), font, size: BODY_SIZE });
        break;
      case 'br':
        parts.push({ text: '\n', font, size: BODY_SIZE });
        break;
      default:
        if (t.raw) parts.push({ text: inlineText(t.raw), font, size: BODY_SIZE });
        break;
    }
  }
  return parts;
}

/**
 * Convert markdown string to a PDF Buffer.
 * Pure JS — uses marked for parsing, PDFKit for PDF generation.
 */
async function markdownToPdf(markdownSrc, mdDir) {
  const tokens = marked.lexer(markdownSrc);
  const imageCache = await loadImages(tokens, mdDir);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [RM_WIDTH_PT, RM_HEIGHT_PT],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
    });
    doc._imageCache = imageCache;

    doc.registerFont('DejaVuMono', MONO_REGULAR);
    doc.registerFont('DejaVuMono-Bold', MONO_BOLD);

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderTokens(doc, tokens);
    doc.end();
  });
}

function buildMetadata(visibleName, parent) {
  const now = Date.now().toString();
  return JSON.stringify({
    createdTime: now,
    lastModified: now,
    lastOpened: '',
    lastOpenedPage: 0,
    new: true,
    parent: parent || '',
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
 * Convert a markdown file to PDF and upload to the reMarkable.
 * Pure JS conversion (marked + pdfkit), streamed to device via SFTP.
 */
async function uploadMarkdown(conn, sftp, mdFilePath, visibleName, parent) {
  const src = fs.readFileSync(mdFilePath, 'utf-8');
  const pdfBuffer = await markdownToPdf(src, path.dirname(mdFilePath));

  const id = crypto.randomUUID();
  const remotePdf      = `${REMOTE_PATH}/${id}.pdf`;
  const remoteContent  = `${REMOTE_PATH}/${id}.content`;
  const remoteMetadata = `${REMOTE_PATH}/${id}.metadata`;

  try {
    await ssh.writeFile(sftp, remotePdf, pdfBuffer);
    await ssh.writeFile(sftp, remoteContent, buildContent(pdfBuffer.length));
    await ssh.writeFile(sftp, remoteMetadata, buildMetadata(visibleName, parent));
  } catch (err) {
    try {
      await ssh.exec(conn, `rm -f ${remotePdf} ${remoteContent} ${remoteMetadata}`);
    } catch {}
    throw new Error(`Failed to upload "${visibleName}": ${err.message}`);
  }

  return { id, visibleName };
}

module.exports = { uploadMarkdown, markdownToPdf };

