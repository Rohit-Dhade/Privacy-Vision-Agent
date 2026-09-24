/**
 * utils/visualStateEngine.js
 *
 * THE LOCAL SCREEN-STATE PERCEPTION ENGINE
 *
 * ISRO PS26171 asks the client side for "a local Vision Transformer or
 * equivalent vision model that reads screen states and makes decisions."
 * This module is this project's answer to the *second half* of that
 * sentence — the half most implementations skip.
 *
 * The obvious way to satisfy that requirement is to ship a general-purpose
 * vision-language model (a competing PS26171 entry ships Florence-2-base-ft:
 * ~230M parameters, ~275MB even at int8 quantisation, four ONNX graphs,
 * WebGPU-backed). That reads screen states, certainly. It also costs a
 * several-hundred-megabyte first-run download, needs WebGPU (enabled by
 * default only on Chromium browsers — Firefox still ships it off by
 * default, Safari only from v26), and spends 300-600MB of GPU/system
 * memory at inference. Two of PS26171's five weighted scoring categories
 * are client-side resource utilisation and end-to-end latency. Paying a
 * general-purpose VLM's price to answer a handful of narrow, well-posed
 * perceptual questions is the wrong trade for a problem statement whose
 * own title says "Lightweight Browser Agents."
 *
 * So this engine asks a different question: what does a browser agent
 * ACTUALLY need to know from pixels that the DOM cannot tell it?
 *
 * There are exactly four such questions, and none of them need a neural
 * network:
 *
 *   1. IS THE PAGE STILL LOADING?
 *      The DOM lies about this constantly. readyState is 'complete' while
 *      a SPA spins on a fetch; skeleton loaders are real painted elements;
 *      spinners are CSS keyframes or <canvas> that no DOM property
 *      exposes as "busy". But an animation is, by definition, pixels that
 *      change while the rest of the screen holds still — trivially
 *      detectable by differencing two frames, impossible to read from a
 *      single DOM snapshot.
 *
 *   2. IS SOMETHING BLOCKING THE PAGE?
 *      Modals, cookie walls, and consent scrims dim the page behind them.
 *      DOM-side detection needs per-site heuristics about z-index,
 *      role="dialog", and class names, and misses anything rendered
 *      unconventionally. In pixels a scrim is unmistakable: the page
 *      perimeter goes uniformly dark and low-contrast while a bright,
 *      high-detail rectangle sits in the middle.
 *
 *   3. IS THIS ELEMENT ACTUALLY PAINTED WHERE THE DOM SAYS IT IS?
 *      getBoundingClientRect() reports layout geometry, not paint. An
 *      element can be laid out, non-zero-sized, not display:none, and
 *      still be covered by a sticky header, an overlay, or simply not
 *      rendered yet in a virtualised list. Clicking it then silently
 *      does nothing — the single most common way a browser agent wastes
 *      a step and then reasons from a false premise.
 *
 *   4. DID MY LAST ACTION DO ANYTHING?
 *      This is the one that matters most and that almost nothing checks.
 *      An agent that clicks and assumes success accumulates error. Two
 *      screenshots and a tile-diff answer it definitively: nothing moved,
 *      a widget opened, or the whole page navigated.
 *
 * Every one of those is answered here with classical, deterministic image
 * processing: grayscale reduction, tile-wise mean-absolute-difference,
 * luminance and variance statistics, gradient edge density. Total cost:
 * a few milliseconds per frame on a 1280x800 screenshot, zero bytes of
 * model weights, zero runtime dependencies, no WebGPU, no WASM, no ONNX.
 * It runs identically on a flagship laptop, a four-year-old Chromebook,
 * Firefox, Safari, and Android Chrome — which is the accessibility
 * argument a several-hundred-megabyte WebGPU model cannot make.
 *
 * And critically: the OUTPUT of this engine is not a caption for a
 * language model to interpret. It is a set of discrete facts the agent
 * loop acts on directly and locally — wait instead of act, treat the
 * dialog as the only live region, refuse to click an unpainted target,
 * flag an action that changed nothing. That is "reads screen states and
 * makes decisions", executed on device, with no cloud round-trip and no
 * model inference in the loop at all.
 *
 * PRIVACY NOTE
 * This engine reads raw, pre-redaction pixels — it must, since it runs
 * before the redaction pass paints its boxes (same ordering requirement
 * as the Merkle commitment in utils/merkleProof.js). Nothing it computes
 * is derived from the CONTENT of those pixels: every output is either a
 * boolean, a coarse geometric region, or a summary statistic over
 * luminance. No crop, no pixel, and no recognised text ever leaves this
 * function, and the fields it contributes to the DOM skeleton
 * (agent/agentBackend.js) are fixed enum strings and integers that pass
 * through agent/privacyBoundary.js's allowlist like any other structural
 * metadata.
 *
 * TESTABILITY
 * Every function takes plain {data, width, height} objects shaped like the
 * browser's ImageData, so the whole engine is unit-testable in Node with
 * no DOM and no canvas — see benchmark/fixtures/visual-state.js.
 */
