/**
 * benchmark/e2e/run-e2e.js
 *
 * End-to-end browser test: 49 assertions over the whole pipeline.
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
 *     node benchmark/e2e/run-e2e.js
 *
 * Set PVA_CHROME to use a specific Chromium/Chrome binary instead of the
 * one Playwright downloads. Extensions require a headed browser, so on a
 * headless machine run this under xvfb:
 *     xvfb-run -a node benchmark/e2e/run-e2e.js
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

let pass = 0, fail = 0;
// Set in section 2 when YuNet detects the fixture's face; used in section 4
// to prove the face is actually blacked out, not merely detected.
let faceBoxForRedaction = null;
const failures = [];
const ck = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${info ? '  — ' + info : ''}`); }
};

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve(PAGES);
  const port = server.address().port;
  const PAGE_URL = `http://127.0.0.1:${port}/kyc-onboarding-demo.html`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pva-e2e-'));
  const consoleErrors = [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(CHROME ? { executablePath: CHROME } : {}),
    viewport: { width: 1280, height: 860 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    ],
    timeout: 60000,
  });

  const watch = (t, label) => {
    t.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${label}] ${m.text()}`); });
    t.on('pageerror', (e) => consoleErrors.push(`[${label}:pageerror] ${e.message}`));
  };

  let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  watch(sw, 'sw');
  const extId = sw.url().split('/')[2];

  console.log(`\nextension ${extId}\nfixture ${PAGE_URL}\n`);

  // ── 1. Extension loads and the page under test opens ──────────────────
  console.log('=== 1. load + content script injection ===');
  const page = context.pages()[0] || await context.newPage();
  watch(page, 'page');
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.bringToFront();
  await page.waitForTimeout(1200);
  ck('extension service worker running', !!extId);
  ck('fixture page loaded', (await page.title()).includes('Meridian'));

  // The manifest's static content script runs in the extension's ISOLATED
  // world, which page.evaluate() (main world) cannot see — so ask the
  // service worker to look, exactly as the extension itself does.
  const isolated = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        pii: typeof window.__BA_PiiDetector,
        url: location.href
      })
    });
    return result;
  });
  ck('static content script (piiDetector) present in isolated world',
    isolated.pii === 'object', `typeof=${isolated.pii} url=${isolated.url}`);

  // ── 2. The real extraction pipeline, via the service worker ───────────
  console.log('\n=== 2. full extraction pipeline (real ANALYZE_PAGE path) ===');
  const analysis = await sw.evaluate(async () => {
    try {
      const data = await performAnalysis();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), stack: e && e.stack };
    }
  });

  ck('performAnalysis() completed without throwing', analysis.ok,
    analysis.ok ? '' : analysis.error);
  if (analysis.ok) {
    // The degradation contract: face detection may be unavailable, but it
    // must report that explicitly rather than looking like a clean scan.
    const fa = analysis.data.faceDetectionAvailable;
    ck('faceDetectionAvailable flag reported', typeof fa === 'boolean', `got ${typeof fa}`);
    if (fa === false) {
      // DEGRADED PATH. This is the exact state that used to kill the whole
      // analysis, so the contract is asserted rather than tolerated.
      console.log('  PATH: degraded — the ONNX runtime could not start, so ' +
        'face detection is unavailable. Everything else must still work.');
      ck('degraded mode still returns a usable extraction',
        Array.isArray(analysis.data.extraction?.elements) && analysis.data.extraction.elements.length > 10,
        `elements=${analysis.data.extraction?.elements?.length}`);
      ck('degraded mode still returns a screenshot',
        typeof analysis.data.screenshotDataUrl === 'string');
      ck('degraded mode explains why', typeof analysis.data.faceDetectionError === 'string');
      console.log('  NOTE: the FULL path (ONNX runtime + YuNet loading) was not ' +
        'exercised by this run. It needs Browser-Agent/lib/*.wasm present.');
    } else {
      // FULL PATH: the ONNX runtime started, YuNet loaded, and inference ran
      // against the real captured screenshot.
      console.log('  PATH: full — ONNX runtime started and YuNet ran on the real screenshot.');
      ck('full path reports no face-detection error',
        analysis.data.faceDetectionError === null || analysis.data.faceDetectionError === undefined,
        String(analysis.data.faceDetectionError));
      ck('full path returns a face array', Array.isArray(analysis.data.faces),
        typeof analysis.data.faces);
      // The fixture carries exactly one drawn face, verified detectable by
      // this very model (benchmark/e2e generated and probed it). Asserting
      // the COUNT rather than ">0" also catches a detector that has started
      // hallucinating faces across the page.
      const faces = analysis.data.faces || [];
      ck('exactly one face detected on the fixture', faces.length === 1, `found ${faces.length}`);
      if (faces.length) {
        // And it must be where the photograph actually is, not anywhere.
        const imgBox = await page.evaluate(() => {
          const r = document.getElementById('gt-face').getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const f = faces[0];
        const insideX = f.x >= imgBox.x - 30 && f.x + f.width <= imgBox.x + imgBox.width + 30;
        const insideY = f.y >= imgBox.y - 30 && f.y + f.height <= imgBox.y + imgBox.height + 30;
        ck('detected face lies within the photograph element',
          insideX && insideY,
          `face=${JSON.stringify([Math.round(f.x), Math.round(f.y), Math.round(f.width), Math.round(f.height)])} ` +
          `img=${JSON.stringify([Math.round(imgBox.x), Math.round(imgBox.y), Math.round(imgBox.width), Math.round(imgBox.height)])}`);
        faceBoxForRedaction = f;
      }
    }
  }

  let extraction = null, screenshotDataUrl = null;
  if (analysis.ok) {
    extraction = analysis.data.extraction;
    screenshotDataUrl = analysis.data.screenshotDataUrl;
    ck('screenshot captured', typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image/'),
      typeof screenshotDataUrl);
    ck('extraction returned elements', Array.isArray(extraction?.elements) && extraction.elements.length > 10,
      `count=${extraction?.elements?.length}`);
    ck('extraction returned sensitiveItems', Array.isArray(extraction?.sensitiveItems),
      `count=${extraction?.sensitiveItems?.length}`);
    ck('extraction returned iconCandidates', Array.isArray(extraction?.iconCandidates),
      `count=${extraction?.iconCandidates?.length}`);
    ck('viewport present', !!extraction?.viewport && Number.isFinite(extraction.viewport.width));
  } else {
    console.log('  (extraction failed — skipping dependent checks)');
    console.log('  stack:', (analysis.stack || '').split('\n').slice(0, 5).join('\n         '));
  }

  // ── 3. Ground-truth PII detection on a real rendered page ─────────────
  if (extraction) {
    console.log('\n=== 3. PII detection against known ground truth ===');
    const types = new Set((extraction.sensitiveItems || []).map((s) => s.type));
    const text = JSON.stringify(extraction.sensitiveItems || []);
    // PAN note: the detector enforces the real holder-category letter
    // (4th char must be one of ABCFGHLJPT), so the fixture uses ABCPE1234F.
    for (const t of ['AADHAAR', 'PAN', 'CARD', 'IBAN', 'EMAIL', 'SECRET_TOKEN']) {
      ck(`detected ${t}`, types.has(t), `types=${[...types].join(',')}`);
    }
    ck('MRZ passport line detected', types.has('MRZ_PASSPORT'),
      `types=${[...types].join(',')}`);
    ck('no raw Aadhaar digits left in detection payload', !text.includes('234567890124') && !text.includes('2345 6789 0124'),
      'masked values should not carry the raw number');
    ck('icon candidates found on a page full of icon-only buttons',
      (extraction.iconCandidates || []).length >= 10, `count=${extraction.iconCandidates?.length}`);
  }

  // ── 4. Popup context: the real perception + proof + boundary pipeline ──
  console.log('\n=== 4. popup-side pipeline on the real screenshot ===');
  const popup = await context.newPage();
  watch(popup, 'popup');
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  await popup.waitForTimeout
    ? await popup.waitForTimeout(2000) : null;

  const modulesReady = await popup.evaluate(() => ({
    merkle: !!window.__BA_MerkleProof,
    vision: !!window.__BA_VisualStateEngine,
    icons: !!(window.__BA_IconClassifier && window.__BA_IconClassifier.isLoaded()),
    mapper: !!window.__BA_CoordinateMapper,
    boundary: !!window.__BA_PrivacyBoundary,
    matcher: !!window.__BA_FieldMatcher,
  }));
  for (const [k, v] of Object.entries(modulesReady)) ck(`popup module ready: ${k}`, v);

  if (extraction && screenshotDataUrl) {
    const result = await popup.evaluate(async ({ shot, extraction, faceBox }) => {
      const out = {};
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot; });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        out.canvas = { w: canvas.width, h: canvas.height };

        const vp = extraction.viewport;
        // Map the real PII bounding boxes exactly as popup.js does.
        const boxes = [];
        for (const item of extraction.sensitiveItems || []) {
          if (!item.bbox) continue;
          const b = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(item.bbox, vp, canvas.width, canvas.height, 4);
          if (b.width > 0 && b.height > 0) boxes.push(b);
        }
        out.mappedBoxes = boxes.length;

        // Face boxes arrive already in screenshot pixel space (YuNet runs on
        // the screenshot itself), and popup.js pads them by 10px.
        let faceRect = null;
        if (faceBox) {
          const pad = 10;
          faceRect = {
            x: Math.max(0, Math.floor(faceBox.x - pad)),
            y: Math.max(0, Math.floor(faceBox.y - pad)),
            width: Math.ceil(faceBox.width + pad * 2),
            height: Math.ceil(faceBox.height + pad * 2)
          };
          faceRect.width = Math.min(faceRect.width, canvas.width - faceRect.x);
          faceRect.height = Math.min(faceRect.height, canvas.height - faceRect.y);
          if (faceRect.width > 0 && faceRect.height > 0) boxes.push(faceRect);
        }
        out.faceBoxAdded = !!faceRect;

        // Sample the face region BEFORE painting: it must not already be black,
        // otherwise the after-check below would prove nothing.
        if (faceRect) {
          const before = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
          let nonBlack = 0;
          for (let i = 0; i < before.data.length; i += 4) {
            if (before.data[i] > 24 || before.data[i + 1] > 24 || before.data[i + 2] > 24) nonBlack++;
          }
          out.faceRegionNonBlackBefore = nonBlack / (before.data.length / 4);
        }
        out.boxesInBounds = boxes.every((b) =>
          b.x >= 0 && b.y >= 0 && b.x + b.width <= canvas.width + 1 && b.y + b.height <= canvas.height + 1);

        // Real Merkle redaction proof over real raw pixels.
        const t0 = performance.now();
        const proof = await window.__BA_MerkleProof.generateRedactionProof(ctx, canvas.width, canvas.height, boxes);
        out.proofMs = Math.round(performance.now() - t0);
        const verify = await window.__BA_MerkleProof.verifyRedactionProof(proof);
        out.proofValid = verify.overallValid;
        out.proofTiles = proof.redactedTileCount;

        // Tamper it: verification must reject.
        const tampered = JSON.parse(JSON.stringify(proof));
        tampered.merkleRoot = '0'.repeat(64);
        out.tamperRejected = (await window.__BA_MerkleProof.verifyRedactionProof(tampered)).overallValid === false;

        // Local perception on the real screenshot.
        const raw = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const elementBoxes = [];
        for (const el of extraction.elements || []) {
          if (!el.bbox) continue;
          const b = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(el.bbox, vp, canvas.width, canvas.height, 0);
          if (b.width > 0 && b.height > 0) elementBoxes.push({ elementId: el.id, box: b });
        }
        const t1 = performance.now();
        const report = window.__BA_VisualStateEngine.analyzeScreenState(raw, null, elementBoxes);
        out.visionMs = Math.round(performance.now() - t1);
        out.report = {
          analyzed: report.analyzed,
          hasBlockingOverlay: report.hasBlockingOverlay,
          overlayConfidence: report.overlayConfidence,
          unpainted: report.unpaintedElementIds.length,
          elementsChecked: elementBoxes.length,
        };

        // Real icon classification on real rendered SVG icons.
        const icons = [];
        for (const cand of extraction.iconCandidates || []) {
          const b = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(cand.bbox, vp, canvas.width, canvas.height, 0);
          const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
          const w = Math.min(canvas.width - x, Math.ceil(b.width)), h = Math.min(canvas.height - y, Math.ceil(b.height));
          if (w <= 0 || h <= 0) continue;
          const crop = ctx.getImageData(x, y, w, h);
          const r = window.__BA_IconClassifier.classifyIcon(crop);
          icons.push({ id: cand.elementId, label: r ? r.label : null, conf: r ? Number(r.confidence.toFixed(2)) : null });
        }
        out.icons = icons;

        // Outbound privacy boundary on a realistic payload.
        const payload = {
          sessionId: 'e2e', taskInstruction: 'complete the application',
          domSkeleton: { elements: (extraction.elements || []).slice(0, 40).map((el) => ({
            id: el.id, tag: el.tag, type: el.type, selector: el.selector,
            text: el.text, ariaLabel: el.ariaLabel, placeholder: el.placeholder,
            value: el.value, rawSecret: 'MUST_NOT_CROSS'
          })) },
          actionHistory: [{ action: 'type', value: '4111 1111 1111 1111', fieldName: 'card' }],
          visualState: report,
          rogueKey: 'MUST_NOT_CROSS'
        };
        const sanitized = window.__BA_PrivacyBoundary.sanitizeOutboundPayload(payload);
        const serialized = JSON.stringify(sanitized);
        out.boundary = {
          rogueStripped: sanitized.rogueKey === undefined,
          rawSecretStripped: !serialized.includes('MUST_NOT_CROSS'),
          historyValueNeutralized: sanitized.actionHistory[0].value === '[REDACTED]',
          visualStateFiltered: sanitized.visualState.unpaintedElementIds === undefined,
        };
        try {
          window.__BA_PrivacyBoundary.assertSafeForTransmission(sanitized);
          out.boundary.scanPassed = true;
        } catch (e) { out.boundary.scanPassed = false; out.boundary.scanError = e.message; }

        // And the inverse: an UNsanitized payload carrying a real card must be blocked.
        try {
          window.__BA_PrivacyBoundary.assertSafeForTransmission({ leak: '4111 1111 1111 1111' });
          out.boundary.blocksRawCard = false;
        } catch (e) { out.boundary.blocksRawCard = true; }

        // Paint the redaction boxes, exactly as popup.js does after the
        // commitment, then confirm the face region is genuinely black.
        ctx.fillStyle = '#000000';
        for (const b of boxes) ctx.fillRect(b.x, b.y, b.width, b.height);
        if (faceRect) {
          const after = ctx.getImageData(faceRect.x, faceRect.y, faceRect.width, faceRect.height);
          let nonBlack = 0;
          for (let i = 0; i < after.data.length; i += 4) {
            if (after.data[i] > 24 || after.data[i + 1] > 24 || after.data[i + 2] > 24) nonBlack++;
          }
          out.faceRegionNonBlackAfter = nonBlack / (after.data.length / 4);
        }

        return { ok: true, out };
      } catch (e) {
        return { ok: false, error: e.message, stack: e.stack, partial: out };
      }
    }, { shot: screenshotDataUrl, extraction, faceBox: faceBoxForRedaction });

    if (!result.ok) {
      ck('popup pipeline ran', false, result.error);
      console.log('  stack:', (result.stack || '').split('\n').slice(0, 6).join('\n         '));
      console.log('  partial:', JSON.stringify(result.partial));
    } else {
      const o = result.out;
      console.log(`  canvas ${o.canvas.w}x${o.canvas.h}, ${o.mappedBoxes} redaction boxes, ` +
                  `proof ${o.proofMs}ms, vision ${o.visionMs}ms over ${o.report.elementsChecked} elements`);
      ck('redaction boxes mapped from real DOM coords', o.mappedBoxes > 0, `${o.mappedBoxes}`);
      ck('all mapped boxes within canvas bounds', o.boxesInBounds);
      ck('Merkle proof generated and verifies', o.proofValid === true);
      ck('tampered Merkle root rejected', o.tamperRejected === true);
      ck('proof covers the redacted tiles', o.proofTiles > 0, `${o.proofTiles}`);
      ck('proof generation under 3s', o.proofMs < 3000, `${o.proofMs}ms`);
      ck('vision pass under 500ms on a real screenshot', o.visionMs < 500, `${o.visionMs}ms`);
      ck('vision analyzed the frame', o.report.analyzed === true);
      ck('no false modal on the un-scrimmed page', o.report.hasBlockingOverlay === false,
        `confidence=${o.report.overlayConfidence}`);
      const named = o.icons.filter((i) => i.label);
      console.log('  icon predictions:', o.icons.map((i) => `${i.id}=${i.label || 'declined'}`).join(' '));
      ck('icon classifier ran on real rendered icons', o.icons.length > 0, `${o.icons.length}`);
      ck('classifier named at least some real icons', named.length >= 2,
        `${named.length}/${o.icons.length} named`);
      ck('boundary strips unknown top-level keys', o.boundary.rogueStripped);
      ck('boundary strips unknown element fields', o.boundary.rawSecretStripped);
      ck('boundary neutralizes history values', o.boundary.historyValueNeutralized);
      ck('boundary filters visual state internals', o.boundary.visualStateFiltered);
      ck('sanitized payload passes adversarial scan', o.boundary.scanPassed === true, o.boundary.scanError || '');
      ck('adversarial scan blocks a raw card number', o.boundary.blocksRawCard === true);
      if (faceBoxForRedaction) {
        ck('face box added to the redaction set', o.faceBoxAdded === true);
        ck('face region was visible before redaction',
          o.faceRegionNonBlackBefore > 0.5, `${(o.faceRegionNonBlackBefore * 100).toFixed(1)}% non-black`);
        ck('face region is fully blacked out after redaction',
          o.faceRegionNonBlackAfter === 0, `${(o.faceRegionNonBlackAfter * 100).toFixed(2)}% non-black remains`);
      }
      fs.writeFileSync(path.join(__dirname, 'e2e-detail.json'), JSON.stringify(o, null, 2));
    }
  }

  // ── 5. Overlay detection with the modal actually open ─────────────────
  if (extraction) {
    console.log('\n=== 5. modal open: overlay detection on a real scrim ===');
    await page.bringToFront();
    await page.evaluate(() => window.__DEMO.setModal(true));
    await page.waitForTimeout(500);
    const modalAnalysis = await sw.evaluate(async () => {
      try { return { ok: true, shot: (await performAnalysis()).screenshotDataUrl }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    ck('second analysis with modal open succeeded', modalAnalysis.ok, modalAnalysis.error || '');
    if (modalAnalysis.ok) {
      const overlay = await popup.evaluate(async (shot) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const raw = cx.getImageData(0, 0, c.width, c.height);
        const r = window.__BA_VisualStateEngine.detectBlockingOverlay(raw);
        return { has: r.hasBlockingOverlay, conf: r.confidence, gap: Math.round(r.contrastGap),
                 spread: Math.round(r.bandSpread), fill: Number(r.blockFill.toFixed(2)),
                 area: Number(r.blockAreaFraction.toFixed(3)), dialog: r.dialogRegion };
      }, modalAnalysis.shot);
      ck('real modal scrim detected as blocking overlay', overlay.has === true,
        `gap=${overlay.gap} spread=${overlay.spread} fill=${overlay.fill} area=${overlay.area} conf=${overlay.conf}`);
      if (overlay.has) {
        console.log('  dialog region:', JSON.stringify(overlay.dialog));
        ck('dialog region is tighter than the whole viewport',
          overlay.dialog && overlay.dialog.width < 1000, `w=${overlay.dialog?.width}`);
      }
    }
    await page.evaluate(() => window.__DEMO.setModal(false));
  }

  // ── 5b. No false faces on a page that has none ────────────────────────
  // The main fixture now carries a face, so the opposite property needs its
  // own page: a detector that hallucinates faces would black out arbitrary
  // regions of every screenshot, which is worse than missing one.
  if (extraction && faceBoxForRedaction) {
    console.log('\n=== 5b. no false faces on a faceless page ===');
    await page.goto(`http://127.0.0.1:${port}/testing-form.html`, { waitUntil: 'load' });
    await page.bringToFront();
    await page.waitForTimeout(700);
    const faceless = await sw.evaluate(async () => {
      try {
        const d = await performAnalysis();
        return { ok: true, available: d.faceDetectionAvailable, faces: (d.faces || []).length };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    ck('analysis succeeded on the faceless page', faceless.ok, faceless.error || '');
    if (faceless.ok && faceless.available) {
      ck('no faces detected on a page containing none', faceless.faces === 0,
        `found ${faceless.faces}`);
    }
  }

  // ── 6. Console hygiene ────────────────────────────────────────────────
  console.log('\n=== 6. console errors ===');
  const realErrors = consoleErrors.filter((e) =>
    !/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|net::ERR_BLOCKED/.test(e));
  for (const e of realErrors.slice(0, 25)) console.log('  ' + e);
  ck('no unexpected console errors', realErrors.length === 0, `${realErrors.length} errors`);
  if (consoleErrors.length !== realErrors.length) {
    console.log(`  (${consoleErrors.length - realErrors.length} network errors ignored — no backend in this sandbox)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failed: ' + failures.join(', '));

  await context.close();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS FAILURE:', err);
  process.exit(2);
});
