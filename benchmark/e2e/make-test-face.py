"""
Generates the synthetic face embedded in test-pages/kyc-onboarding-demo.html.

Why this exists: proving that face redaction works requires a face the
shipped YuNet model will actually detect, and a fixture in a public repo
should not contain a photograph of a real person. So the face is drawn.

That is only defensible if it is genuinely detected rather than assumed to
be, so six variants of increasing realism were generated and each was run
through the extension's own detection path in a real browser. All six were
detected with sensible bounding boxes; the variant used in the fixture is
the most realistic one (directional shading plus hair).

    pip install pillow numpy
    python3 make-test-face.py            # writes test-face.png
    python3 make-test-face.py --data-uri # prints a base64 data URI

The fixture embeds it as a data URI so the page stays self-contained.

Note that "YuNet detects this drawing" is a statement about YuNet's
tolerance, not a claim that drawn faces are equivalent to photographs. The
purpose is to exercise the detect-then-redact path end to end, which it
does: benchmark/e2e/run-e2e.js asserts the region is non-black before
redaction and fully black after.
"""
import argparse
import base64
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 3  # supersample factor, for antialiased edges


def draw_face(W=220, H=260, skin=(226, 186, 158), bg=(238, 240, 244),
              shade=True, hair=True, brow=True, mouth_open=False):
    big = (W * SS, H * SS)
    im = Image.new('RGB', big, bg)
    d = ImageDraw.Draw(im)
    cx, cy = big[0] // 2, int(big[1] * 0.54)
    fw, fh = int(big[0] * 0.62), int(big[1] * 0.74)

    # neck, then the face oval over it
    d.rounded_rectangle([cx - fw // 5, cy + fh // 3, cx + fw // 5, big[1]],
                        radius=20 * SS, fill=skin)
    d.ellipse([cx - fw // 2, cy - fh // 2, cx + fw // 2, cy + fh // 2], fill=skin)

    if hair:
        d.ellipse([cx - fw // 2 - 4 * SS, cy - fh // 2 - 10 * SS,
                   cx + fw // 2 + 4 * SS, cy - fh // 10], fill=(58, 44, 36))
        d.ellipse([cx - fw // 2 + 6 * SS, cy - fh // 2 + 14 * SS,
                   cx + fw // 2 - 6 * SS, cy + fh // 6], fill=skin)

    ew = int(fw * 0.20)
    eh = int(ew * 0.52)
    for sx in (-1, 1):
        ex = cx + sx * int(fw * 0.21)
        ey = cy - int(fh * 0.10)
        d.ellipse([ex - ew // 2, ey - eh // 2, ex + ew // 2, ey + eh // 2], fill=(252, 252, 250))
        ir = int(eh * 0.86)
        d.ellipse([ex - ir // 2, ey - ir // 2, ex + ir // 2, ey + ir // 2], fill=(86, 66, 50))
        pr = int(ir * 0.5)
        d.ellipse([ex - pr // 2, ey - pr // 2, ex + pr // 2, ey + pr // 2], fill=(18, 16, 16))
        d.arc([ex - ew // 2, ey - eh // 2 - 2 * SS, ex + ew // 2, ey + eh // 2],
              200, 340, fill=(120, 96, 80), width=2 * SS)
        if brow:
            d.line([(ex - ew // 2, ey - eh - 3 * SS), (ex + ew // 2, ey - eh - 6 * SS)],
                   fill=(70, 54, 44), width=4 * SS)

    nx, ny = cx, cy + int(fh * 0.07)
    d.line([(nx, ny - int(fh * 0.08)), (nx - int(fw * 0.04), ny + int(fh * 0.05))],
           fill=(196, 158, 132), width=3 * SS)
    d.arc([nx - int(fw * 0.07), ny, nx + int(fw * 0.07), ny + int(fh * 0.07)],
          200, 340, fill=(180, 142, 118), width=3 * SS)

    my = cy + int(fh * 0.25)
    mw = int(fw * 0.28)
    if mouth_open:
        d.ellipse([cx - mw, my - int(mw * 0.35), cx + mw, my + int(mw * 0.45)], fill=(154, 78, 76))
        d.rectangle([cx - mw + 4 * SS, my - int(mw * 0.22), cx + mw - 4 * SS, my],
                    fill=(248, 246, 242))
    else:
        d.arc([cx - mw, my - int(mw * 0.6), cx + mw, my + int(mw * 0.6)],
              20, 160, fill=(150, 82, 78), width=4 * SS)

    im = im.resize((W, H), Image.LANCZOS)

    if shade:
        # Soft directional shading. Detectors trained on photographs lean on
        # this gradient, and a flat fill is noticeably harder to detect.
        a = np.asarray(im).astype(np.float32)
        gx = np.linspace(1.10, 0.86, W, dtype=np.float32)[None, :, None]
        gy = np.linspace(1.04, 0.92, H, dtype=np.float32)[:, None, None]
        im = Image.fromarray(np.clip(a * gx * gy, 0, 255).astype(np.uint8))
        im = im.filter(ImageFilter.GaussianBlur(0.6))

    return im


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-uri', action='store_true',
                    help='print a base64 data URI instead of writing a file')
    args = ap.parse_args()

    img = draw_face()
    if args.data_uri:
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        print('data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
    else:
        img.save('test-face.png')
        print('wrote test-face.png')
