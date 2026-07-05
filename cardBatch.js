// Normalizes any uploaded business-card file -- a plain image, a HEIC/HEIF
// photo (common from iPhone/iPad), or a multi-page PDF (e.g. a stack of
// cards scanned into one PDF at a conference) -- into a list of one or more
// plain image buffers ready for OCR. This is what makes batch upload work
// across desktop, tablet, and mobile: the frontend just uploads whatever
// file type the device produced, and this module handles the rest.

let heicConvert = null;
try {
  heicConvert = require('heic-convert');
} catch {
  // optional dependency; HEIC support simply won't be available if missing
}

function isPdf(filename, mimetype) {
  return (mimetype && mimetype.includes('pdf')) || /\.pdf$/i.test(filename || '');
}

function isHeic(filename, mimetype) {
  return (mimetype && (mimetype.includes('heic') || mimetype.includes('heif'))) ||
    /\.(heic|heif)$/i.test(filename || '');
}

async function convertHeicToJpeg(buffer) {
  if (!heicConvert) {
    throw new Error('HEIC support is not available on this server (heic-convert failed to load).');
  }
  const outputBuffer = await heicConvert({ buffer, format: 'JPEG', quality: 0.92 });
  return Buffer.from(outputBuffer);
}

// Renders every page of a PDF to a PNG buffer. Uses pdfjs-dist (pure JS PDF
// parsing) + @napi-rs/canvas (prebuilt native canvas, no system Cairo/Poppler
// dependency needed) so this works portably across platforms.
async function renderPdfPages(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');

  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // Scale 2x for OCR legibility -- business card text is small.
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas.toBuffer('image/png'));
  }
  return pages;
}

// Main entry point: given an uploaded file's raw buffer, filename, and
// mimetype, returns an array of { imageDataUrl, pageLabel } ready for OCR.
// A plain image file yields exactly one entry; a multi-page PDF yields one
// entry per page.
async function normalizeFileToImages(buffer, filename, mimetype) {
  if (isPdf(filename, mimetype)) {
    const pages = await renderPdfPages(buffer);
    return pages.map((pngBuffer, idx) => ({
      imageDataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
      pageLabel: pages.length > 1 ? `${filename} (page ${idx + 1} of ${pages.length})` : filename
    }));
  }

  if (isHeic(filename, mimetype)) {
    const jpegBuffer = await convertHeicToJpeg(buffer);
    return [{
      imageDataUrl: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`,
      pageLabel: filename
    }];
  }

  // Plain image (JPEG/PNG/WebP/etc.) -- pass through as-is.
  const mt = mimetype && mimetype.startsWith('image/') ? mimetype : 'image/jpeg';
  return [{
    imageDataUrl: `data:${mt};base64,${buffer.toString('base64')}`,
    pageLabel: filename
  }];
}

module.exports = { normalizeFileToImages, isPdf, isHeic };
