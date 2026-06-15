// ES-module shim that loads pdf.js and exposes a tiny rendering API on
// `window.rmPdf` for the classic-script renderer. Rendering a PDF page to a
// crisp bitmap lets the viewer draw the original document text/content beneath
// the high-res annotation strokes (otherwise annotated PDFs showed ink only).
import * as pdfjs from './pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// Cache one PDFDocumentProxy per document uuid so flipping pages doesn't reparse
// the whole file each time. Keyed by uuid; value is a Promise<PDFDocumentProxy>.
const docCache = new Map();

function getDoc(uuid, bytes) {
  let p = docCache.get(uuid);
  if (!p) {
    // Copy into a fresh Uint8Array — pdf.js transfers/neuters the buffer it is
    // given, and the IPC-provided buffer may be reused elsewhere.
    const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    p = pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    docCache.set(uuid, p);
  }
  return p;
}

/**
 * Render one page of a PDF to an ImageBitmap.
 * @param {string} uuid     document uuid (cache key)
 * @param {Uint8Array|ArrayBuffer} bytes  PDF file bytes (only used on first call per uuid)
 * @param {number} pageIndex  0-based page index
 * @param {number} targetWidth  desired bitmap width in px (height follows aspect)
 * @returns {Promise<{bitmap: ImageBitmap, width: number, height: number}>}
 */
async function renderPage(uuid, bytes, pageIndex, targetWidth) {
  const doc = await getDoc(uuid, bytes);
  if (pageIndex < 0 || pageIndex >= doc.numPages) {
    throw new Error('pdf page out of range: ' + pageIndex);
  }
  const page = await doc.getPage(pageIndex + 1); // pdf.js is 1-based
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const bitmap = await createImageBitmap(canvas);
  return { bitmap, width: canvas.width, height: canvas.height };
}

function dispose(uuid) {
  const p = docCache.get(uuid);
  if (p) {
    docCache.delete(uuid);
    p.then((d) => { try { d.destroy(); } catch {} }).catch(() => {});
  }
}

window.rmPdf = { renderPage, dispose };
window.dispatchEvent(new Event('rmpdf-ready'));
