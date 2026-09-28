"""
Procedural renderer for common web-UI icon glyphs.

Why procedural: the npm/CDN hosts that serve Material Symbols, Font Awesome
and Bootstrap Icons are outside this environment's egress allowlist, so the
icon sets themselves can't be vendored. These glyphs are geometrically
standardised across every major icon set though (a hamburger is three
stacked bars everywhere; a close is an X everywhere), so drawing them
directly — across the full range of stroke weights, sizes, fills, polarities
and backgrounds the real sets span — produces a legitimate training
distribution.

Rendering is supersampled 4x and downsampled for real antialiasing, so the
samples have the soft edges a browser actually paints, not hard aliased
pixels a model could overfit to.
"""
import math
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersampling factor
CANVAS = 64

CLASSES = [
    'menu', 'close', 'search', 'cart', 'user', 'settings',
    'chevron_left', 'chevron_right', 'plus', 'more',
    'download', 'heart', 'play', 'other'
]
CLASS_INDEX = {c: i for i, c in enumerate(CLASSES)}


def _line(d, p0, p1, w, fill, caps=True):
    d.line([p0, p1], fill=fill, width=int(max(1, w)))
    if caps:
        r = w / 2.0
        for (x, y) in (p0, p1):
            d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def _draw_glyph(d, name, S, w, fill, rng, filled):
    """Draw `name` inside a box of side S (origin 0,0) with stroke width w."""
    m = S * 0.16          # margin
    a, b = m, S - m       # inner box bounds
    cx = cy = S / 2.0
    inner = b - a

    if name == 'menu':
        n = 3
        for i in range(n):
            y = a + inner * (i / (n - 1))
            _line(d, (a, y), (b, y), w, fill)

    elif name == 'close':
        _line(d, (a, a), (b, b), w, fill)
        _line(d, (b, a), (a, b), w, fill)

    elif name == 'search':
        r = inner * 0.30
        ccx, ccy = a + r + inner * 0.04, a + r + inner * 0.04
        d.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], outline=fill, width=int(max(1, w)))
        k = 0.7071
        _line(d, (ccx + r * k, ccy + r * k), (b, b), w, fill)

    elif name == 'cart':
        top = a + inner * 0.22
        bot = a + inner * 0.66
        left, right = a + inner * 0.16, b
        # basket
        pts = [(left, top), (right, top), (right - inner * 0.10, bot), (left + inner * 0.08, bot)]
        if filled:
            d.polygon(pts, fill=fill)
        else:
            d.line(pts + [pts[0]], fill=fill, width=int(max(1, w)))
        # handle
        _line(d, (a, a + inner * 0.06), (left, top), w, fill)
        # wheels
        wr = max(1.5, inner * 0.09)
        for wx in (left + inner * 0.18, right - inner * 0.22):
            d.ellipse([wx - wr, bot + wr * 0.6 - wr, wx + wr, bot + wr * 0.6 + wr], fill=fill)

    elif name == 'user':
        hr = inner * 0.21
        hcy = a + hr + inner * 0.04
        if filled:
            d.ellipse([cx - hr, hcy - hr, cx + hr, hcy + hr], fill=fill)
        else:
            d.ellipse([cx - hr, hcy - hr, cx + hr, hcy + hr], outline=fill, width=int(max(1, w)))
        bw = inner * 0.40
        by = b
        box = [cx - bw, by - inner * 0.42, cx + bw, by + inner * 0.42]
        if filled:
            d.pieslice(box, 180, 360, fill=fill)
        else:
            d.arc(box, 180, 360, fill=fill, width=int(max(1, w)))

    elif name == 'settings':
        teeth = rng.choice([6, 8])
        rout = inner * 0.46
        rin = inner * 0.30
        tw = w * 1.1
        for i in range(teeth):
            ang = (2 * math.pi * i) / teeth
            x0, y0 = cx + rin * math.cos(ang), cy + rin * math.sin(ang)
            x1, y1 = cx + rout * math.cos(ang), cy + rout * math.sin(ang)
            _line(d, (x0, y0), (x1, y1), tw, fill)
        d.ellipse([cx - rin, cy - rin, cx + rin, cy + rin], outline=fill, width=int(max(1, w)))
        hr = inner * 0.12
        d.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], outline=fill, width=int(max(1, w * 0.8)))

    elif name in ('chevron_left', 'chevron_right'):
        xt, xb = (b - inner * 0.12, a + inner * 0.30)
        if name == 'chevron_right':
            xt, xb = (a + inner * 0.12, b - inner * 0.30)
        _line(d, (xt, a), (xb, cy), w, fill)
        _line(d, (xb, cy), (xt, b), w, fill)

    elif name == 'plus':
        _line(d, (cx, a), (cx, b), w, fill)
        _line(d, (a, cy), (b, cy), w, fill)

    elif name == 'more':
        r = max(1.5, inner * 0.10)
        vertical = rng.random() < 0.5
        for i in range(3):
            t = a + inner * (i / 2.0)
            px, py = (cx, t) if vertical else (t, cy)
            d.ellipse([px - r, py - r, px + r, py + r], fill=fill)

    elif name == 'download':
        _line(d, (cx, a), (cx, a + inner * 0.60), w, fill)
        head = inner * 0.20
        _line(d, (cx - head, a + inner * 0.40), (cx, a + inner * 0.62), w, fill)
        _line(d, (cx + head, a + inner * 0.40), (cx, a + inner * 0.62), w, fill)
        _line(d, (a, b), (b, b), w, fill)

    elif name == 'heart':
        r = inner * 0.26
        ly, ty = cy - inner * 0.10, cy - inner * 0.10
        pts = []
        steps = 60
        for i in range(steps + 1):
            t = math.pi * i / steps
            pts.append((cx - r + r * math.cos(math.pi - t), ty - r * math.sin(t)))
        for i in range(steps + 1):
            t = math.pi * i / steps
            pts.append((cx + r + r * math.cos(math.pi - t), ty - r * math.sin(t)))
        pts.append((cx, b))
        if filled:
            d.polygon(pts, fill=fill)
        else:
            d.line(pts + [pts[0]], fill=fill, width=int(max(1, w)))

    elif name == 'play':
        pts = [(a + inner * 0.14, a), (b, cy), (a + inner * 0.14, b)]
        if filled:
            d.polygon(pts, fill=fill)
        else:
            d.line(pts + [pts[0]], fill=fill, width=int(max(1, w)))

    elif name == 'other':
        kind = rng.randrange(6)
        if kind == 0:      # text-like bars (the most common real distractor)
            rows = rng.randrange(2, 5)
            for i in range(rows):
                y = a + inner * i / max(1, rows - 1)
                _line(d, (a, y), (a + inner * rng.uniform(0.4, 1.0), y), w * 0.7, fill, caps=False)
        elif kind == 1:    # plain rectangle / image placeholder
            d.rectangle([a, a, b, b], outline=fill, width=int(max(1, w)))
        elif kind == 2:    # random scribble
            pts = [(rng.uniform(a, b), rng.uniform(a, b)) for _ in range(rng.randrange(3, 6))]
            for i in range(len(pts) - 1):
                _line(d, pts[i], pts[i + 1], w, fill)
        elif kind == 3:    # single blob
            r = inner * rng.uniform(0.15, 0.45)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
        elif kind == 4:    # diagonal stripes / texture
            step = max(3, int(inner / rng.randrange(3, 7)))
            for x in range(int(a), int(b), step):
                _line(d, (x, a), (x + inner * 0.4, b), w * 0.6, fill, caps=False)
        else:              # nearly empty (a blank clickable area)
            if rng.random() < 0.5:
                r = inner * 0.06
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def render_icon(name, rng, hard=False, stress=False):
    """Render one augmented 64x64 grayscale sample as a float array in [0,1].

    `hard` turns on the full realistic augmentation range — low contrast,
    blur, sensor-style noise, intrusive button borders. TRAINING USES THIS
    TOO: an earlier version trained on clean glyphs and evaluated on
    degraded ones, which produced a model that scored 100% on training data
    and 46% on the held-out set. Robustness you never train for is not
    robustness. `stress` goes beyond the training range and is used only to
    measure out-of-distribution degradation honestly.
    """
    if stress:
        hard = True
    size_lo, size_hi = (16, 60) if stress else ((18, 58) if hard else (22, 54))
    S = rng.randint(size_lo, size_hi)
    stroke = max(1.2, S * rng.uniform(0.045, 0.13))
    filled = rng.random() < 0.45

    big = int(S * SS)
    layer = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(layer)
    _draw_glyph(d, name, big, stroke * SS, 255, rng, filled)
    layer = layer.resize((S, S), Image.LANCZOS)

    # rotation: chevrons/play encode direction, so they get only slight jitter
    max_rot = 6 if name in ('chevron_left', 'chevron_right', 'play', 'download') else 12
    if hard:
        max_rot += 6
    rot = rng.uniform(-max_rot, max_rot)
    if abs(rot) > 0.5:
        layer = layer.rotate(rot, resample=Image.BILINEAR, expand=False)

    # background: solid, gradient, or noisy
    bg_val = rng.uniform(0.80, 1.0) if rng.random() < 0.65 else rng.uniform(0.0, 0.22)
    canvas = np.full((CANVAS, CANVAS), bg_val, dtype=np.float32)
    style = rng.random()
    if style < 0.18:  # subtle gradient
        g = np.linspace(-0.09, 0.09, CANVAS, dtype=np.float32)
        canvas += g[None, :] if rng.random() < 0.5 else g[:, None]
    if hard and rng.random() < 0.5:  # a border/edge cutting through the crop
        if rng.random() < 0.5:
            canvas[: rng.randrange(1, 5), :] = rng.uniform(0, 1)
        else:
            canvas[:, : rng.randrange(1, 5)] = rng.uniform(0, 1)

    # glyph colour: opposite polarity from the background, with contrast jitter
    fg_val = rng.uniform(0.0, 0.22) if bg_val > 0.5 else rng.uniform(0.78, 1.0)
    if hard:
        mix = rng.uniform(0.10, 0.30) if not stress else rng.uniform(0.28, 0.45)
        fg_val = fg_val * (1 - mix) + bg_val * mix  # lower contrast

    alpha = np.asarray(layer, dtype=np.float32) / 255.0
    ox = rng.randint(0, CANVAS - S)
    oy = rng.randint(0, CANVAS - S)
    region = canvas[oy:oy + S, ox:ox + S]
    canvas[oy:oy + S, ox:ox + S] = region * (1 - alpha) + fg_val * alpha

    img = Image.fromarray(np.clip(canvas * 255, 0, 255).astype(np.uint8))
    blur = rng.uniform(0, 2.2) if stress else (rng.uniform(0, 1.4) if hard else rng.uniform(0, 0.9))
    if blur > 0.15:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    arr = np.asarray(img, dtype=np.float32) / 255.0

    noise = rng.uniform(0, 0.14) if stress else (rng.uniform(0, 0.09) if hard else rng.uniform(0, 0.045))
    if noise > 0.004:
        arr = arr + np.random.normal(0, noise, arr.shape).astype(np.float32)

    return np.clip(arr, 0, 1)
