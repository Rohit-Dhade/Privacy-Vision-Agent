/**
 * benchmark/e2e/render-demo-artifacts.js
 *
 * Generates the demo artifacts: raw screenshot, redacted screenshot, an
 * annotated version showing what was redacted and why, and the signed
 * Merkle redaction proof with its verification result.
 *
 * Runs the REAL unpacked extension in a real Chromium, against the
 * ground-truth fixture in test-pages/kyc-onboarding-demo.html. This is the
 * only layer of testing in this project that exercises content-script
 * injection, the service worker, screenshot capture, canvas pixel access
 * and the offscreen document — everything the Node harness in
 * benchmark/run-benchmark.js deliberately cannot.
 *
 * Setup (once):
 *     npm install playwright
 *     npx playwright install chromium
 *
 * Run:
 *     node benchmark/e2e/render-demo-artifacts.js
 *
 * Set PVA_CHROME to use a specific Chromium/Chrome binary instead of the
 * one Playwright downloads. Extensions require a headed browser, so on a
 * headless machine run this under xvfb:
 *     xvfb-run -a node benchmark/e2e/render-demo-artifacts.js
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EXT = path.join(REPO, 'Browser-Agent');
const PAGES = path.join(REPO, 'test-pages');
// Playwright's bundled Chromium unless PVA_CHROME overrides it.
const CHROME = process.env.PVA_CHROME || undefined;
const OUT = path.join(__dirname, 'out');

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const s = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(PAGES);
  const url = `http://127.0.0.1:${server.address().port}/kyc-onboarding-demo.html`;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), {
    headless: false, ...(CHROME ? { executablePath: CHROME } : {}), viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];

  const page = ctx.pages()[0];
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  await page.waitForTimeout(900);

  const analysis = await sw.evaluate(async () => {
    const d = await performAnalysis();
    return { extraction: d.extraction, shot: d.screenshotDataUrl, faces: d.faces || [],
             faceOk: d.faceDetectionAvailable, faceErr: d.faceDetectionError };
  });
  console.log(`detections: ${analysis.extraction.sensitiveItems.length}`);
  console.log('types:', [...new Set(analysis.extraction.sensitiveItems.map((s) => s.type))].join(', '));
  console.log(`face detection available: ${analysis.faceOk}${analysis.faceOk ? '' : ' (' + analysis.faceErr + ')'}`);
  console.log(`faces detected: ${analysis.faces.length}`);

  fs.writeFileSync(path.join(OUT, 'raw.png'), Buffer.from(analysis.shot.split(',')[1], 'base64'));

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  await popup.waitForTimeout(1500);

  const result = await popup.evaluate(async ({ shot, extraction, faces }) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = shot; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);

    const vp = extraction.viewport;
    const boxes = [];
    const labelled = [];
    for (const item of extraction.sensitiveItems || []) {
      if (!item.bbox) continue;
      const b = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(item.bbox, vp, c.width, c.height, 4);
      if (b.width > 0 && b.height > 0) { boxes.push(b); labelled.push({ type: item.type, masked: item.masked, box: b }); }
    }

    // Faces come back already in screenshot pixel space (YuNet runs on the
    // screenshot), and popup.js pads them by 10px before painting.
    for (const f of faces || []) {
      if (![f.x, f.y, f.width, f.height].every(Number.isFinite)) continue;
      const pad = 10;
      const x = Math.max(0, Math.floor(f.x - pad));
      const y = Math.max(0, Math.floor(f.y - pad));
      const w = Math.min(c.width - x, Math.ceil(f.width + pad * 2));
      const h = Math.min(c.height - y, Math.ceil(f.height + pad * 2));
      if (w > 0 && h > 0) {
        const box = { x, y, width: w, height: h };
        boxes.push(box);
        labelled.push({ type: 'FACE', masked: '[FACE REDACTED]', box });
      }
    }

    // Commit to the RAW pixels first — the whole point of the ordering.
    const proof = await window.__BA_MerkleProof.generateRedactionProof(cx, c.width, c.height, boxes);
    const verification = await window.__BA_MerkleProof.verifyRedactionProof(proof);

    // Now paint, exactly as popup.js does.
    cx.fillStyle = '#000000';
    for (const b of boxes) cx.fillRect(b.x, b.y, b.width, b.height);

    // Annotate a second copy so the demo shows WHAT was redacted and why.
    const c2 = document.createElement('canvas');
    c2.width = c.width; c2.height = c.height;
    const cx2 = c2.getContext('2d');
    cx2.drawImage(c, 0, 0);
    cx2.font = '600 11px -apple-system, Segoe UI, Roboto, sans-serif';
    cx2.textBaseline = 'top';
    for (const l of labelled) {
      cx2.strokeStyle = '#ff3b30';
      cx2.lineWidth = 2;
      cx2.strokeRect(l.box.x - 1, l.box.y - 1, l.box.width + 2, l.box.height + 2);
      const label = l.type;
      const w = cx2.measureText(label).width + 8;
      const ly = l.box.y - 15 < 0 ? l.box.y + l.box.height + 3 : l.box.y - 15;
      cx2.fillStyle = '#ff3b30';
      cx2.fillRect(l.box.x - 1, ly, w, 14);
      cx2.fillStyle = '#ffffff';
      cx2.fillText(label, l.box.x + 3, ly + 2);
    }

    return {
      redacted: c.toDataURL('image/png'),
      annotated: c2.toDataURL('image/png'),
      proof,
      verification,
      labelled: labelled.map((l) => ({ type: l.type, masked: l.masked })),
      size: [c.width, c.height]
    };
  }, { shot: analysis.shot, extraction: analysis.extraction, faces: analysis.faces });

  fs.writeFileSync(path.join(OUT, 'redacted.png'), Buffer.from(result.redacted.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(OUT, 'redacted-annotated.png'), Buffer.from(result.annotated.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(OUT, 'redaction-proof.json'), JSON.stringify(result.proof, null, 2));

  console.log(`\nredacted ${result.labelled.length} regions:`);
  for (const l of result.labelled) console.log(`  ${l.type.padEnd(14)} ${l.masked}`);
  console.log('\nproof:');
  console.log('  merkle root       ', result.proof.merkleRoot.slice(0, 32) + '…');
  console.log('  tiles committed   ', result.proof.gridWidth * result.proof.gridHeight);
  console.log('  redacted tiles    ', result.proof.redactedTileCount);
  console.log('  signature valid   ', result.verification.signatureValid);
  console.log('  inclusion valid   ', result.verification.inclusionProofsValid);
  console.log('  overall valid     ', result.verification.overallValid);
  console.log(`\nwrote ${OUT}/raw.png, redacted.png, redacted-annotated.png, redaction-proof.json`);

  await ctx.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
