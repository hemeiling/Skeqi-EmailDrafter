/* Slice very tall screenshots into page-shaped vertical parts so they stay
   legible at full page width in Word. Prints a JSON manifest on stdout. */
const { createCanvas, loadImage } = require('/Users/meilinghe/Library/CloudStorage/OneDrive-Personal/ClaudeCode/EmailDrafter/node_modules/@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const DOCS = '/Users/meilinghe/Library/CloudStorage/OneDrive-Personal/ClaudeCode/EmailDrafter/docs';
const SHOTS = path.join(DOCS, 'screenshots');
const SPLIT = path.join(SHOTS, 'split');
const PAGE_AR = 17.0 / 23.5;   // portrait A4 content box
const AR_LIMIT = 0.60;         // slice anything narrower/taller than this
const OVERLAP = 60;            // px of overlap between parts (device pixels)

fs.mkdirSync(SPLIT, { recursive: true });

(async () => {
  const manifest = {};
  for (const file of fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort()) {
    const src = path.join(SHOTS, file);
    const img = await loadImage(src);
    const ar = img.width / img.height;
    if (ar >= AR_LIMIT) continue;

    const n = Math.max(2, Math.ceil((img.height / img.width) * PAGE_AR));
    const base = file.replace(/\.png$/, '');
    const sliceH = Math.ceil(img.height / n);
    const parts = [];
    for (let k = 0; k < n; k++) {
      const y0 = Math.max(0, k * sliceH - (k > 0 ? OVERLAP : 0));
      const y1 = Math.min(img.height, (k + 1) * sliceH);
      const h = y1 - y0;
      const cv = createCanvas(img.width, h);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, img.width, h);
      ctx.drawImage(img, 0, -y0);
      const out = `${base}-part${k + 1}of${n}.png`;
      fs.writeFileSync(path.join(SPLIT, out), cv.toBuffer('image/png'));
      parts.push({ rel: `screenshots/split/${out}`, w: img.width, h });
    }
    manifest[`screenshots/${file}`] = { n, ar, parts };
    console.error(`  sliced ${file}  AR ${ar.toFixed(2)} -> ${n} parts`);
  }
  process.stdout.write(JSON.stringify(manifest, null, 1));
})();
