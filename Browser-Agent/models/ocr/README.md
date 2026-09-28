# PP-OCR (PaddleOCR) models (vendored — enables OCR-confirmed ID-image redaction)

This replaced an earlier Tesseract.js-based version of this same feature. Tesseract.js was
dropped for accuracy reasons — it does noticeably worse than a trained detection+recognition
model on the small, dense text real ID cards have — and because it meant vendoring a second,
unrelated WASM OCR runtime alongside the ONNX Runtime Web this extension already ships (used
for face detection and NER). PP-OCR's official mobile models are purpose-built for exactly
this (line-level text detection + recognition) and run through that same `ort` runtime, so
there is only one inference engine in the whole extension, not two.

**OCR-confirmed ID-image redaction is live**: `offscreen.js`'s `runIdImageOcrBatch()` now runs
real detection + recognition instead of failing closed. The heuristic ID-image detection in
`content/idImageDetector.js` and the actual redaction in `content/redactor.js` were never
gated on this either way — every flagged region is still blacked out regardless of whether OCR
ran — this only upgrades the evidence from "looked like an ID card" to "confirmed: contains an
Aadhaar/PAN/MRZ/IBAN number."

## What was vendored, and from where

- `models/ocr/det.onnx` — `ch_PP-OCRv4_det_infer.onnx` (PP-OCRv4 mobile detection, DB /
  Differentiable Binarization), fetched from the `SWHL/RapidOCR` Hugging Face repo's
  `PP-OCRv4/` folder — a widely-used pre-converted-ONNX mirror of PaddleOCR's own published
  inference models (explicitly cited as the canonical source by other candidate ONNX-export
  repos that were checked and rejected — see below). Language-agnostic: detection only finds
  text regions, it doesn't read characters, so there's no dictionary to match here.
- `models/ocr/rec.onnx` — `en_PP-OCRv3_rec_infer.onnx` (PP-OCRv3 **English** recognition),
  also from `SWHL/RapidOCR`, `PP-OCRv3/` folder. Chosen specifically over a newer
  `en_PP-OCRv4_rec_infer.onnx` found in a different repo because its output class count
  matches this build's dictionary (see below) — using the English-specific model rather than
  the multilingual one keeps the model small and matches the Latin-alphabet/digit-only text
  this extension's ID-document detection targets (India Aadhaar/PAN, MRZ passport lines,
  IBAN).

A candidate recognition model from `xberg-io/paddleocr-onnx-models` (`v2/rec/en_mobile/`) was
fetched and rejected first: its `dict.txt` turned out to be a much larger extended-Unicode
dictionary (currency symbols, Greek letters, roman numerals, box-drawing characters, 300+
entries) that does not match this build's `EN_DICT`. That repo's own README only documents
three older files and is stale relative to its actual (larger) file tree — a real quality gap
on the third-party repo's side, not something to trust without checking. `SWHL/RapidOCR`, cited
as the original source of that repo's earlier matching models, was used instead.

You do **not** need a separate character dictionary file — `offscreen.js`'s `EN_DICT` constant
already has PaddleOCR's own `ppocr/utils/en_dict.txt` built in. This was verified, not assumed:
fetched PaddleOCR's actual upstream `en_dict.txt` from `PaddlePaddle/PaddleOCR` on GitHub and
diffed it byte-for-byte against `EN_DICT` — **identical**, no code change was needed. Separately,
`rec.onnx`'s real output shape was checked via `onnxruntime.InferenceSession` and its last
dimension is exactly `97`, matching `EN_DICT.length`.

## Real ONNX Runtime + full pipeline verification performed here

Structural check, via a real `onnxruntime.InferenceSession` for each file (not just assumed
from filenames):

- `det.onnx`: input `x` shape `[dynamic, 3, dynamic, dynamic]`, output `sigmoid_0.tmp_0` shape
  `[dynamic, 1, dynamic, dynamic]` (a per-pixel probability map) — a real forward pass with a
  dummy 1×3×64×64 input succeeded.
- `rec.onnx`: output `softmax_2.tmp_0` shape `[None, None, 97]` — a real forward pass with a
  dummy 1×3×48×160 input succeeded, producing softmax rows that sum to ~1.0.

**Full end-to-end pipeline verification** (this is what closes the gap the previous version of
this README flagged as untested — "implemented-but-unverified-end-to-end"): the real,
unmodified `offscreen.js` functions — `preprocessForDetection`, `dbPostProcess`,
`cropLineForRecognition`, `preprocessForRecognition`, `ctcGreedyDecode`, and the `EN_DICT`
table itself — were extracted verbatim and run in Node against these real vendored weights
(inference bridged to Python's real `onnxruntime`; a hand-built `OffscreenCanvas`/`getImageData`/
bilinear-`drawImage` polyfill stood in for the browser canvas API) on synthetic-but-realistic
rendered text images: a clean isolated text line, and a multi-line "ID card" layout. Results:

- Detection correctly localized every text line in both images.
- Recognition read one line with an exact character match, and the other lines correctly
  except for an O/0 (letter-O vs. digit-zero) confusion on the monospace test font used —
  a known, expected OCR ambiguity between visually near-identical glyphs, not a pipeline
  defect (the same ambiguity affects human readers of monospace fonts and most trained OCR
  models on this exact glyph pair).

What this verification could **not** cover: real photographed or scanned ID cards (these were
synthetic rendered images, not camera/scanner input with real-world noise, glare, or skew), and
actual browser WASM execution vs. this Python-`onnxruntime` check, or the real Chrome offscreen
document's behavior (see `docs/TESTING.md` — no real browser was available wherever this
vendoring pass itself was performed).

## Updating the vendored weights later

```bash
curl -sSL -o models/ocr/det.onnx \
  "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx"
curl -sSL -o models/ocr/rec.onnx \
  "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx"
```

If sourcing a different recognition model, re-check its real output class count against
`EN_DICT.length` (97) via `onnxruntime.InferenceSession` before swapping it in — decoding reads
the model's actual output class count at runtime and warns rather than silently producing wrong
text if it doesn't match, so a mismatch is loud, not silent, but it's still worth catching
before shipping.

## One disclosed simplification (unchanged by this vendoring pass)

Real PP-OCR extracts *rotated* minimum-area-rectangle text boxes; this implementation extracts
*axis-aligned* boxes from the same detection output (connected-component bounding boxes,
expanded outward using the same "unclip" distance formula PaddleOCR uses — mathematically exact
for an axis-aligned rectangle, not an approximation of it). This reads horizontal or
near-horizontal text lines well — the common case for a photographed or scanned ID card — but
will do worse than real PP-OCR on significantly rotated or skewed text. Upgrading to true
rotated-rectangle boxes (`minAreaRect` + a polygon-offset library) is a reasonable future
improvement, not required for this feature to work.

## Reload check

Reload the unpacked extension. Check the offscreen document's console (`chrome://extensions` →
this extension → "service worker" / inspect views → the offscreen document) for a successful
model load with no fetch error for either file — the next time an id-image region is detected
on a page, you should see OCR-confirmation results rather than the "OCR unavailable" warning.
