/**
 * utils/iconHeuristics.js
 *
 * The v0 "local vision fallback" from claude/v06-local-vision-fallback-scope.md:
 * a pure classical-computer-vision heuristic — no model, no training data,
 * no network — that looks at the raw pixels of an icon-sized, unlabeled
 * interactive element (a button/link with no text, aria-label, or
 * placeholder — the case content/iconCandidateDetector.js flags) and
 * decides whether it looks like a distinct icon glyph worth telling the
 * cloud reasoner about, versus a blank/uniform area that happens to be
 * clickable.
 *
 * This exists because ISRO's PS26171 asks for "a local Vision Transformer
 * or equivalent vision model that reads screen states and makes
 * decisions" on the client. This codebase's local ML (ONNX NER, YuNet
 * faces) doesn't read the screen to inform a UI decision — only the
 * cloud VLM does. This is the honest, zero-cost v0 answer: it doesn't
 * classify WHICH icon it is (that needs a trained classifier — see the
 * v1 upgrade path in v06-local-vision-fallback-scope.md), it only adds
 * one bit of grounded information the DOM didn't have: "there is a
 * visually distinct icon glyph inside this otherwise-unlabeled button,"
 * which is exactly what a screenshot gives you that a bare DOM traversal
 * doesn't. That one bit is real signal for the downstream reasoner
 * (cloud VLM in Hybrid/Cloud dial modes, or a human via ask_user in
 * Fully Local mode) and it costs a few milliseconds of canvas math, on
 * device, on pixels that never leave the browser.
 *
 * Algorithm (classic, well-understood, deliberately not novel):
 *   1. Convert the crop to grayscale.
 *   2. Edge density: a simple Sobel-lite gradient magnitude at every
 *      interior pixel, thresholded and averaged — a flat/blank area has
 *      almost no edges; a glyph (an icon's outline, a symbol) has a
 *      meaningfully higher edge density.
 *   3. Intensity variance: a single flat-colored background has near-zero
 *      variance; a rendered glyph on a background has real variance.
 *   4. Both signals must clear their threshold — either alone can be
 *      fooled (a slightly noisy but genuinely blank background can have
 *      some variance; a hard single diagonal line has some edge density
 *      without being an icon), so requiring both is the conservative
 *      choice given there's no labeled dataset to tune false-positive
 *      rate against yet.
 *
 * Honest limitations (see v06 doc's own "fallback v0" framing): this
 * cannot say WHAT the icon is (menu vs. close vs. cart), only THAT one
 * is probably there. It will sometimes fire on a textured background
 * that isn't an icon, and sometimes miss a very simple, low-contrast
 * glyph. Both failure modes are low-cost: a false positive just adds one
 * unnecessary hint to the DOM skeleton (never blocks anything, never
 * touches privacy-sensitive data since it only ever produces the fixed
 * string "unlabeled_icon_detected"); a false negative just means the
 * status quo (no extra hint) for that one button.
 */
(function (root) {
  const EDGE_THRESHOLD = 24;       // per-pixel gradient magnitude (0-255 scale) counted as an "edge"
  const MIN_EDGE_DENSITY = 0.04;   // fraction of interior pixels that must be edges
  const MIN_INTENSITY_VARIANCE = 60; // variance of grayscale values (0-255 scale) across the crop

  /** Standard luminance-weighted grayscale conversion. */
  function toGrayscale(data, width, height) {
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  function computeEdgeDensity(gray, width, height) {
    if (width < 3 || height < 3) return 0;
    let edgeCount = 0;
    let interiorCount = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        // Simple central-difference gradient (a lighter-weight stand-in
        // for a full Sobel kernel — sufficient for a "is there structure
        // here at all" decision, not a task that needs true edge maps).
        const gx = gray[idx + 1] - gray[idx - 1];
        const gy = gray[idx + width] - gray[idx - width];
        const magnitude = Math.sqrt(gx * gx + gy * gy);
        if (magnitude >= EDGE_THRESHOLD) edgeCount++;
        interiorCount++;
      }
    }
    return interiorCount > 0 ? edgeCount / interiorCount : 0;
  }

  function computeVariance(gray) {
    if (gray.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const mean = sum / gray.length;
    let sqDiffSum = 0;
    for (let i = 0; i < gray.length; i++) {
      const d = gray[i] - mean;
      sqDiffSum += d * d;
    }
    return sqDiffSum / gray.length;
  }

  /**
   * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} imageData
   *   Anything shaped like the browser's ImageData (as returned by
   *   CanvasRenderingContext2D.getImageData()) works, including a plain
   *   object with those three fields — this makes the function trivially
   *   unit-testable outside a browser (see benchmark/run-benchmark.js's
   *   sibling test approach for utils/merkleProof.js).
   * @returns {{looksLikeIcon: boolean, edgeDensity: number, variance: number}}
   */
  function classifyIconCrop(imageData) {
    if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
      return { looksLikeIcon: false, edgeDensity: 0, variance: 0 };
    }
    const { data, width, height } = imageData;
    const gray = toGrayscale(data, width, height);
    const edgeDensity = computeEdgeDensity(gray, width, height);
    const variance = computeVariance(gray);
    const looksLikeIcon = edgeDensity >= MIN_EDGE_DENSITY && variance >= MIN_INTENSITY_VARIANCE;
    return { looksLikeIcon, edgeDensity, variance };
  }

  root.__BA_IconHeuristics = {
    classifyIconCrop,
    // Exposed for testing/tuning, not part of the stable API surface.
    _internals: { toGrayscale, computeEdgeDensity, computeVariance, EDGE_THRESHOLD, MIN_EDGE_DENSITY, MIN_INTENSITY_VARIANCE }
  };
})(typeof window !== 'undefined' ? window : self);
