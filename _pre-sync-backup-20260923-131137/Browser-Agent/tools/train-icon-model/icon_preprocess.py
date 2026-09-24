"""
Canonical preprocessing for icon crops.

This is deliberately simple and fully specified, because it has to be
reimplemented byte-for-byte in JavaScript (utils/iconClassifier.js) for
inference in the extension. Every step below is chosen to be trivially
portable: no library resampling, no Otsu, no morphology.

The preprocessing carries most of the robustness load, which is why the
classifier itself can be tiny: by the time a crop reaches the network it
has been polarity-normalised (glyph always bright on dark), contrast-
normalised, tightly cropped to the glyph's own bounding box, and scaled to
a fixed 20x20 canvas. Stroke weight, icon size, position within the button,
and dark-vs-light theme are all absorbed here rather than having to be
learned.
"""
import numpy as np

OUT = 20
BIN_THRESHOLD = 0.45
EDGE_TRIM_MAX = 3      # most edge rows/cols that may be discarded per side
EDGE_FILL_RATIO = 0.85 # an edge line this "full" is container structure, not glyph


def _bilinear_resize(src, out_h, out_w):
    """Bilinear resample with half-pixel centre alignment and edge clamping.
    Mirrored exactly in JS — keep the arithmetic identical if changed."""
    sh, sw = src.shape
    out = np.zeros((out_h, out_w), dtype=np.float32)
    for i in range(out_h):
        sy = (i + 0.5) * (sh / out_h) - 0.5
        y0 = int(np.floor(sy))
        fy = sy - y0
        y0c = min(max(y0, 0), sh - 1)
        y1c = min(max(y0 + 1, 0), sh - 1)
        for j in range(out_w):
            sx = (j + 0.5) * (sw / out_w) - 0.5
            x0 = int(np.floor(sx))
            fx = sx - x0
            x0c = min(max(x0, 0), sw - 1)
            x1c = min(max(x0 + 1, 0), sw - 1)
            v = (src[y0c, x0c] * (1 - fx) * (1 - fy) +
                 src[y0c, x1c] * fx * (1 - fy) +
                 src[y1c, x0c] * (1 - fx) * fy +
                 src[y1c, x1c] * fx * fy)
            out[i, j] = v
    return out


def preprocess(gray):
    """gray: HxW float array in [0,1]. Returns a flat float32 vector of OUT*OUT."""
    g = np.asarray(gray, dtype=np.float32)
    h, w = g.shape
    if h < 3 or w < 3:
        return np.zeros(OUT * OUT, dtype=np.float32)

    # 1. polarity: make the glyph bright on a dark field, whatever the theme
    if float(g.mean()) > 0.5:
        g = 1.0 - g

    # 2. contrast normalise
    lo, hi = float(g.min()), float(g.max())
    g = (g - lo) / (hi - lo) if hi - lo > 1e-6 else np.zeros_like(g)

    # 3. glyph bounding box, ignoring button-border artefacts.
    #
    # A crop taken from a real page often clips the button's own border or a
    # neighbouring edge, which lands as a fully-saturated line along one side
    # of the crop. Left in, it drags the bounding box out to the crop edge
    # and shifts the glyph's framing — which was measurably the single
    # largest error source in the first version of this classifier. So edge
    # rows/columns that are almost entirely "on" are treated as structure
    # from the container, not from the glyph, and trimmed before the box is
    # measured. At most EDGE_TRIM_MAX from each side, so a genuinely
    # full-bleed glyph can never be eaten away.
    mask = g >= BIN_THRESHOLD
    ty0, ty1, tx0, tx1 = 0, h, 0, w
    for _ in range(EDGE_TRIM_MAX):
        if ty1 - ty0 > 4 and mask[ty0, tx0:tx1].mean() >= EDGE_FILL_RATIO:
            ty0 += 1
        elif ty1 - ty0 > 4 and mask[ty1 - 1, tx0:tx1].mean() >= EDGE_FILL_RATIO:
            ty1 -= 1
        elif tx1 - tx0 > 4 and mask[ty0:ty1, tx0].mean() >= EDGE_FILL_RATIO:
            tx0 += 1
        elif tx1 - tx0 > 4 and mask[ty0:ty1, tx1 - 1].mean() >= EDGE_FILL_RATIO:
            tx1 -= 1
        else:
            break

    sub = mask[ty0:ty1, tx0:tx1]
    if not sub.any():
        y0, y1, x0, x1 = 0, h, 0, w
    else:
        rows = np.where(sub.any(axis=1))[0]
        cols = np.where(sub.any(axis=0))[0]
        y0, y1 = ty0 + int(rows[0]), ty0 + int(rows[-1]) + 1
        x0, x1 = tx0 + int(cols[0]), tx0 + int(cols[-1]) + 1

    # 4. expand to a square around the bbox centre so aspect ratio is preserved
    bh, bw = y1 - y0, x1 - x0
    side = max(bh, bw)
    cy, cx = (y0 + y1) / 2.0, (x0 + x1) / 2.0
    sy0 = int(round(cy - side / 2.0))
    sx0 = int(round(cx - side / 2.0))

    # 5. gather the square window, zero-padding where it falls outside
    win = np.zeros((side, side), dtype=np.float32)
    for i in range(side):
        yy = sy0 + i
        if yy < 0 or yy >= h:
            continue
        for j in range(side):
            xx = sx0 + j
            if xx < 0 or xx >= w:
                continue
            win[i, j] = g[yy, xx]

    return _bilinear_resize(win, OUT, OUT).reshape(-1)
