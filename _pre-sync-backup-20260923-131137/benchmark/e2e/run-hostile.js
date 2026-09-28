/**
 * benchmark/e2e/run-hostile.js
 *
 * Adversarial real-browser suite. Where run-e2e.js proves the pipeline works
 * on a well-behaved page, this proves it works on the DOM structures real
 * production sites are actually built from — and it exists because every one
 * of those structures was a blind spot until it was measured.
 *
 * On first run against test-pages/hostile-realworld.html the pipeline found
 * ZERO interactive elements and ZERO sensitive items on a page carrying an
 * Aadhaar number, a PAN, and a Luhn-valid card number. Three separate causes:
 *
 *   1. document.querySelectorAll does not pierce shadow roots
 *   2. a TreeWalker does not cross shadow boundaries either
 *   3. document.elementFromPoint returns the HOST for shadow content, and
 *      Node.contains() does not cross shadow boundaries — so the occlusion
 *      check rejected every shadow element as "hidden behind something"
 *   4. content scripts ran only in the top frame, so an iframe's PII was
 *      painted into the screenshot but never detected
 *
 * Setup and invocation are the same as run-e2e.js; see the README.
 *
 *     node benchmark/e2e/run-hostile.js
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EXT = path.join(REPO, 'Browser-Agent');
const PAGES = path.join(REPO, 'test-pages');
const CHROME = process.env.PVA_CHROME || undefined;

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${info ? '  — ' + info : ''}`); }
};

function serve(dir) {
  const types = { '.html': 'text/html', '.png': 'image/png' };
  const s = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

(async () => {
  const server = await serve(PAGES);
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pva-hostile-')), {
      headless: false,
      ...(CHROME ? { executablePath: CHROME } : {}),
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
             '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: 60000,
    });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];
  const page = ctx.pages()[0];
  await page.goto(`http://127.0.0.1:${port}/hostile-realworld.html`, { waitUntil: 'load' });
  await page.bringToFront();
  await page.waitForTimeout(1400);

  const a = await sw.evaluate(async () => {
    try { const d = await performAnalysis(); return { ok: true, d }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ck('analysis completes on the hostile page', a.ok, a.ok ? '' : a.error);
  if (!a.ok) { console.log(`\n${pass} passed, ${fail} failed`); await ctx.close(); server.close(); process.exit(1); }

  const ex = a.d.extraction;
  const items = ex.sensitiveItems || [];
  const types = new Set(items.map((s) => s.type));
  const els = ex.elements || [];

  console.log('\n=== 1. shadow DOM ===');
  ck('open shadow root: Aadhaar text detected', types.has('AADHAAR'),
    `types=${[...types].join(',')}`);
  ck('open shadow root: input found', els.some((e) => /sd-aadhaar/.test(e.selector || '')),
    els.map((e) => e.selector).join(' | '));
  ck('3-deep shadow root: PAN text detected', types.has('PAN'));
  ck('3-deep shadow root: button found',
    els.some((e) => /deep-btn/.test(e.selector || '')));
  ck('shadow selectors use the piercing separator',
    els.some((e) => (e.selector || '').includes('>>>')),
    els.map((e) => e.selector).join(' | '));

  console.log('\n=== 2. closed shadow root (documented limitation) ===');
  // A closed root is unreachable from page script by browser design. The
  // IBAN inside it is expected NOT to be found — asserted so that if a
  // future browser or code change makes it reachable, the limitation note
  // gets revisited rather than silently going stale.
  const closedIbanFound = items.some((s) => s.type === 'IBAN');
  ck('closed shadow root stays unreachable (expected)', !closedIbanFound,
    closedIbanFound ? 'an IBAN was found — revisit the documented limitation' : '');

  console.log('\n=== 3. iframe: detection AND coordinate translation ===');
  ck('iframe card number detected', types.has('CARD'), `types=${[...types].join(',')}`);
  ck('iframe form fields found', els.some((e) => e.inSubframe === true),
    `subframe elements=${els.filter((e) => e.inSubframe).length}`);
  ck('frame bookkeeping reported', !!ex.frames && ex.frames.subframes >= 1,
    JSON.stringify(ex.frames));

  // The translation is the part that silently breaks: a box found at (12,30)
  // inside a frame at (200,644) must be redacted at (212,674). If the offset
  // were dropped, the box would look plausible in a log and land on empty
  // page background while the card number stayed readable.
  const frameRect = await page.evaluate(() => {
    const r = document.getElementById('pay-frame').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const card = items.find((s) => s.type === 'CARD');
  if (card && card.bbox) {
    const inside =
      card.bbox.x >= frameRect.x - 4 &&
      card.bbox.y >= frameRect.y - 4 &&
      card.bbox.x + card.bbox.width <= frameRect.x + frameRect.width + 4 &&
      card.bbox.y + card.bbox.height <= frameRect.y + frameRect.height + 4;
    ck('translated card box lands inside the iframe on screen', inside,
      `card=${JSON.stringify(card.bbox)} frame=${JSON.stringify(frameRect)}`);
    ck('translated box is not still frame-relative', card.bbox.y > frameRect.y - 4,
      `y=${card.bbox.y} vs frame y=${frameRect.y}`);
  } else {
    ck('translated card box lands inside the iframe on screen', false, 'no CARD item');
    ck('translated box is not still frame-relative', false, 'no CARD item');
  }

  console.log('\n=== 4. the box actually blacks out those pixels ===');
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  await popup.waitForTimeout(1600);
  const paint = await popup.evaluate(async ({ shot, extraction }) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = shot; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const vp = extraction.viewport;
    const card = (extraction.sensitiveItems || []).find((s) => s.type === 'CARD');
    if (!card) return { err: 'no card' };
    const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(card.bbox, vp, c.width, c.height, 4);
    const rect = {
      x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)),
      width: Math.ceil(box.width), height: Math.ceil(box.height)
    };
    const frac = (d) => {
      let nb = 0;
      for (let i = 0; i < d.data.length; i += 4) {
        if (d.data[i] > 24 || d.data[i + 1] > 24 || d.data[i + 2] > 24) nb++;
      }
      return nb / (d.data.length / 4);
    };
    const before = frac(cx.getImageData(rect.x, rect.y, rect.width, rect.height));
    cx.fillStyle = '#000';
    cx.fillRect(rect.x, rect.y, rect.width, rect.height);
    const after = frac(cx.getImageData(rect.x, rect.y, rect.width, rect.height));
    return { rect, before, after, redacted: c.toDataURL('image/png') };
  }, { shot: a.d.screenshotDataUrl, extraction: ex });

  if (paint.err) {
    ck('iframe card region blacked out', false, paint.err);
  } else {
    ck('iframe card region was visible before redaction', paint.before > 0.5,
      `${(paint.before * 100).toFixed(1)}% non-black`);
    ck('iframe card region fully black after redaction', paint.after === 0,
      `${(paint.after * 100).toFixed(2)}% non-black remains`);
    const out = path.join(__dirname, 'out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'hostile-redacted.png'),
      Buffer.from(paint.redacted.split(',')[1], 'base64'));
    console.log('  wrote out/hostile-redacted.png');
  }

  console.log('\n=== 5. SPA route change and virtualised content ===');
  await page.bringToFront();
  await page.evaluate(() => window.__HOSTILE.routeChange());
  await page.waitForTimeout(400);
  const routed = await sw.evaluate(async () => (await performAnalysis()).extraction.url);
  ck('pushState route change is reflected in the reported URL',
    /step-2/.test(routed), routed);

  await page.evaluate(() => window.__HOSTILE_scrollToRow(500));
  await page.waitForTimeout(400);
  const scrolled = await sw.evaluate(async () => {
    const d = await performAnalysis();
    return [...new Set((d.extraction.sensitiveItems || []).map((s) => s.type))];
  });
  // Row 500's IBAN is inside a scroll container that sits below the fold, so
  // it is correctly NOT redacted: it is not in the captured screenshot.
  console.log(`  INFO  after scrolling the virtual list: ${scrolled.join(', ') || '(none)'}`);
  ck('virtualised content does not crash extraction', Array.isArray(scrolled));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failed: ' + failures.join(', '));
  await ctx.close(); server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('HARNESS FAILURE:', err); process.exit(2); });
