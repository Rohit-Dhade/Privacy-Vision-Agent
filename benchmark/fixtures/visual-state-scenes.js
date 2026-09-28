/**
 * benchmark/fixtures/visual-state-scenes.js
 *
 * Synthetic page renderings with known ground truth, used both by
 * benchmark/run-benchmark.js and benchmark/test-visual-state.js to evaluate
 * utils/visualStateEngine.js.
 *
 * These are drawn rather than captured for the same reason the rest of this
 * harness uses fixtures: a screenshot of a real site is not reproducible,
 * cannot be committed without dragging along whatever was on screen, and
 * has no ground-truth label. Each scene here is constructed to isolate one
 * property the engine claims to detect — and several exist specifically to
 * be FALSE POSITIVE traps (a dark-themed page, a page with dark chrome, a
 * scrolled page), because those are the cases where a naive implementation
 * of this kind of detector quietly fails.
 */
const W = 320, H = 200;

function blank(w = W, h = H, rgb = [255, 255, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
function clone(img) {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}
function px(img, x, y, rgb) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
}
function rect(img, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(img, xx, yy, rgb);
}
function rectOutline(img, x, y, w, h, rgb) {
  for (let xx = x; xx < x + w; xx++) { px(img, xx, y, rgb); px(img, xx, y + h - 1, rgb); }
  for (let yy = y; yy < y + h; yy++) { px(img, x, yy, rgb); px(img, x + w - 1, yy, rgb); }
}
/** Alpha-blended black scrim, exactly what a modal backdrop does to pixels. */
function dim(img, factor) {
  const out = clone(img);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] *= factor; out.data[i + 1] *= factor; out.data[i + 2] *= factor;
  }
  return out;
}
function textBlock(img, x, y, w, lines, rgb = [40, 40, 45]) {
  for (let l = 0; l < lines; l++) {
    const yy = y + l * 7;
    const lineW = Math.floor(w * (0.6 + 0.4 * ((l * 37) % 10) / 10));
    rect(img, x, yy, lineW, 3, rgb);
  }
}

/** Ordinary light page: header, logo, nav, body copy, a primary button. */
function normalPage() {
  const img = blank();
  rect(img, 0, 0, W, 22, [245, 246, 248]);
  rect(img, 8, 6, 60, 10, [70, 90, 200]);
  textBlock(img, 200, 8, 100, 1, [90, 95, 105]);
  textBlock(img, 16, 40, 200, 9);
  textBlock(img, 16, 120, 180, 5);
  rect(img, 16, 165, 70, 20, [60, 120, 220]);
  rectOutline(img, 16, 165, 70, 20, [30, 80, 180]);
  return img;
}

/** Same page with a spinner arc at a given rotation, for frame differencing. */
function pageWithSpinner(angleDeg) {
  const img = normalPage();
  const cx = 160, cy = 100, r = 9;
  for (let a = angleDeg; a < angleDeg + 270; a += 3) {
    const rad = a * Math.PI / 180;
    for (let t = -1; t <= 1; t++) {
      px(img, Math.round(cx + (r + t) * Math.cos(rad)), Math.round(cy + (r + t) * Math.sin(rad)), [50, 50, 60]);
    }
  }
  return img;
}

/** A dropdown opened under the button — a localized, legitimate change. */
function pageWithDropdown() {
  const img = normalPage();
  rect(img, 16, 185, 90, 14, [255, 255, 255]);
  rectOutline(img, 16, 185, 90, 14, [180, 180, 190]);
  textBlock(img, 20, 189, 70, 1);
  return img;
}

/** An entirely different page — navigation-scale change. */
function differentPage() {
  const img = blank(W, H, [24, 26, 32]);
  rect(img, 0, 0, W, 30, [16, 18, 22]);
  textBlock(img, 20, 50, 260, 14, [200, 205, 215]);
  rect(img, 20, 160, 100, 24, [220, 80, 60]);
  return img;
}

/** Modal over the light page: scrim everywhere, bright dialog in the middle. */
function pageWithModal() {
  const scrimmed = dim(normalPage(), 0.35);
  rect(scrimmed, 70, 55, 180, 95, [255, 255, 255]);
  rectOutline(scrimmed, 70, 55, 180, 95, [200, 200, 210]);
  textBlock(scrimmed, 82, 70, 150, 6);
  rect(scrimmed, 82, 122, 60, 18, [60, 120, 220]);
  return scrimmed;
}

/** FALSE-POSITIVE TRAP: a legitimately dark-themed page with a lighter
 *  content card. Naive "centre brighter than edges" scrim detection fires
 *  on this; correct detection must not. */
function darkThemedPage() {
  const img = blank(W, H, [32, 34, 40]);
  rect(img, 0, 0, W, 24, [18, 19, 24]);
  rect(img, 0, H - 20, W, 20, [18, 19, 24]);
  rect(img, 0, 24, 46, H - 44, [22, 24, 29]);
  rect(img, 60, 34, 245, 140, [58, 62, 72]);
  textBlock(img, 70, 45, 220, 14, [210, 214, 222]);
  return img;
}

/** FALSE-POSITIVE TRAP: very common layout — white body, dark nav and footer. */
function lightPageWithDarkChrome() {
  const img = blank();
  rect(img, 0, 0, W, 26, [28, 30, 38]);
  rect(img, 10, 8, 55, 10, [230, 232, 240]);
  textBlock(img, 200, 10, 100, 1, [200, 205, 215]);
  textBlock(img, 16, 46, 280, 12);
  rect(img, 0, H - 24, W, 24, [28, 30, 38]);
  textBlock(img, 16, H - 18, 120, 1, [200, 205, 215]);
  return img;
}

/** A modal over a DARK page — must still be detected. */
function darkPageWithModal() {
  const scrimmed = dim(darkThemedPage(), 0.35);
  rect(scrimmed, 70, 55, 180, 95, [250, 250, 252]);
  rectOutline(scrimmed, 70, 55, 180, 95, [200, 200, 210]);
  textBlock(scrimmed, 82, 70, 150, 6);
  rect(scrimmed, 82, 122, 60, 18, [60, 120, 220]);
  return scrimmed;
}

/** FALSE-POSITIVE TRAP: the page after scrolling — content moves, no dimming. */
function scrolledPage() {
  const img = blank();
  rect(img, 0, 0, W, 22, [245, 246, 248]);
  rect(img, 8, 6, 60, 10, [70, 90, 200]);
  textBlock(img, 16, 30, 200, 12);
  textBlock(img, 16, 125, 240, 8);
  return img;
}

module.exports = {
  W, H, blank, clone, px, rect, rectOutline, dim, textBlock,
  normalPage, pageWithSpinner, pageWithDropdown, differentPage,
  pageWithModal, darkThemedPage, lightPageWithDarkChrome,
  darkPageWithModal, scrolledPage,
  // Boxes with known ground truth on normalPage(), for paint verification.
  PAINTED_BUTTON_BOX: { x: 16, y: 165, width: 70, height: 20 },
  PAINTED_TEXT_BOX: { x: 16, y: 40, width: 200, height: 40 },
  UNPAINTED_BOX: { x: 230, y: 100, width: 60, height: 30 }
};
