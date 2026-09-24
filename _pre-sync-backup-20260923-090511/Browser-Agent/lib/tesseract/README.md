# Vendoring Tesseract.js (required for OCR-confirmed ID-image redaction)

This extension never loads code from a CDN at runtime (MV3 CSP only
allows `'self'` scripts) — every model/library it uses ships inside the
extension, the same way `lib/ort.min.js` and `models/ner/*` already do.
OCR-based ID-image confirmation (offscreen.js → `runIdImageOcrBatch`)
follows that same pattern, but the actual Tesseract.js files aren't
checked into this repo yet and need to be vendored once, locally.

**This is a one-time manual step.** Nothing else in this feature requires
it — if you skip this, `content/idImageDetector.js`'s heuristic redaction
still runs exactly as before; you just won't get the OCR "confirmed:
Aadhaar/PAN detected" evidence in the Privacy Receipt panel.

## Steps

1. From the repo root (needs network access — do this on your own
   machine, not inside any restricted sandbox):

   ```bash
   npm install tesseract.js@5 --no-save
   ```

2. Copy these three files from `node_modules/tesseract.js/dist/` and
   `node_modules/tesseract.js-core/` into this folder
   (`Browser-Agent/lib/tesseract/`):

   - `worker.min.js` (from `tesseract.js/dist/`)
   - `tesseract-core-simd.wasm.js` **and** `tesseract-core-simd.wasm`
     (from `tesseract.js-core/`) — use the non-SIMD `tesseract-core.wasm.js`
     build instead if you need broader compatibility, and update the
     `corePath` in `offscreen.js`'s `ensureOcrWorkerLoaded()` to match.
   - The UMD bundle `tesseract.min.js` (from `tesseract.js/dist/`) — this
     is the one referenced by `offscreen.html`.

3. Create a `lang-data/` subfolder here and put `eng.traineddata.gz` in
   it (download from the `tessdata_fast` repo, e.g.
   `https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_fast/eng.traineddata.gz`)
   — `offscreen.js` points `langPath` at `lib/tesseract/lang-data`.

4. Reload the unpacked extension. Check the offscreen document's console
   (via `chrome://extensions` → this extension → "service worker" /
   inspect views) for `[offscreen] Tesseract.js not found` — if that
   warning is gone, OCR confirmation is active.

## Why this step can't be automated here

The sandbox this code was written in has network access restricted to an
allowlist that does not include `registry.npmjs.org`, `unpkg.com`, or
`cdn.jsdelivr.net`, so the actual binary/WASM files could not be
downloaded and committed automatically. Everything else (the message
plumbing in `service-worker.js`, the crop/OCR/classify logic in
`offscreen.js`, and the `<script>` tag in `offscreen.html`) is already
wired up and will start working the moment these files are present.
