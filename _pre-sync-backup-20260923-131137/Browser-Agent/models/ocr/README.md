# Vendoring the PP-OCR (PaddleOCR) models (optional — enables OCR-confirmed ID-image redaction)

This replaced an earlier Tesseract.js-based version of this same feature. Tesseract.js was
dropped for accuracy reasons — it does noticeably worse than a trained detection+recognition
model on the small, dense text real ID cards have — and because it meant vendoring a second,
unrelated WASM OCR runtime alongside the ONNX Runtime Web this extension already ships (used
for face detection and NER). PP-OCR's official mobile models are purpose-built for exactly
this (line-level text detection + recognition) and run through that same `ort` runtime, so
there is only one inference engine in the whole extension, not two.

**This is a one-time manual step, and it's optional.** If you skip it, `offscreen.js`'s
`runIdImageOcrBatch()` fails closed exactly the way it's designed to (a missing model rejects
the session promise, which is caught and reported as `confirmedByOcr: false` per region,
never a crash). The heuristic ID-image detection in `content/idImageDetector.js` — and the
actual redaction of those regions in `content/redactor.js` — are both completely unaffected
either way: every flagged region is still blacked out regardless of whether OCR ran. OCR only
upgrades the evidence from "looked like an ID card" to "confirmed: contains an Aadhaar/PAN/
MRZ/IBAN number," it never gates the redaction itself.

## What this folder needs

Two ONNX model files, by these exact names (`offscreen.js`'s `OCR_DET_MODEL_URL` /
`OCR_REC_MODEL_URL` fetch them by path):

- `models/ocr/det.onnx` — a PP-OCR detection model (DB / Differentiable Binarization). Any
  PP-OCRv4 or PP-OCRv5 **mobile** detection model exported to ONNX works — these are small
  (a few MB) and this feature only ever runs on a small, already-cropped id-image region, not
  a full page, so the heavier "server" variants aren't worth the extra size.
- `models/ocr/rec.onnx` — a matching PP-OCR **English** recognition model (e.g.
  `en_PP-OCRv4_mobile_rec`), also exported to ONNX. Using the English-specific model rather
  than the multilingual one keeps the model small and matches the character dictionary this
  build ships with (see below) — this extension's ID-document text (India Aadhaar/PAN, MRZ
  passport lines, IBAN) is Latin-alphabet and digits only.

You do **not** need to vendor a character dictionary file separately — `offscreen.js`'s
`EN_DICT` constant already has PaddleOCR's own `ppocr/utils/en_dict.txt` (95 characters, in
its documented order) built in, verified against the `PaddlePaddle/PaddleOCR` GitHub repo.
If you use a recognition model trained against a *different* dictionary (a different
language, or a custom character set), replace `EN_DICT` in `offscreen.js` to match — decoding
reads the model's actual output class count at runtime and warns (rather than silently
producing wrong text) if it doesn't match `EN_DICT.length`, so a mismatch is loud, not silent.

## Steps

1. From a machine with normal network access (not inside this sandbox — see below), get
   PP-OCRv4 or v5 mobile detection + English recognition models already exported to ONNX.
   Two practical paths:
   - Search Hugging Face's model hub for a PaddleOCR-ONNX export (several exist under names
     like `paddleocr-onnx` or `OnnxOCR` — verify whichever you pick actually ships a
     **detection** model and an **English recognition** model, not just a combined/Chinese
     one) and download the `det.onnx` / `en_rec.onnx` (or similarly named) files.
   - Or export them yourself from the official PaddleOCR repo
     (`PaddlePaddle/PaddleOCR`) using `paddle2onnx`:
     ```bash
     pip install paddle2onnx paddlepaddle
     # Detection model
     paddle2onnx --model_dir ./ch_PP-OCRv4_det_infer \
       --model_filename inference.pdmodel --params_filename inference.pdiparams \
       --save_file det.onnx --opset_version 11
     # English recognition model
     paddle2onnx --model_dir ./en_PP-OCRv4_mobile_rec_infer \
       --model_filename inference.pdmodel --params_filename inference.pdiparams \
       --save_file rec.onnx --opset_version 11
     ```
     (Download the `*_infer` inference model directories from PaddleOCR's own published
     model zoo first — they're the frozen inference-format checkpoints paddle2onnx expects.)

2. Copy the two resulting files into this folder as `det.onnx` and `rec.onnx`.

3. Reload the unpacked extension. Check the offscreen document's console
   (`chrome://extensions` → this extension → "service worker" / inspect views → the offscreen
   document) for a successful model load with no fetch error for either file — the next time
   an id-image region is detected on a page, you should see OCR-confirmation results (or a
   clear warning if the recognition model's class count doesn't match `EN_DICT`, per above)
   rather than the "OCR unavailable" warning.

## What's implemented here already, and one disclosed simplification

Every part of the pipeline other than the two weight files is already written and will start
working the moment they're present: the exact pre/post-processing constants PaddleOCR's own
inference code uses (resize-to-multiple-of-32, ImageNet BGR normalization for detection,
`(x-0.5)/0.5` normalization for recognition, DB postprocessing's threshold/box-threshold/
unclip-ratio defaults, greedy CTC decoding), transcribed from PaddleOCR's published source,
not guessed — see the header comment above the OCR section in `offscreen.js` for the exact
source files cited.

One deliberate simplification, disclosed rather than silently shipped: real PP-OCR extracts
*rotated* minimum-area-rectangle text boxes; this implementation extracts *axis-aligned*
boxes from the same detection output (connected-component bounding boxes, then expanded
outward using the same "unclip" distance formula PaddleOCR uses — which is mathematically
exact for an axis-aligned rectangle, not an approximation of it). This means it reads
horizontal or near-horizontal text lines well — the common case for a photographed or
scanned ID card — but will do worse than real PP-OCR on significantly rotated or skewed
text. Upgrading to true rotated-rectangle boxes (`minAreaRect` + a polygon-offset library)
is a reasonable future improvement, not required for this feature to work.

## Why the model files can't be vendored automatically here

Same restriction documented in `lib/webllm/README.md` and (previously) `lib/tesseract/`'s
README: this sandbox's outbound network access does not reach Hugging Face's model hub,
`pip`'s package index, or GitHub raw file downloads at the scale a real model export needs.
Everything else — detection preprocessing, DB postprocessing (connected-component extraction,
scoring, unclip expansion), the recognition crop/resize/normalize pipeline, and greedy CTC
decoding against the built-in `EN_DICT` — is already written in `offscreen.js` and has not
been run against real model weights in this environment (no browser here either — see
`docs/TESTING.md`), only reasoned about against PaddleOCR's own published source. Treat it as
implemented-but-unverified-end-to-end until it's run in a real browser with the two files in
place.
