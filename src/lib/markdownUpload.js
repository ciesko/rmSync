'use strict';

const fs = require('fs');
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

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  mono: 'Courier',
  monoBold: 'Courier-Bold',
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

const HEADING_SIZES = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };
const BODY_SIZE = 11;
const CODE_SIZE = 9.5;
const LINE_GAP = 4;

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
        const codeX = MARGIN + indent + 4;
        const codeW = contentWidth - 8;
        const startY = doc.y;
        doc.font(FONTS.mono).fontSize(CODE_SIZE);
        const codeText = decodeEntities(token.text);
        // Measure height first
        const textH = doc.heightOfString(codeText, { width: codeW, lineGap: 2 });
        const boxH = textH + 12;
        // Page break if needed
        if (doc.y + boxH > RM_HEIGHT_PT - MARGIN) doc.addPage();
        const boxY = doc.y;
        doc.save()
           .roundedRect(MARGIN + indent, boxY, contentWidth, boxH, 3)
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
            const text = cells[c].text || (cells[c].tokens ? cells[c].tokens.map(t => t.raw || t.text || '').join('') : '');
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
            const text = cells[c].text || (cells[c].tokens ? cells[c].tokens.map(t => t.raw || t.text || '').join('') : '');
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

/** Render inline tokens (bold, italic, code, links, plain text). */
function renderInline(doc, tokens, width, indent) {
  if (!tokens || tokens.length === 0) return;
  const x = MARGIN + (indent || 0);
  const parts = flattenInline(tokens);
  // Build a single text block with font switches
  let first = true;
  for (const part of parts) {
    doc.font(part.font).fontSize(part.size);
    const isLast = part === parts[parts.length - 1];
    doc.text(part.text, first ? x : undefined, first ? doc.y : undefined, {
      width, continued: !isLast, lineGap: LINE_GAP,
      link: part.link || undefined,
      underline: !!part.link,
    });
    first = false;
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
          parts.push({ text: decodeEntities(t.text), font, size: BODY_SIZE });
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
      case 'del':
        parts.push({ text: decodeEntities(t.text || (t.tokens ? t.tokens.map(x => x.text || x.raw || '').join('') : '')), font, size: BODY_SIZE });
        break;
      case 'br':
        parts.push({ text: '\n', font, size: BODY_SIZE });
        break;
      default:
        if (t.raw) parts.push({ text: decodeEntities(t.raw), font, size: BODY_SIZE });
        break;
    }
  }
  return parts;
}

/**
 * Convert markdown string to a PDF Buffer.
 * Pure JS — uses marked for parsing, PDFKit for PDF generation.
 */
function markdownToPdf(markdownSrc) {
  return new Promise((resolve, reject) => {
    const tokens = marked.lexer(markdownSrc);
    const doc = new PDFDocument({
      size: [RM_WIDTH_PT, RM_HEIGHT_PT],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderTokens(doc, tokens);
    doc.end();
  });
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
 * Convert a markdown file to PDF and upload to the reMarkable.
 * Pure JS conversion (marked + pdfkit), streamed to device via SFTP.
 */
async function uploadMarkdown(conn, sftp, mdFilePath, visibleName) {
  const src = fs.readFileSync(mdFilePath, 'utf-8');
  const pdfBuffer = await markdownToPdf(src);

  const id = crypto.randomUUID();
  const remotePdf      = `${REMOTE_PATH}/${id}.pdf`;
  const remoteContent  = `${REMOTE_PATH}/${id}.content`;
  const remoteMetadata = `${REMOTE_PATH}/${id}.metadata`;

  try {
    await ssh.writeFile(sftp, remotePdf, pdfBuffer);
    await ssh.writeFile(sftp, remoteContent, buildContent(pdfBuffer.length));
    await ssh.writeFile(sftp, remoteMetadata, buildMetadata(visibleName));
  } catch (err) {
    try {
      await ssh.exec(conn, `rm -f ${remotePdf} ${remoteContent} ${remoteMetadata}`);
    } catch {}
    throw new Error(`Failed to upload "${visibleName}": ${err.message}`);
  }

  return { id, visibleName };
}

module.exports = { uploadMarkdown };