(function (root) {
  'use strict';

  // ── Tunables ───────────────────────────────────────────────────────────
  // All thresholds are expressed on a 0-255 luminance scale and chosen to
  // be conservative: this engine's failure mode should be "says nothing"
  // rather than "asserts something false", because a false 'no_change'
  // verdict would make the agent retry a successful action.

  const DIFF_TILE_SIZE = 16;        // px; tile granularity for frame differencing
  const TILE_CHANGE_THRESHOLD = 8;  // mean abs luminance delta for a tile to count as changed
  const MAJOR_CHANGE_RATIO = 0.35;  // >= this fraction of tiles changed => navigation-scale change
  const NOISE_FLOOR_RATIO = 0.0008; // below this, treat as compression noise, not real change

  const SPINNER_MAX_RATIO = 0.06;   // an animating spinner occupies a small part of the screen
  const SPINNER_MAX_SPAN = 0.28;    // ...and is spatially compact (fraction of the shorter side)
  const SPINNER_MIN_EDGE_DENSITY = 0.05; // ...and has real structure, not a fading background

  const SCRIM_MARGIN = 0.12;        // perimeter band width as a fraction of each side
  const SCRIM_MIN_CONTRAST_GAP = 22; // centre must be this much brighter than the dimmed perimeter
  const SCRIM_MAX_PERIMETER_VARIANCE = 2200; // a dimmed page has compressed dynamic range
  const SCRIM_MAX_BAND_SPREAD = 26; // the four perimeter bands must agree with each other
  const SCRIM_MIN_PERIMETER_DROP = 18; // temporal: how far the perimeter must darken frame-to-frame
  // Bright-block test (see detectBlockingOverlay): a dialog is a SOLID
  // bright rectangle, whereas the bright pixels on a merely dark-themed
  // page are scattered text strokes. These bound "solid" and "a dialog-
  // sized region", measured as fractions.
  const SCRIM_MIN_BLOCK_FILL = 0.45;
  const SCRIM_MIN_BLOCK_AREA = 0.02;
  const SCRIM_MAX_BLOCK_AREA = 0.72;
  const SCRIM_BLOCK_MIN_LIFT = 26;   // absolute floor for "brighter than the backdrop"
  const SCRIM_BLOCK_RANGE_FRAC = 0.45; // ...and this fraction of the frame's dynamic range

  const PAINT_MIN_VARIANCE = 12;    // a genuinely rendered control is not perfectly flat
  const PAINT_MIN_EDGE_DENSITY = 0.01;
  const EDGE_MAGNITUDE_THRESHOLD = 24;

  // ── Primitives ─────────────────────────────────────────────────────────

  /**
   * Luminance-weighted grayscale reduction. Done once per frame and shared
   * by every downstream measurement, so a full analysis pass touches each
   * pixel's colour channels exactly once.
   */
  function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  function isImageDataLike(x) {
    return !!(x && x.data && Number.isFinite(x.width) && Number.isFinite(x.height) &&
              x.width > 0 && x.height > 0);
  }

  /** Mean and variance of a grayscale buffer over an optional rectangular window. */
  function regionStats(gray, width, height, rect) {
    const x0 = rect ? Math.max(0, Math.floor(rect.x)) : 0;
    const y0 = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    const x1 = rect ? Math.min(width, Math.ceil(rect.x + rect.width)) : width;
    const y1 = rect ? Math.min(height, Math.ceil(rect.y + rect.height)) : height;
    let n = 0, sum = 0;
    for (let y = y0; y < y1; y++) {
      const rowBase = y * width;
      for (let x = x0; x < x1; x++) { sum += gray[rowBase + x]; n++; }
    }
    if (n === 0) return { mean: 0, variance: 0, count: 0 };
    const mean = sum / n;
    let sq = 0;
    for (let y = y0; y < y1; y++) {
      const rowBase = y * width;
      for (let x = x0; x < x1; x++) { const d = gray[rowBase + x] - mean; sq += d * d; }
    }
    return { mean, variance: sq / n, count: n };
  }

  /**
   * Fraction of interior pixels in a window whose central-difference
   * gradient magnitude clears EDGE_MAGNITUDE_THRESHOLD. This is the same
   * measure utils/iconHeuristics.js uses, kept consistent deliberately so
   * "has visual structure" means one thing across the whole codebase.
   */
  function edgeDensity(gray, width, height, rect) {
    const x0 = Math.max(1, rect ? Math.floor(rect.x) : 1);
    const y0 = Math.max(1, rect ? Math.floor(rect.y) : 1);
    const x1 = Math.min(width - 1, rect ? Math.ceil(rect.x + rect.width) : width - 1);
    const y1 = Math.min(height - 1, rect ? Math.ceil(rect.y + rect.height) : height - 1);
    let edges = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * width + x;
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + width] - gray[i - width];
        if (Math.sqrt(gx * gx + gy * gy) >= EDGE_MAGNITUDE_THRESHOLD) edges++;
        total++;
      }
    }
    return total > 0 ? edges / total : 0;
  }

  // ── 4. Did my last action do anything? ─────────────────────────────────

  /**
   * Tile-wise comparison of two frames of identical dimensions.
   *
   * Tiling rather than per-pixel differencing does three things at once:
   * it is ~16x cheaper, it is immune to single-pixel antialiasing and PNG
   * compression jitter, and it yields a coarse changed-region bounding box
   * for free — which is what both the spinner test and the agent's
   * "where did the page change" reasoning need.
   *
   * @returns {{
   *   comparable: boolean, changedTiles: number, totalTiles: number,
   *   changeRatio: number, changedBounds: {x,y,width,height}|null,
   *   verdict: 'no_change'|'localized_change'|'partial_change'|'major_change'
   * }}
   */
  function compareFrames(prevImageData, currImageData, tileSize = DIFF_TILE_SIZE) {
    const empty = {
      comparable: false, changedTiles: 0, totalTiles: 0, changeRatio: 0,
      changedBounds: null, verdict: 'no_change'
    };
    if (!isImageDataLike(prevImageData) || !isImageDataLike(currImageData)) return empty;
    if (prevImageData.width !== currImageData.width ||
        prevImageData.height !== currImageData.height) {
      // Differently-sized frames mean the viewport itself changed (resize,
      // devtools opening, orientation change). That IS a major change, but
      // it is not one we can localise, so we say so honestly rather than
      // fabricating a bounding box.
      return { ...empty, comparable: false, verdict: 'major_change' };
    }
    return compareGrayFrames(
      toGrayscale(prevImageData), toGrayscale(currImageData),
      prevImageData.width, prevImageData.height, tileSize
    );
  }

  /**
   * The differencing itself, operating on already-converted grayscale
   * buffers. Split out from compareFrames so that a full analysis pass can
   * convert each frame exactly once and share the result across every
   * measurement — see analyzeScreenState, where the naive version
   * re-converted the entire frame for every element it checked.
   */
  function compareGrayFrames(a, b, width, height, tileSize = DIFF_TILE_SIZE) {

    const cols = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    let changedTiles = 0;
    let minTx = Infinity, minTy = Infinity, maxTx = -Infinity, maxTy = -Infinity;

    for (let ty = 0; ty < rows; ty++) {
      const yStart = ty * tileSize;
      const yEnd = Math.min(height, yStart + tileSize);
      for (let tx = 0; tx < cols; tx++) {
        const xStart = tx * tileSize;
        const xEnd = Math.min(width, xStart + tileSize);
        let acc = 0, n = 0;
        for (let y = yStart; y < yEnd; y++) {
          const rowBase = y * width;
          for (let x = xStart; x < xEnd; x++) {
            acc += Math.abs(a[rowBase + x] - b[rowBase + x]);
            n++;
          }
        }
        if (n > 0 && acc / n >= TILE_CHANGE_THRESHOLD) {
          changedTiles++;
          if (tx < minTx) minTx = tx;
          if (ty < minTy) minTy = ty;
          if (tx > maxTx) maxTx = tx;
          if (ty > maxTy) maxTy = ty;
        }
      }
    }

    const totalTiles = cols * rows;
    const changeRatio = totalTiles > 0 ? changedTiles / totalTiles : 0;

    let changedBounds = null;
    if (changedTiles > 0) {
      changedBounds = {
        x: minTx * tileSize,
        y: minTy * tileSize,
        width: Math.min(width, (maxTx + 1) * tileSize) - minTx * tileSize,
        height: Math.min(height, (maxTy + 1) * tileSize) - minTy * tileSize
      };
    }

    let verdict;
    if (changeRatio <= NOISE_FLOOR_RATIO) verdict = 'no_change';
    else if (changeRatio >= MAJOR_CHANGE_RATIO) verdict = 'major_change';
    else if (changeRatio <= SPINNER_MAX_RATIO) verdict = 'localized_change';
    else verdict = 'partial_change';

    return { comparable: true, changedTiles, totalTiles, changeRatio, changedBounds, verdict };
  }

  // ── 1. Is the page still loading? ──────────────────────────────────────

  /**
   * A spinner is the intersection of three properties, all of which must
   * hold — any one alone produces false positives (a blinking text cursor
   * is small and compact; a video is animating; a hover effect is
   * localised):
   *
   *   small   — it occupies a tiny fraction of the viewport
   *   compact — its changed region is spatially tight, not scattered
   *   structured — the region has real edges (a glyph/arc), not a soft
   *               cross-fade of a background image
   *
   * Requires two frames captured a few hundred milliseconds apart. If the
   * caller only has one frame, this correctly returns isLoading:false
   * rather than guessing.
   */
  function detectLoadingIndicator(prevImageData, currImageData) {
    if (!isImageDataLike(currImageData)) {
      return { isLoading: false, region: null, changeRatio: 0, edgeDensity: 0, reason: 'no_animation' };
    }
    return detectLoadingFromDiff(
      compareFrames(prevImageData, currImageData),
      toGrayscale(currImageData), currImageData.width, currImageData.height
    );
  }

  /** As above, but from an already-computed diff and grayscale buffer. */
  function detectLoadingFromDiff(diff, grayCurr, width, height) {
    const none = { isLoading: false, region: null, changeRatio: 0, edgeDensity: 0, reason: 'no_animation' };
    if (!diff.comparable || !diff.changedBounds) return none;

    if (diff.changeRatio <= NOISE_FLOOR_RATIO) return none;
    if (diff.changeRatio > SPINNER_MAX_RATIO) {
      return { ...none, changeRatio: diff.changeRatio, reason: 'change_too_large' };
    }

    const shorterSide = Math.min(width, height);
    const bounds = diff.changedBounds;
    const spanFraction = Math.max(bounds.width, bounds.height) / shorterSide;
    if (spanFraction > SPINNER_MAX_SPAN) {
      return { ...none, region: bounds, changeRatio: diff.changeRatio, reason: 'change_not_compact' };
    }

    const density = edgeDensity(grayCurr, width, height, bounds);
    if (density < SPINNER_MIN_EDGE_DENSITY) {
      return { ...none, region: bounds, changeRatio: diff.changeRatio, edgeDensity: density, reason: 'region_unstructured' };
    }

    return {
      isLoading: true,
      region: bounds,
      changeRatio: diff.changeRatio,
      edgeDensity: density,
      reason: 'compact_structured_animation'
    };
  }

  // ── 2. Is something blocking the page? ─────────────────────────────────

  /**
   * Splits the perimeter into its four bands and measures each separately.
   * This is the measurement that makes scrim detection trustworthy — see
   * the discussion in detectBlockingOverlay.
   */
  function perimeterBands(gray, width, height, mx, my) {
    const bands = [
      { name: 'top',    rect: { x: 0, y: 0, width, height: my } },
      { name: 'bottom', rect: { x: 0, y: height - my, width, height: my } },
      { name: 'left',   rect: { x: 0, y: my, width: mx, height: height - 2 * my } },
      { name: 'right',  rect: { x: width - mx, y: my, width: mx, height: height - 2 * my } }
    ].map((b) => ({ ...b, stats: regionStats(gray, width, height, b.rect) }))
     .filter((b) => b.stats.count > 0);

    const means = bands.map((b) => b.stats.mean);
    const totalCount = bands.reduce((s, b) => s + b.stats.count, 0);
    const pooledMean = totalCount > 0
      ? bands.reduce((s, b) => s + b.stats.mean * b.stats.count, 0) / totalCount
      : 0;
    const pooledVariance = totalCount > 0
      ? bands.reduce((s, b) => s + (b.stats.variance + Math.pow(b.stats.mean - pooledMean, 2)) * b.stats.count, 0) / totalCount
      : 0;

    return {
      bands, means, pooledMean, pooledVariance,
      spread: means.length > 0 ? Math.max(...means) - Math.min(...means) : 0
    };
  }

  /**
   * Locates the largest CONNECTED bright region in the frame and measures
   * how solid it is.
   *
   * This is the measurement that makes single-frame scrim detection work on
   * real pages. The intuition: a modal dialog is a SOLID bright rectangle
   * sitting on a dimmed field, so its pixels are densely packed inside
   * their own bounding box. On a merely dark-themed page the bright pixels
   * are text strokes — they span a wide box but fill very little of it.
   *
   * Connectivity, rather than one global bounding box over every bright
   * pixel, is essential, and a real browser proved why. A page with a modal
   * open also has a SCROLLBAR, which is painted outside the fixed-position
   * scrim and therefore stays bright. One global bounding box unions the
   * dialog with that thin full-height strip at the frame edge, producing a
   * 915x852 box at 13% fill for what is really a 520x198 dialog at ~90%
   * fill — and the modal goes undetected. Any bright chrome the scrim does
   * not cover (scrollbars, native widgets, a focus ring at the edge) causes
   * the same corruption. Labelling connected components instead means the
   * dialog is measured as itself and the scrollbar is simply a different,
   * smaller component.
   *
   * Cost is proportional to the number of bright pixels, not to the frame,
   * because the flood fill only visits pixels above the threshold.
   *
   * @returns {{found:boolean, fill:number, areaFraction:number, rect:object|null}}
   */
  function brightestBlock(gray, width, height, perimeterMean) {
    // The threshold has to scale with the frame's dynamic range, not sit at
    // a fixed lift above the backdrop. Under a strong scrim the whole page
    // behind the dialog is dimmed but still far from black — dimmed white
    // lands around 95 — so a fixed "+26 above the perimeter mean" counts
    // that entire backdrop as bright, and the measured block becomes the
    // whole viewport at 14% fill instead of the dialog at 90%. That is
    // exactly how this test failed on the first real modal it ever saw.
    // Scaling to the range puts the threshold between the dimmed backdrop
    // and the undimmed dialog, which is where it belongs.
    let maxLuma = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] > maxLuma) maxLuma = gray[i];
    const range = Math.max(0, maxLuma - perimeterMean);
    const threshold = perimeterMean + Math.max(SCRIM_BLOCK_MIN_LIFT, SCRIM_BLOCK_RANGE_FRAC * range);

    const n = width * height;
    const bright = new Uint8Array(n);
    let brightCount = 0;
    for (let i = 0; i < n; i++) {
      if (gray[i] >= threshold) { bright[i] = 1; brightCount++; }
    }
    if (brightCount === 0) return { found: false, fill: 0, areaFraction: 0, rect: null };

    // 4-connected flood fill with an explicit stack (never recursion: a
    // full-screen bright region would blow the call stack).
    const visited = new Uint8Array(n);
    const stack = new Int32Array(brightCount);
    let best = null;

    for (let seed = 0; seed < n; seed++) {
      if (!bright[seed] || visited[seed]) continue;
      let sp = 0;
      stack[sp++] = seed;
      visited[seed] = 1;
      let count = 0;
      let minX = width, minY = height, maxX = -1, maxY = -1;

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % width;
        const y = (idx - x) / width;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0) { const l = idx - 1; if (bright[l] && !visited[l]) { visited[l] = 1; stack[sp++] = l; } }
        if (x < width - 1) { const r = idx + 1; if (bright[r] && !visited[r]) { visited[r] = 1; stack[sp++] = r; } }
        if (y > 0) { const u = idx - width; if (bright[u] && !visited[u]) { visited[u] = 1; stack[sp++] = u; } }
        if (y < height - 1) { const d = idx + width; if (bright[d] && !visited[d]) { visited[d] = 1; stack[sp++] = d; } }
      }

      if (!best || count > best.count) {
        best = { count, rect: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
      }
    }

    if (!best) return { found: false, fill: 0, areaFraction: 0, rect: null };
    const boxArea = best.rect.width * best.rect.height;
    return {
      found: true,
      fill: boxArea > 0 ? best.count / boxArea : 0,
      areaFraction: boxArea / n,
      rect: best.rect
    };
  }

  /**
   * Modal / cookie-wall / consent-scrim detection.
   *
   * The naive version of this test — "the centre is much brighter than the
   * perimeter, and the perimeter is low-variance" — is wrong, and wrong in
   * a way that matters: it fires on every dark-themed page with a lighter
   * content card, which is an extremely common layout. (This was caught by
   * the dark-theme fixture in the test suite, which exists precisely to
   * keep this honest.)
   *
   * The fix comes from asking what a scrim physically IS: a single
   * translucent black layer painted over the ENTIRE page. That has a
   * consequence the naive test ignores — it dims all four perimeter bands
   * by the same multiplicative factor, so the top, bottom, left and right
   * bands all end up at similar mean luminance regardless of what the page
   * underneath them looked like. A dark theme, by contrast, has
   * *differentiated* chrome: a near-black header, a slightly different
   * sidebar, a content area bleeding into the right margin. Its bands
   * disagree with each other. Band agreement is therefore the signal that
   * separates "everything is uniformly dimmed" from "this page is just
   * dark", and it is what the naive brightness gap alone cannot see.
   *
   * When a previous frame is available the test gets stronger still, and
   * becomes essentially unambiguous: a modal APPEARING is a page-wide
   * perimeter darkening between two consecutive frames. A dark theme is
   * equally dark in both frames and produces no such transition. The
   * temporal path is preferred when it can be used and reported at higher
   * confidence; the single-frame path remains as the fallback for the case
   * that genuinely needs it — a cookie wall that was already up before the
   * agent took its first screenshot.
   *
   * Deliberately one-sided: light scrims over dark UIs exist, but
   * supporting them would cost more false positives on ordinary light
   * pages than the added recall is worth.
   */
  function detectBlockingOverlay(imageData, prevImageData = null) {
    if (!isImageDataLike(imageData)) {
      return {
        hasBlockingOverlay: false, contrastGap: 0, bandSpread: 0, perimeterDrop: 0,
        perimeterLuma: 0, centreLuma: 0, perimeterVariance: 0,
        confidence: 'none', dialogRegion: null
      };
    }
    const usablePrev = isImageDataLike(prevImageData) &&
      prevImageData.width === imageData.width && prevImageData.height === imageData.height;
    return detectOverlayFromGray(
      toGrayscale(imageData),
      usablePrev ? toGrayscale(prevImageData) : null,
      imageData.width, imageData.height
    );
  }

  /** As above, but from already-computed grayscale buffers. */
  function detectOverlayFromGray(gray, grayPrev, width, height) {
    const none = {
      hasBlockingOverlay: false, contrastGap: 0, bandSpread: 0, perimeterDrop: 0,
      perimeterLuma: 0, centreLuma: 0, perimeterVariance: 0,
      confidence: 'none', dialogRegion: null
    };

    const mx = Math.max(1, Math.floor(width * SCRIM_MARGIN));
    const my = Math.max(1, Math.floor(height * SCRIM_MARGIN));
    const centreRect = { x: mx, y: my, width: width - 2 * mx, height: height - 2 * my };
    if (centreRect.width <= 0 || centreRect.height <= 0) return none;

    const centre = regionStats(gray, width, height, centreRect);
    const perimeter = perimeterBands(gray, width, height, mx, my);
    const contrastGap = centre.mean - perimeter.pooledMean;

    // ── Temporal evidence (preferred when available) ────────────────────
    let perimeterDrop = 0;
    let temporalPositive = false;
    if (grayPrev) {
      const prevPerimeter = perimeterBands(grayPrev, width, height, mx, my);
      perimeterDrop = prevPerimeter.pooledMean - perimeter.pooledMean;
      // Every band must have darkened, not just the average — a page that
      // merely scrolled changes some bands and not others.
      const allBandsDarkened = perimeter.bands.every((b, i) => {
        const before = prevPerimeter.bands[i];
        return before && (before.stats.mean - b.stats.mean) >= SCRIM_MIN_PERIMETER_DROP * 0.5;
      });
      temporalPositive = perimeterDrop >= SCRIM_MIN_PERIMETER_DROP &&
                         allBandsDarkened &&
                         contrastGap >= SCRIM_MIN_CONTRAST_GAP;
    }

    // ── Single-frame evidence (fallback) ────────────────────────────────
    //
    // The contrast-gap test alone is not enough on real pages, and the
    // first real-browser run proved it: a 520px-wide dialog inside a
    // 1288px viewport leaves most of the "centre" region still scrimmed,
    // so the centre MEAN is dragged down and the gap measured only 14
    // against a 22 threshold — a genuine modal, missed. Averaging over a
    // region that is mostly backdrop is simply the wrong statistic for
    // "is there a bright dialog here".
    //
    // So the primary single-frame signal is the bright-block test: find
    // the brightest coherent region and ask whether it is SOLID and
    // dialog-sized. That is a property of dialogs specifically, and it is
    // what distinguishes one from a dark-themed page whose bright pixels
    // are scattered text. The band-agreement test is kept alongside it as
    // the "everything behind is uniformly dimmed" condition.
    const block = brightestBlock(gray, width, height, perimeter.pooledMean);
    const blockPositive =
      block.found &&
      block.fill >= SCRIM_MIN_BLOCK_FILL &&
      block.areaFraction >= SCRIM_MIN_BLOCK_AREA &&
      block.areaFraction <= SCRIM_MAX_BLOCK_AREA &&
      perimeter.spread <= SCRIM_MAX_BAND_SPREAD &&
      perimeter.pooledVariance <= SCRIM_MAX_PERIMETER_VARIANCE;

    // The original mean-based test is retained as a second route, since it
    // still fires correctly on a full-bleed scrim with a large dialog.
    const meanPositive =
      contrastGap >= SCRIM_MIN_CONTRAST_GAP &&
      perimeter.spread <= SCRIM_MAX_BAND_SPREAD &&
      perimeter.pooledVariance <= SCRIM_MAX_PERIMETER_VARIANCE;

    const singleFramePositive = blockPositive || meanPositive;
    const hasBlockingOverlay = temporalPositive || singleFramePositive;

    return {
      hasBlockingOverlay,
      contrastGap,
      bandSpread: perimeter.spread,
      perimeterDrop,
      perimeterLuma: perimeter.pooledMean,
      centreLuma: centre.mean,
      perimeterVariance: perimeter.pooledVariance,
      blockFill: block.fill,
      blockAreaFraction: block.areaFraction,
      confidence: temporalPositive ? 'high' : (singleFramePositive ? 'moderate' : 'none'),
      // The live region an agent should restrict itself to while a modal
      // is up. When the bright-block test located an actual dialog, use
      // its measured rectangle — that is far tighter than the coarse
      // centre box, which is only a fallback for the other two routes.
      dialogRegion: hasBlockingOverlay
        ? (blockPositive && block.rect ? block.rect : centreRect)
        : null
    };
  }

  // ── 3. Is this element actually painted? ───────────────────────────────

  /**
   * Confirms that a control the DOM claims is visible has actually been
   * rendered into the pixels at those coordinates.
   *
   * A real interactive control is never perfectly flat: it has a border, a
   * label, a fill that differs from its surroundings, or at minimum an
   * antialiased edge. A region that is genuinely featureless is either
   * covered by an opaque overlay, not yet rendered (virtualised list,
   * lazy image), or positioned off the painted area.
   *
   * The caller passes the element's box already mapped into screenshot
   * pixel space (utils/coordinateMapper.js does this mapping everywhere
   * else in the codebase — redaction boxes, Merkle tiles, icon crops —
   * and it is reused here rather than duplicated).
   */
  function verifyElementPainted(imageData, box) {
    if (!isImageDataLike(imageData) || !box) {
      return { painted: true, confident: false, variance: 0, edgeDensity: 0, reason: 'unmeasurable' };
    }
    return verifyPaintedFromGray(toGrayscale(imageData), imageData.width, imageData.height, box);
  }

  /** As above, but from an already-computed grayscale buffer.
   *  This split is what makes checking dozens of elements per step cheap:
   *  the public wrapper converts the whole frame each call, which was fine
   *  for one box and quadratic-feeling for fifty. */
  function verifyPaintedFromGray(gray, width, height, box) {
    const unknown = { painted: true, confident: false, variance: 0, edgeDensity: 0, reason: 'unmeasurable' };
    if (!box) return unknown;

    const rect = {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.min(width - Math.max(0, Math.floor(box.x)), Math.ceil(box.width)),
      height: Math.min(height - Math.max(0, Math.floor(box.y)), Math.ceil(box.height))
    };
    // Too small to measure meaningfully. Fail OPEN (assume painted): this
    // check exists to catch a specific failure, not to become a new way
    // for the agent to refuse to act.
    if (rect.width < 3 || rect.height < 3) return unknown;

    const stats = regionStats(gray, width, height, rect);
    const density = edgeDensity(gray, width, height, rect);
    const painted = stats.variance >= PAINT_MIN_VARIANCE || density >= PAINT_MIN_EDGE_DENSITY;

    return {
      painted,
      confident: true,
      variance: stats.variance,
      edgeDensity: density,
      meanLuma: stats.mean,
      reason: painted ? 'has_visual_structure' : 'region_is_featureless'
    };
  }

  // ── Orchestration ──────────────────────────────────────────────────────

  /**
   * One call that produces the complete screen-state report the agent loop
   * consumes each step.
   *
   * @param {object} currImageData   this step's raw screenshot pixels
   * @param {object|null} prevImageData  last step's, when available
   * @param {Array<{elementId:string, box:object}>} elementBoxes  candidate
   *        interaction targets, already in screenshot pixel space
   * @returns a plain, serialisable report — every field is a boolean,
   *          number, fixed enum string, or coarse rectangle.
   */
  function analyzeScreenState(currImageData, prevImageData = null, elementBoxes = []) {
    const report = {
      isLoading: false,
      loadingRegion: null,
      hasBlockingOverlay: false,
      overlayConfidence: 'none',
      dialogRegion: null,
      frameDelta: null,
      unpaintedElementIds: [],
      analyzed: false
    };
    if (!isImageDataLike(currImageData)) return report;
    report.analyzed = true;

    // Each frame is converted to grayscale EXACTLY ONCE here and the buffer
    // shared by every measurement below. The public single-purpose
    // functions each convert on their own call, which is correct but would
    // mean re-walking the whole frame once per element checked — the
    // difference between a few milliseconds and a few hundred on a page
    // with fifty interactive elements.
    const width = currImageData.width;
    const height = currImageData.height;
    const grayCurr = toGrayscale(currImageData);
    const usablePrev = isImageDataLike(prevImageData) &&
      prevImageData.width === width && prevImageData.height === height;
    const grayPrev = usablePrev ? toGrayscale(prevImageData) : null;

    const overlay = detectOverlayFromGray(grayCurr, grayPrev, width, height);
    report.hasBlockingOverlay = overlay.hasBlockingOverlay;
    report.overlayConfidence = overlay.confidence;
    report.dialogRegion = overlay.dialogRegion;

    if (isImageDataLike(prevImageData)) {
      const diff = usablePrev
        ? compareGrayFrames(grayPrev, grayCurr, width, height)
        : compareFrames(prevImageData, currImageData); // differing sizes
      report.frameDelta = {
        verdict: diff.verdict,
        changeRatio: Number(diff.changeRatio.toFixed(4)),
        changedBounds: diff.changedBounds
      };
      const loading = detectLoadingFromDiff(diff, grayCurr, width, height);
      report.isLoading = loading.isLoading;
      report.loadingRegion = loading.region;
    }

    if (Array.isArray(elementBoxes) && elementBoxes.length > 0) {
      for (const entry of elementBoxes) {
        if (!entry || !entry.box) continue;
        const paint = verifyPaintedFromGray(grayCurr, width, height, entry.box);
        if (paint.confident && !paint.painted) report.unpaintedElementIds.push(entry.elementId);
      }
    }

    return report;
  }

  /**
   * Turns the perceptual report into the agent's next move, locally.
   *
   * This is the "makes decisions" half of the PS requirement, and it is
   * deliberately a pure function of the report: no model, no network, no
   * hidden state, so its behaviour is fully auditable and unit-testable.
   *
   * Returns null when vision has nothing decisive to contribute — the
   * common case, and the correct one. This engine's job is to intervene
   * when it KNOWS something the reasoner doesn't, not to drive every step.
   *
   * @returns {{action: string, reason: string, detail?: object}|null}
   */
  function deriveVisualDecision(report, lastActionKind = null) {
    if (!report || !report.analyzed) return null;

    // A page mid-load is the one case where the right move is provably
    // "do nothing yet". Acting into a loading page is how agents click
    // stale targets. Resolving this locally also skips an entire cloud
    // round-trip — the cheapest correct decision in the whole loop.
    if (report.isLoading) {
      return {
        action: 'wait',
        reason: 'local_vision_detected_loading_indicator',
        detail: { region: report.loadingRegion }
      };
    }

    // An action that changed nothing on screen did not land. Saying so is
    // strictly better than the agent's default assumption of success,
    // which silently corrupts every subsequent step's premises.
    if (lastActionKind && ['click', 'type', 'select'].includes(lastActionKind) &&
        report.frameDelta && report.frameDelta.verdict === 'no_change') {
      return {
        action: 'flag_ineffective_action',
        reason: 'local_vision_saw_no_change_after_action',
        detail: { changeRatio: report.frameDelta.changeRatio }
      };
    }

    // A scrim means the page behind it is not interactable, whatever the
    // DOM says about those elements. This constrains target selection
    // rather than overriding it.
    if (report.hasBlockingOverlay) {
      return {
        action: 'constrain_to_dialog',
        reason: 'local_vision_detected_blocking_overlay',
        detail: { dialogRegion: report.dialogRegion }
      };
    }

    return null;
  }

  root.__BA_VisualStateEngine = {
    analyzeScreenState,
    deriveVisualDecision,
    compareFrames,
    detectLoadingIndicator,
    detectBlockingOverlay,
    verifyElementPainted,
    _internals: {
      toGrayscale, regionStats, edgeDensity, perimeterBands, brightestBlock,
      compareGrayFrames, detectLoadingFromDiff, detectOverlayFromGray, verifyPaintedFromGray,
      DIFF_TILE_SIZE, TILE_CHANGE_THRESHOLD, MAJOR_CHANGE_RATIO, NOISE_FLOOR_RATIO,
      SPINNER_MAX_RATIO, SPINNER_MAX_SPAN, SPINNER_MIN_EDGE_DENSITY,
      SCRIM_MARGIN, SCRIM_MIN_CONTRAST_GAP, SCRIM_MAX_PERIMETER_VARIANCE,
      SCRIM_MAX_BAND_SPREAD, SCRIM_MIN_PERIMETER_DROP,
      SCRIM_MIN_BLOCK_FILL, SCRIM_MIN_BLOCK_AREA, SCRIM_MAX_BLOCK_AREA, SCRIM_BLOCK_MIN_LIFT, SCRIM_BLOCK_RANGE_FRAC,
      PAINT_MIN_VARIANCE, PAINT_MIN_EDGE_DENSITY
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__BA_VisualStateEngine;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
