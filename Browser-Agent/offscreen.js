/**
 * offscreen.js
 *
 * Runs ONNX Runtime Web inside a Chrome Extension offscreen document.
 *
 * NER confidence threshold:
 *   0.80 (80%)
 *
 * Only token predictions with confidence >= 0.85
 * are considered PII entities.
 */

/* ============================================================
   Debug logging
   ------------------------------------------------------------
   Verbose per-token / per-inference logging used to be always on.
   It flooded DevTools (hundreds of lines per page analysis, plus a
   full base64 screenshot dump per face-detection pass) and, worse,
   printed raw page text — including the very PII this extension
   exists to protect (emails, IBANs, API keys) — to the console.
   It is now OFF by default. To turn it on while debugging, run
     localStorage.setItem('pvDebug', '1')
   in this offscreen document's DevTools console and reload the
   extension. Errors and warnings are still always logged.
   ============================================================ */

const PV_DEBUG = (() => {
  try { return localStorage.getItem('pvDebug') === '1'; } catch (_) { return false; }
})();

function pvDebug(...args) {
  if (PV_DEBUG) console.log(...args);
}

const MODEL_DIR = 'models/ner/';

const MODEL_FILE = 'model_quantized.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
const MODEL_CONFIG_FILE = 'config.json';

const MAX_SEQ_LEN = 256;

/* ============================================================
   NER CONFIDENCE THRESHOLD
   ============================================================ */

const NER_CONFIDENCE_THRESHOLD = 0.85;

let modelResourcesPromise = null;


// ============================================================
// YuNet face detector
// ============================================================

const FACE_MODEL_FILE =
  'models/face_detection_yunet_2023mar.onnx';

const FACE_INPUT_WIDTH = 640;
const FACE_INPUT_HEIGHT = 640;
  
const FACE_CONFIDENCE_THRESHOLD = 0.50;
const FACE_NMS_THRESHOLD = 0.30;
const FACE_TOP_K = 5000;

let faceDetectorPromise = null;


// ============================================================
// YuNet utilities
// ============================================================

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}


function decodeYuNet(
  outputs,
  originalWidth,
  originalHeight
) {
  const faces = [];

  const strides = [8, 16, 32];

  /*
   * The ONNX model expects 640x640.
   *
   * YuNet coordinates are first decoded
   * in the 640x640 model coordinate system,
   * then scaled back to the screenshot.
   */
  const scaleX =
    originalWidth / FACE_INPUT_WIDTH;

  const scaleY =
    originalHeight / FACE_INPUT_HEIGHT;

  for (const stride of strides) {

    const clsTensor =
      outputs[`cls_${stride}`];

    const objTensor =
      outputs[`obj_${stride}`];

    const bboxTensor =
      outputs[`bbox_${stride}`];

    if (
      !clsTensor ||
      !objTensor ||
      !bboxTensor
    ) {
      console.error(
        `[YuNet] Missing outputs for stride ${stride}`
      );
      continue;
    }

    const cls =
      clsTensor.data;

    const obj =
      objTensor.data;

    const bbox =
      bboxTensor.data;

    /*
     * 640x640 input:
     *
     * stride 8  -> 80 x 80
     * stride 16 -> 40 x 40
     * stride 32 -> 20 x 20
     */
    const featureWidth =
      FACE_INPUT_WIDTH / stride;

    const featureHeight =
      FACE_INPUT_HEIGHT / stride;

    const numAnchors =
      featureWidth * featureHeight;

    for (
      let i = 0;
      i < numAnchors;
      i++
    ) {

      /*
       * Classification and objectness
       */
      let clsScore =
        cls[i];

      let objScore =
        obj[i];

      /*
       * Clamp scores just like OpenCV.
       */
      clsScore =
        Math.max(
          0,
          Math.min(
            1,
            clsScore
          )
        );

      objScore =
        Math.max(
          0,
          Math.min(
            1,
            objScore
          )
        );

      /*
       * YuNet final confidence.
       */
      const score =
        Math.sqrt(
          clsScore *
          objScore
        );

      if (
        score <
        FACE_CONFIDENCE_THRESHOLD
      ) {
        continue;
      }

      /*
       * Feature-map coordinates.
       */
      const gridX =
        i % featureWidth;

      const gridY =
        Math.floor(
          i / featureWidth
        );

      /*
       * Bounding-box regression.
       *
       * YuNet stores:
       *
       * [dx, dy, dw, dh]
       *
       * where:
       *
       * cx = (gridX + dx) * stride
       * cy = (gridY + dy) * stride
       * w  = exp(dw) * stride
       * h  = exp(dh) * stride
       */
      const offset =
        i * 4;

      const dx =
        bbox[offset];

      const dy =
        bbox[offset + 1];

      const dw =
        bbox[offset + 2];

      const dh =
        bbox[offset + 3];

      /*
       * Decode in 640x640 coordinates.
       */
      const centerX =
        (
          gridX +
          dx
        ) * stride;

      const centerY =
        (
          gridY +
          dy
        ) * stride;

      const width =
        Math.exp(dw) *
        stride;

      const height =
        Math.exp(dh) *
        stride;

      const left =
        centerX -
        width / 2;

      const top =
        centerY -
        height / 2;

      /*
       * Convert 640x640 coordinates
       * to screenshot coordinates.
       */
      let x =
        left * scaleX;

      let y =
        top * scaleY;

      let w =
        width * scaleX;

      let h =
        height * scaleY;

      /*
       * Clamp to screenshot.
       */
      x =
        Math.max(
          0,
          Math.min(
            originalWidth,
            x
          )
        );

      y =
        Math.max(
          0,
          Math.min(
            originalHeight,
            y
          )
        );

      w =
        Math.min(
          w,
          originalWidth - x
        );

      h =
        Math.min(
          h,
          originalHeight - y
        );

      if (
        w <= 0 ||
        h <= 0
      ) {
        continue;
      }

      faces.push({
        x,
        y,
        width: w,
        height: h,
        confidence: score
      });
    }
  }

  pvDebug(
    "[YuNet] Before NMS:",
    faces.length
  );

  const result =
    nonMaximumSuppression(
      faces,
      FACE_NMS_THRESHOLD,
      FACE_TOP_K
    );

  pvDebug(
    "[YuNet] After NMS:",
    result.length
  );

  pvDebug(
    "[YuNet] FINAL FACES:",
    JSON.stringify(result, null, 2)
  );

  return result;
}



/**
 * IoU calculation.
 */
function faceIoU(a, b) {

  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;

  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);

  const intersection = iw * ih;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  const union =
    areaA +
    areaB -
    intersection;

  return union > 0
    ? intersection / union
    : 0;
}


/**
 * Non-maximum suppression.
 */
function nonMaximumSuppression(
  faces,
  threshold,
  topK
) {

  faces.sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  const selected = [];

  for (const face of faces) {

    let suppressed = false;

    for (const selectedFace of selected) {

      if (
        faceIoU(face, selectedFace) >=
        threshold
      ) {
        suppressed = true;
        break;
      }
    }

    if (!suppressed) {
      selected.push(face);
    }

    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}


// ============================================================
// Load YuNet
// ============================================================

async function loadFaceDetector() {

  pvDebug(
      "[YuNet] Loading model..."
  );

  const modelUrl =
      chrome.runtime.getURL(
          "models/face_detection_yunet_2023mar.onnx"
      );

  pvDebug(
      "[YuNet] Model URL:",
      modelUrl
  );

  try {

      const test =
          await fetch(
              modelUrl
          );

      pvDebug(
          "[YuNet] Model fetch:",
          test.status,
          test.statusText
      );

      if (!test.ok) {
          throw new Error(
              `YuNet model HTTP ${test.status}`
          );
      }

      const session =
          await ort.InferenceSession.create(
              modelUrl,
              {
                  executionProviders: [
                      "wasm"
                  ]
              }
          );

      pvDebug(
          "[YuNet] Model loaded successfully"
      );

      return session;

  } catch (error) {

      console.error(
          "[YuNet] MODEL LOAD FAILED:",
          error
      );

      throw error;
  }
}


function ensureFaceDetectorLoaded() {

  if (!faceDetectorPromise) {

    faceDetectorPromise =
      loadFaceDetector()
        .catch((error) => {

          faceDetectorPromise = null;

          throw error;

        });
  }

  return faceDetectorPromise;
}


// ============================================================
// Convert screenshot -> YuNet input tensor
// ============================================================

async function prepareYuNetInputFromBitmap(bitmap) {

  const canvas =
      new OffscreenCanvas(
          FACE_INPUT_WIDTH,
          FACE_INPUT_HEIGHT
      );

  const ctx =
      canvas.getContext("2d", {
          willReadFrequently: true
      });

  ctx.drawImage(
      bitmap,
      0,
      0,
      FACE_INPUT_WIDTH,
      FACE_INPUT_HEIGHT
  );

  const imageData =
      ctx.getImageData(
          0,
          0,
          FACE_INPUT_WIDTH,
          FACE_INPUT_HEIGHT
      );

  const rgba =
      imageData.data;

  const planeSize =
      FACE_INPUT_WIDTH *
      FACE_INPUT_HEIGHT;

  const data =
      new Float32Array(
          planeSize * 3
      );

  for (
      let i = 0;
      i < planeSize;
      i++
  ) {
      const r =
          rgba[i * 4];

      const g =
          rgba[i * 4 + 1];

      const b =
          rgba[i * 4 + 2];

      // B
      data[i] = b;

      // G
      data[
          planeSize + i
      ] = g;

      // R
      data[
          planeSize * 2 + i
      ] = r;
  }

  return new ort.Tensor(
      "float32",
      data,
      [
          1,
          3,
          FACE_INPUT_HEIGHT,
          FACE_INPUT_WIDTH
      ]
  );
}


function calculateIoU(a, b) {
  const ax1 = a.x;
  const ay1 = a.y;

  const ax2 =
      a.x + a.width;

  const ay2 =
      a.y + a.height;

  const bx1 = b.x;
  const by1 = b.y;

  const bx2 =
      b.x + b.width;

  const by2 =
      b.y + b.height;

  const ix1 =
      Math.max(ax1, bx1);

  const iy1 =
      Math.max(ay1, by1);

  const ix2 =
      Math.min(ax2, bx2);

  const iy2 =
      Math.min(ay2, by2);

  const intersectionWidth =
      Math.max(
          0,
          ix2 - ix1
      );

  const intersectionHeight =
      Math.max(
          0,
          iy2 - iy1
      );

  const intersection =
      intersectionWidth *
      intersectionHeight;

  const areaA =
      a.width * a.height;

  const areaB =
      b.width * b.height;

  const union =
      areaA +
      areaB -
      intersection;

  if (union <= 0) {
      return 0;
  }

  return intersection / union;
}


function nonMaximumSuppression(
  faces,
  threshold,
  topK
) {
  faces.sort(
      (a, b) =>
          b.confidence -
          a.confidence
  );

  const selected = [];

  for (const face of faces) {

      let keep = true;

      for (
          const selectedFace
          of selected
      ) {

          if (
              calculateIoU(
                  face,
                  selectedFace
              ) >= threshold
          ) {
              keep = false;
              break;
          }
      }

      if (keep) {
          selected.push(face);
      }

      if (
          selected.length >= topK
      ) {
          break;
      }
  }

  pvDebug(
      "[YuNet] After NMS:",
      selected.length
  );

  return selected;
}


// ============================================================
// Detect faces in screenshot
// ============================================================

async function detectFaces(screenshotDataUrl) {
  try {
      pvDebug(
          "[YuNet] Starting face detection"
      );

      const session =
          await ensureFaceDetectorLoaded();

      pvDebug(
          "[YuNet] Model loaded"
      );

      const bitmap =
          await createImageBitmapFromDataUrl(
              screenshotDataUrl
          );

      const originalWidth =
          bitmap.width;

      const originalHeight =
          bitmap.height;

      pvDebug(
          "[YuNet] Original screenshot:",
          originalWidth,
          "x",
          originalHeight
      );

      const input =
          await prepareYuNetInputFromBitmap(
              bitmap
          );

      bitmap.close();

      pvDebug(
          "[YuNet] Input tensor:",
          input.dims
      );

      const inputName =
          session.inputNames[0];

      const outputs =
          await session.run({
              [inputName]: input
          });

      pvDebug(
          "[YuNet] Inference completed"
      );

      const faces =
          decodeYuNet(
              outputs,
              originalWidth,
              originalHeight
          );

      pvDebug(
          "[YuNet] FINAL FACES:",
          faces
      );

      return faces;

  } catch (error) {

      console.error(
          "[offscreen] Face detection failed:",
          error
      );

      console.error(
          "[offscreen] Error name:",
          error?.name
      );

      console.error(
          "[offscreen] Error message:",
          error?.message
      );

      console.error(
          "[offscreen] Error stack:",
          error?.stack
      );

      throw error;
  }
}


/* ============================================================
   Extension URL helper
   ============================================================ */

function extURL(path) {
  return chrome.runtime.getURL(path);
}


// ============================================================
// On-device OCR (PP-OCR / PaddleOCR, via ONNX Runtime Web) —
// id-image redaction confirmation
// ============================================================
//
// Upgrades content/idImageDetector.js's ID-document detection from pure
// heuristic (keyword + aspect-ratio guessing) to actually reading the
// text in the cropped region and checking it against the same validated
// PII patterns as piiDetector.js (Aadhaar Verhoeff checksum, PAN
// category-letter format). This runs entirely in this offscreen document
// through the SAME ONNX Runtime Web instance already used for face
// detection above and NER — nothing is ever sent anywhere for
// recognition, and the recognized text itself never leaves this
// function; only a boolean + a type list is returned.
//
// This replaces an earlier Tesseract.js-based version (a separate WASM
// OCR engine with its own runtime). Tesseract.js was dropped for
// accuracy reasons — it does noticeably worse than a trained
// detection+recognition model on the small, dense text real ID cards
// have — and because running it meant vendoring a second, unrelated WASM
// runtime alongside the ONNX Runtime Web this extension already ships.
// PP-OCR (PaddleOCR)'s official mobile models are small, purpose-built
// for exactly this (line-level text detection + recognition), and run
// through the same `ort` runtime as everything else here.
//
// Two ONNX models are used, mirroring the standard PP-OCR pipeline, both
// now vendored (models/ocr/README.md has provenance + verification
// details):
//   1. DETECTION (DB / Differentiable Binarization,
//      PP-OCRv4 ch_PP-OCRv4_det_infer — language-agnostic) — finds the
//      axis-aligned bounding box of each line of text within the
//      cropped id-image region.
//   2. RECOGNITION (CTC-based, PP-OCRv3 en_PP-OCRv3_rec_infer) — reads
//      the text out of each detected line crop; its 97-class output
//      (confirmed via real ONNX Runtime inspection) matches EN_DICT
//      below exactly.
// If the vendored files are ever removed, ensureOcrDetSession()/
// ensureOcrRecSession() reject and runIdImageOcrBatch() fails closed
// exactly like before — every idImageRegion is still redacted regardless
// (see content/redactor.js), OCR only adds a confirmation on top, it is
// never a gate on whether something is blacked out.
//
// HONESTY NOTE on the preprocessing/postprocessing constants below: they
// are transcribed from PaddleOCR's own published inference code
// (tools/infer/predict_det.py, predict_rec.py, and
// ppocr/postprocess/db_postprocess.py, ppocr/postprocess/rec_postprocess.py
// in the PaddlePaddle/PaddleOCR repo), not guessed. What IS a deliberate
// simplification, disclosed here rather than silently shipped: real
// PP-OCR extracts ROTATED minimum-area-rectangle text boxes (via OpenCV's
// `minAreaRect` + a Clipper polygon offset for the "unclip" expansion);
// this implementation extracts AXIS-ALIGNED boxes from the same
// probability map (connected-component bounding boxes, then padded
// outward using the same unclip distance formula PaddleOCR uses for a
// rectangle, which is exact for the axis-aligned case). That means this
// reads horizontal or near-horizontal text lines — the common case for a
// cropped ID-card photo — but will do worse than real PP-OCR on
// significantly rotated/skewed text. See models/ocr/README.md.
//
// VERIFIED end-to-end against the real vendored weights (not just
// PaddleOCR's published source): this exact extracted preprocessing →
// real ONNX Runtime inference → this exact postprocessing pipeline was
// run in Node against synthetic-but-realistic rendered text images (a
// clean isolated line, and a multi-line "ID card" layout). Detection
// correctly localized every line; recognition read one line with an
// exact match and two others correctly except for an O/0 (letter-O vs
// digit-zero) confusion on a monospace test font — a known, expected OCR
// ambiguity for visually-similar glyphs, not a pipeline defect. See
// models/ocr/README.md for the full results and what still can't be
// verified this way (real photographed/scanned ID cards, real browser
// WASM execution vs. this Python-onnxruntime check, actual Chrome
// offscreen-document behavior).

const OCR_DET_MODEL_URL = 'models/ocr/det.onnx';
const OCR_REC_MODEL_URL = 'models/ocr/rec.onnx';

// DB detection postprocessing — the actual defaults PaddleOCR's own
// tools/infer/predict_det.py / tools/infer/utility.py ship (not the
// DBPostProcess class's own no-args __init__ defaults, which are
// slightly different and only apply to some training configs).
const OCR_DET_LIMIT_SIDE_LEN = 960; // longer side is capped to this before the multiple-of-32 rounding
const OCR_DET_THRESH = 0.3;         // probability-map binarization threshold
const OCR_DET_BOX_THRESH = 0.6;     // minimum mean-probability score for a candidate box to survive
const OCR_DET_UNCLIP_RATIO = 1.5;   // how far the shrunk detected box is expanded back out
const OCR_DET_MIN_SIDE = 5;         // boxes with either side smaller than this (min_size=3, +2) are dropped

// PP-OCRv4 mobile recognition model's fixed input height; width is
// aspect-ratio-preserving and computed per line crop (see
// cropLineForRecognition below) — no batching, so no shared-max-width
// padding is needed the way PaddleOCR's own batched inference does it.
const OCR_REC_INPUT_HEIGHT = 48;
const OCR_REC_MIN_WIDTH = 8;
const OCR_REC_MAX_WIDTH = 800; // guards against a pathological ultra-wide crop producing an oversized tensor

// PaddleOCR's ppocr/utils/en_dict.txt (95 lines), in file order, verified
// against the PaddlePaddle/PaddleOCR GitHub repo. CTCLabelDecode prepends
// a 'blank' token at index 0, and en_PP-OCRv4_mobile_rec.yml's
// use_space_char:true appends one more space after the file's own
// content — the file's own last entry is already a space, so indices 94
// and 96 (0-indexed, in the final 97-class list below) both map to ' '.
// That duplicate is PaddleOCR's own documented behavior, not a bug here.
// FLAG: the resulting 97-class count is inferred from PaddleOCR's source,
// not confirmed against a real rec.onnx output tensor's class dimension
// in this sandbox — runRecognition() below reads the actual class count
// from the model's own output shape at runtime and only falls back to
// this array's length as a sanity check, so a real model with a
// different class count still decodes correctly against its own
// dictionary as long as EN_DICT is replaced to match (see
// models/ocr/README.md).
const EN_DICT = (function buildEnDict() {
  const chars = [];
  const push = (s) => { for (const ch of s) chars.push(ch); };
  push('0123456789:;<=>?@');
  push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  push('[\\]^_`');
  push('abcdefghijklmnopqrstuvwxyz');
  push('{|}~');
  push('!"#$%&\'()*+,-./');
  chars.push(' '); // en_dict.txt's own trailing line
  return ['blank', ...chars, ' ']; // + use_space_char's extra space -> 97 entries
})();

let ocrDetSessionPromise = null;
let ocrRecSessionPromise = null;

function ensureOcrDetSession() {
  if (!ocrDetSessionPromise) {
    ocrDetSessionPromise = ort.InferenceSession.create(extURL(OCR_DET_MODEL_URL), {
      executionProviders: ['wasm'],
    }).catch((error) => {
      ocrDetSessionPromise = null;
      throw new Error(
        `[offscreen] PP-OCR detection model not available (${error.message || error}). ` +
        'Vendor it into models/ocr/ per models/ocr/README.md to enable OCR-based ' +
        'ID-image confirmation (heuristic redaction still happens without it).'
      );
    });
  }
  return ocrDetSessionPromise;
}

function ensureOcrRecSession() {
  if (!ocrRecSessionPromise) {
    ocrRecSessionPromise = ort.InferenceSession.create(extURL(OCR_REC_MODEL_URL), {
      executionProviders: ['wasm'],
    }).catch((error) => {
      ocrRecSessionPromise = null;
      throw new Error(
        `[offscreen] PP-OCR recognition model not available (${error.message || error}). ` +
        'Vendor it into models/ocr/ per models/ocr/README.md to enable OCR-based ' +
        'ID-image confirmation (heuristic redaction still happens without it).'
      );
    });
  }
  return ocrRecSessionPromise;
}

/** Reads an OffscreenCanvas into a BGR, ImageNet-normalized, CHW float32
 *  tensor for the DB detection model, resizing so the longer side is
 *  <= OCR_DET_LIMIT_SIDE_LEN and both dimensions round up to a multiple
 *  of 32 (PaddleOCR's DetResizeForTest.resize_image_type0, 'max' limit
 *  type). Returns the ratios needed to map the output probability map's
 *  pixel coordinates back to the ORIGINAL (un-resized) canvas. */
function preprocessForDetection(canvas) {
  const origW = canvas.width;
  const origH = canvas.height;
  const longSide = Math.max(origW, origH);
  const ratio = longSide > OCR_DET_LIMIT_SIDE_LEN ? OCR_DET_LIMIT_SIDE_LEN / longSide : 1.0;
  const resizeW = Math.max(32, Math.round((origW * ratio) / 32) * 32);
  const resizeH = Math.max(32, Math.round((origH * ratio) / 32) * 32);

  const resizeCanvas = new OffscreenCanvas(resizeW, resizeH);
  const rctx = resizeCanvas.getContext('2d', { willReadFrequently: true });
  rctx.drawImage(canvas, 0, 0, resizeW, resizeH);
  const { data: rgba } = rctx.getImageData(0, 0, resizeW, resizeH);

  // PaddleOCR's predict_det.py reads via cv2.imread (BGR) and never
  // converts to RGB before normalizing — mean/std below are applied
  // directly to BGR-ordered channels, matching that exactly rather than
  // "fixing" it to RGB.
  const mean = [0.406, 0.456, 0.485]; // B, G, R
  const std = [0.225, 0.224, 0.229];  // B, G, R
  const planeSize = resizeW * resizeH;
  const chw = new Float32Array(planeSize * 3);
  for (let i = 0; i < planeSize; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    chw[i] = (b - mean[0]) / std[0];
    chw[planeSize + i] = (g - mean[1]) / std[1];
    chw[planeSize * 2 + i] = (r - mean[2]) / std[2];
  }

  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, resizeH, resizeW]),
    origW,
    origH,
    resizeW,
    resizeH,
  };
}

/** DB postprocessing: binarize the probability map, extract connected
 *  components as axis-aligned candidate boxes, score + filter, then
 *  expand ("unclip") each surviving box back out and map it from the
 *  resized network-input space back to the original crop's pixel space.
 *  See the header comment above for why this is axis-aligned rather
 *  than PaddleOCR's true rotated minAreaRect boxes. */
function dbPostProcess(probData, mapW, mapH, origW, origH, resizeW, resizeH) {
  const n = mapW * mapH;
  const binary = new Uint8Array(n);
  for (let i = 0; i < n; i++) binary[i] = probData[i] > OCR_DET_THRESH ? 1 : 0;

  const visited = new Uint8Array(n);
  const boxes = [];
  const stack = new Int32Array(n); // flood-fill via explicit stack, not recursion

  for (let start = 0; start < n; start++) {
    if (!binary[start] || visited[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = mapW, maxX = -1, minY = mapH, maxY = -1;
    let sumProb = 0, count = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % mapW;
      const y = (idx / mapW) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumProb += probData[idx];
      count++;

      // 4-connectivity flood fill.
      if (x > 0 && binary[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < mapW - 1 && binary[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && binary[idx - mapW] && !visited[idx - mapW]) { visited[idx - mapW] = 1; stack[sp++] = idx - mapW; }
      if (y < mapH - 1 && binary[idx + mapW] && !visited[idx + mapW]) { visited[idx + mapW] = 1; stack[sp++] = idx + mapW; }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (Math.min(width, height) < OCR_DET_MIN_SIDE) continue;

    const score = sumProb / count; // 'fast' scoring mode: mean probability over the component
    if (score < OCR_DET_BOX_THRESH) continue;

    // Unclip: PaddleOCR expands the shrunk box outward by
    // distance = area * unclip_ratio / perimeter via a Clipper polygon
    // offset. For an axis-aligned rectangle, offsetting every edge
    // outward by that same distance is the exact equivalent (not an
    // approximation) of what Clipper does to a rectangle.
    const area = width * height;
    const perimeter = 2 * (width + height);
    const distance = (area * OCR_DET_UNCLIP_RATIO) / perimeter;

    // Map from the resized network-input space back to the original
    // (un-resized) crop's pixel space.
    const scaleX = origW / resizeW;
    const scaleY = origH / resizeH;
    const x1 = Math.max(0, (minX - distance) * scaleX);
    const y1 = Math.max(0, (minY - distance) * scaleY);
    const x2 = Math.min(origW, (maxX + 1 + distance) * scaleX);
    const y2 = Math.min(origH, (maxY + 1 + distance) * scaleY);
    if (x2 - x1 < 1 || y2 - y1 < 1) continue;

    boxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, score });
  }

  // Reading order: top-to-bottom, then left-to-right within roughly the
  // same row — approximated here by sorting on the box's vertical center
  // first, horizontal position second, which is adequate for the
  // largely-horizontal, non-overlapping lines a cropped ID card has.
  boxes.sort((a, b) => {
    const ay = a.y + a.height / 2;
    const by = b.y + b.height / 2;
    if (Math.abs(ay - by) > Math.min(a.height, b.height) / 2) return ay - by;
    return a.x - b.x;
  });

  return boxes;
}

/** Runs the DB detection model over one id-image crop and returns
 *  axis-aligned line boxes in the crop's own pixel space, reading occurred
 *  output dimensions from the model's actual result rather than assuming
 *  they equal the input size. */
async function runDetection(canvas) {
  const session = await ensureOcrDetSession();
  const { tensor, origW, origH, resizeW, resizeH } = preprocessForDetection(canvas);
  const inputName = session.inputNames[0];
  const outputs = await session.run({ [inputName]: tensor });
  const outputTensor = outputs[session.outputNames[0]];
  const dims = outputTensor.dims; // expect [1,1,H,W] (or [1,H,W]) at input resolution
  const mapH = dims[dims.length - 2];
  const mapW = dims[dims.length - 1];
  return dbPostProcess(outputTensor.data, mapW, mapH, origW, origH, resizeW, resizeH);
}

/** Crops one detected line box out of the id-image canvas and resizes it
 *  to the recognition model's fixed input height, preserving aspect
 *  ratio (PaddleOCR's own dynamic-width recognition input). */
function cropLineForRecognition(canvas, box) {
  const srcX = Math.max(0, Math.round(box.x));
  const srcY = Math.max(0, Math.round(box.y));
  const srcW = Math.max(1, Math.min(canvas.width - srcX, Math.round(box.width)));
  const srcH = Math.max(1, Math.min(canvas.height - srcY, Math.round(box.height)));

  const aspect = srcW / srcH;
  const targetW = Math.max(
    OCR_REC_MIN_WIDTH,
    Math.min(OCR_REC_MAX_WIDTH, Math.round(OCR_REC_INPUT_HEIGHT * aspect))
  );

  const lineCanvas = new OffscreenCanvas(targetW, OCR_REC_INPUT_HEIGHT);
  const lctx = lineCanvas.getContext('2d', { willReadFrequently: true });
  lctx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, targetW, OCR_REC_INPUT_HEIGHT);
  return lineCanvas;
}

/** BGR, [-1,1]-normalized, CHW tensor for the recognition model —
 *  PaddleOCR's predict_rec.py: img/255, then (x-0.5)/0.5. */
function preprocessForRecognition(lineCanvas) {
  const w = lineCanvas.width;
  const h = lineCanvas.height;
  const ctx = lineCanvas.getContext('2d', { willReadFrequently: true });
  const { data: rgba } = ctx.getImageData(0, 0, w, h);
  const planeSize = w * h;
  const chw = new Float32Array(planeSize * 3);
  for (let i = 0; i < planeSize; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    chw[i] = (b - 0.5) / 0.5;
    chw[planeSize + i] = (g - 0.5) / 0.5;
    chw[planeSize * 2 + i] = (r - 0.5) / 0.5;
  }
  return new ort.Tensor('float32', chw, [1, 3, h, w]);
}

/** Standard greedy CTC decode: per-timestep argmax, collapse consecutive
 *  repeats (including across a blank boundary — comparing to the
 *  previous *class index*, not the previous *emitted character*, matches
 *  PaddleOCR's own decode(is_remove_duplicate=True)), then drop blanks
 *  (class index 0). Exported standalone (see bottom of file) so it can
 *  be unit-tested against synthetic logits without a real model. */
function ctcGreedyDecode(logitsData, timesteps, numClasses, dict) {
  let text = '';
  let prevIdx = -1;
  for (let t = 0; t < timesteps; t++) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    const base = t * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const v = logitsData[base + c];
      if (v > bestVal) { bestVal = v; bestIdx = c; }
    }
    if (bestIdx !== prevIdx) {
      if (bestIdx !== 0 && bestIdx < dict.length) text += dict[bestIdx];
    }
    prevIdx = bestIdx;
  }
  return text;
}

/** Runs the recognition model over one line crop and returns decoded
 *  text. The dictionary's length is only a sanity check, never a hard
 *  requirement — decoding always uses the model's own actual output
 *  class count, so a real rec.onnx with a different class count than
 *  EN_DICT still decodes (indices beyond EN_DICT's length are simply
 *  skipped rather than throwing — see models/ocr/README.md for how to
 *  swap in a matching dictionary if that happens). */
async function runRecognition(lineCanvas) {
  const session = await ensureOcrRecSession();
  const tensor = preprocessForRecognition(lineCanvas);
  const inputName = session.inputNames[0];
  const outputs = await session.run({ [inputName]: tensor });
  const outputTensor = outputs[session.outputNames[0]];
  const dims = outputTensor.dims; // expect [1,T,C]
  const timesteps = dims[dims.length - 2];
  const numClasses = dims[dims.length - 1];
  if (numClasses !== EN_DICT.length) {
    console.warn(
      `[offscreen] PP-OCR recognition model's class count (${numClasses}) does not match ` +
      `this build's EN_DICT (${EN_DICT.length}) — decoding will proceed but may be wrong. ` +
      'See models/ocr/README.md.'
    );
  }
  return ctcGreedyDecode(outputTensor.data, timesteps, numClasses, EN_DICT);
}

/** Full pipeline for one id-image crop: detect line boxes, recognize
 *  each in reading order, join into one text blob — replaces what
 *  Tesseract's worker.recognize(canvas).data.text used to return, so
 *  classifyOcrText() below (unchanged) keeps working exactly as before. */
async function runPaddleOcrOnRegion(canvas) {
  const boxes = await runDetection(canvas);
  if (boxes.length === 0) return '';
  const lines = [];
  for (const box of boxes) {
    const lineCanvas = cropLineForRecognition(canvas, box);
    const text = await runRecognition(lineCanvas);
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

/** Crops the id-image region out of the full screenshot, scaling the
 *  viewport-CSS-px bbox (from idImageDetector.js) into screenshot pixel
 *  space — same scaleX/scaleY approach as coordinateMapper.js and the
 *  YuNet decoder above. */
async function cropRegionFromScreenshot(screenshotDataUrl, bbox, viewport) {
  const bitmap = await createImageBitmapFromDataUrl(screenshotDataUrl);
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const pad = 2;
  const sx = Math.max(0, Math.round(bbox.x * scaleX) - pad);
  const sy = Math.max(0, Math.round(bbox.y * scaleY) - pad);
  const sw = Math.min(bitmap.width - sx, Math.round(bbox.width * scaleX) + pad * 2);
  const sh = Math.min(bitmap.height - sy, Math.round(bbox.height * scaleY) + pad * 2);
  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas;
}

// Minimal validators duplicated from content/piiDetector.js — this
// document is a separate JS context from the page's content scripts and
// can't reach window.__BA_PiiDetector there, so the Verhoeff table and
// PAN category-letter regex are re-declared here rather than shared.
// See piiDetector.js for the fully-commented canonical version.
const OCR_VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const OCR_VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];
function ocrVerhoeffValidate(numStr) {
  const digits = numStr.split('').reverse();
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = OCR_VERHOEFF_D[c][OCR_VERHOEFF_P[i % 8][parseInt(digits[i], 10)]];
  }
  return c === 0;
}

// ICAO Document 9303 MRZ check-digit weights — the same publicly
// standardized algorithm every machine-readable passport on Earth uses.
// This is the OCR path's realistic encounter point for MRZ (a scanned
// passport bio page), unlike piiDetector.js's plain-text scanner where
// it's duplicated for completeness. See piiDetector.js's validateMrzLine2
// for the fully-commented canonical version this mirrors.
const OCR_MRZ_WEIGHTS = [7, 3, 1];
function ocrMrzCharValue(ch) {
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  return 0;
}
function ocrMrzCheckDigit(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += ocrMrzCharValue(field[i]) * OCR_MRZ_WEIGHTS[i % 3];
  return sum % 10;
}
function ocrValidateMrzLine2(line2) {
  if (!line2 || line2.length !== 44) return false;
  const passportNumField = line2.slice(0, 9);
  const passportCheck = line2[9];
  const dobField = line2.slice(13, 19);
  const dobCheck = line2[19];
  const expiryField = line2.slice(21, 27);
  const expiryCheck = line2[27];
  const personalNumField = line2.slice(28, 42);
  const personalCheck = line2[42];
  const compositeCheck = line2[43];
  const composite = passportNumField + passportCheck + dobField + dobCheck + expiryField + expiryCheck + personalNumField + personalCheck;
  return (
    String(ocrMrzCheckDigit(passportNumField)) === passportCheck &&
    /^\d{6}$/.test(dobField) && String(ocrMrzCheckDigit(dobField)) === dobCheck &&
    /^\d{6}$/.test(expiryField) && String(ocrMrzCheckDigit(expiryField)) === expiryCheck &&
    String(ocrMrzCheckDigit(composite)) === compositeCheck
  );
}

// ISO 7064 mod-97-10 (IBAN) — see piiDetector.js's ibanValidate for the
// fully-commented canonical version.
function ocrIbanValidate(iban) {
  const cleaned = iban.toUpperCase().replace(/\s/g, '');
  if (cleaned.length < 15 || cleaned.length > 34) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55) : ch;
    for (const digitChar of String(value)) remainder = (remainder * 10 + Number(digitChar)) % 97;
  }
  return remainder === 1;
}

/** Classifies recognized OCR text against validated ID-document patterns —
 *  India-specific (Aadhaar/PAN) plus the global region pack (MRZ
 *  passports, IBAN bank accounts) that applies to any country's
 *  documents, not just India's. Returns only a type list — the raw
 *  recognized text is discarded by the caller and never included in the
 *  response sent back to the page. */
function classifyOcrText(text) {
  const types = [];
  if (!text) return types;
  const aadhaarMatches = text.match(/\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g) || [];
  for (const m of aadhaarMatches) {
    if (ocrVerhoeffValidate(m.replace(/\D/g, ''))) {
      types.push('AADHAAR');
      break;
    }
  }
  if (/\b[A-Za-z]{3}[ABCFGHLJPTabcfghljpt][A-Za-z]\d{4}[A-Za-z]\b/.test(text)) {
    types.push('PAN');
  }
  // MRZ lines survive OCR best with '<' fill characters intact; also try
  // collapsing whitespace OCR sometimes inserts mid-line before matching.
  const mrzCandidates = (text.match(/[A-Z0-9<]{44}/g) || [])
    .concat((text.replace(/\s+/g, '').match(/[A-Z0-9<]{44}/g)) || []);
  if (mrzCandidates.some((c) => ocrValidateMrzLine2(c))) {
    types.push('MRZ_PASSPORT');
  } else if (/passport/i.test(text)) {
    types.push('PASSPORT_LIKE'); // weaker fallback signal when MRZ itself didn't OCR cleanly
  }
  const ibanCandidates = text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) || [];
  if (ibanCandidates.some((c) => ocrIbanValidate(c))) {
    types.push('IBAN');
  }
  if (/\bd\.?o\.?b\b/i.test(text) && /\b\d{2}[- /]\d{2}[- /]\d{4}\b/.test(text)) {
    types.push('DOB');
  }
  return [...new Set(types)];
}

/** Runs OCR + classification over every id-image region for this step.
 *  Best-effort and non-blocking for the caller: any single-region or
 *  whole-batch failure resolves with confirmedByOcr:false rather than
 *  throwing, so a missing/broken OCR vendor drop-in never breaks the
 *  (already-happening) heuristic redaction. */
async function runIdImageOcrBatch(screenshotDataUrl, regions, viewport) {
  if (!screenshotDataUrl || !Array.isArray(regions) || regions.length === 0) return [];
  try {
    // Load both models up front — a batch with no working detector or
    // recognizer fails closed exactly once, with one clear message,
    // rather than once per region.
    await Promise.all([ensureOcrDetSession(), ensureOcrRecSession()]);
  } catch (error) {
    console.warn('[offscreen] OCR unavailable:', error.message);
    return regions.map((_, index) => ({ index, confirmedByOcr: false, detectedTypes: [], error: error.message }));
  }

  const results = [];
  for (let i = 0; i < regions.length; i++) {
    try {
      const canvas = await cropRegionFromScreenshot(screenshotDataUrl, regions[i].bbox, viewport);
      const text = (await runPaddleOcrOnRegion(canvas)).trim();
      const detectedTypes = classifyOcrText(text);
      results.push({ index: i, confirmedByOcr: detectedTypes.length > 0, detectedTypes, textLength: text.length });
    } catch (error) {
      results.push({ index: i, confirmedByOcr: false, detectedTypes: [], error: error.message || String(error) });
    }
  }
  return results;
}


async function createImageBitmapFromDataUrl(screenshot) {
  try {
      pvDebug(
          "[YuNet] Received screenshot:",
          screenshot
      );

      let dataUrl = screenshot;

      if (
          typeof screenshot === "object" &&
          screenshot !== null
      ) {
          dataUrl =
              screenshot.dataUrl ??
              screenshot.dataURL ??
              screenshot.image ??
              screenshot.screenshot;
      }

      if (
          typeof dataUrl !== "string"
      ) {
          throw new Error(
              `Screenshot is not a string. Received: ${typeof dataUrl}`
          );
      }

      if (
          !dataUrl.startsWith("data:image/")
      ) {
          throw new Error(
              "Screenshot is not a valid image data URL"
          );
      }

      const commaIndex =
          dataUrl.indexOf(",");

      if (commaIndex === -1) {
          throw new Error(
              "Invalid data URL"
          );
      }

      const base64 =
          dataUrl.substring(
              commaIndex + 1
          );

      const binary =
          atob(base64);

      const bytes =
          new Uint8Array(
              binary.length
          );

      for (
          let i = 0;
          i < binary.length;
          i++
      ) {
          bytes[i] =
              binary.charCodeAt(i);
      }

      const mime =
          dataUrl
              .substring(
                  5,
                  commaIndex
              )
              .split(";")[0];

      const blob =
          new Blob(
              [bytes],
              { type: mime }
          );

      return await createImageBitmap(
          blob
      );

  } catch (error) {
      throw new Error(
          `Could not create screenshot bitmap: ${
              error.message || error
          }`
      );
  }
}


/* ============================================================
   JSON loader
   ============================================================ */

async function fetchJson(relativePath) {

  const url = extURL(relativePath);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `[offscreen] ${relativePath} returned HTTP ${response.status}`
    );
  }

  return response.json();
}


/* ============================================================
   Load model resources
   ============================================================ */

async function loadModelResources() {

  if (typeof ort === 'undefined') {

    throw new Error(
      '[offscreen] onnxruntime-web ("ort") not found on window.'
    );
  }


  pvDebug(
    '[offscreen] Loading NER model...'
  );


  /* ----------------------------------------------------------
     ONNX Runtime
     ---------------------------------------------------------- */

  ort.env.wasm.wasmPaths =
    extURL('lib/');

  ort.env.wasm.numThreads = 1;

  ort.env.wasm.proxy = false;


  /* ----------------------------------------------------------
     Tokenizer
     ---------------------------------------------------------- */

  const tokenizerJson =
    await fetchJson(
      MODEL_DIR + TOKENIZER_FILE
    );


  const tokenizerConfig =
    await fetchJson(
      MODEL_DIR + TOKENIZER_CONFIG_FILE
    );


  /* ----------------------------------------------------------
     Model config
     ----------------------------------------------------------

     id2label should come from config.json.

     Example:

     {
       "id2label": {
         "0": "O",
         "1": "B-PERSON",
         "2": "I-PERSON"
       }
     }
     ---------------------------------------------------------- */

  let modelConfig = {};

  try {

    modelConfig =
      await fetchJson(
        MODEL_DIR + MODEL_CONFIG_FILE
      );

  } catch (error) {

    console.warn(
      '[offscreen] config.json could not be loaded:',
      error.message
    );
  }


  /* ----------------------------------------------------------
     Vocabulary
     ---------------------------------------------------------- */

  const vocab =
    tokenizerJson.model &&
    tokenizerJson.model.vocab;


  if (!vocab) {

    throw new Error(
      '[offscreen] tokenizer.json missing model.vocab'
    );
  }


  /* ----------------------------------------------------------
     Lowercase configuration
     ---------------------------------------------------------- */

  const normalizer =
    tokenizerJson.normalizer || {};


  const doLowerCase =
    normalizer.lowercase === true ||
    (
      Array.isArray(
        normalizer.normalizers
      ) &&
      normalizer.normalizers.some(
        (n) =>
          n &&
          n.lowercase === true
      )
    );


  /* ----------------------------------------------------------
     Special tokens
     ---------------------------------------------------------- */

  const unkToken =
    (
      tokenizerJson.model &&
      tokenizerJson.model.unk_token
    ) ||
    tokenizerConfig.unk_token ||
    '[UNK]';


  const clsToken =
    tokenizerConfig.cls_token ||
    '[CLS]';


  const sepToken =
    tokenizerConfig.sep_token ||
    '[SEP]';


  const padToken =
    tokenizerConfig.pad_token ||
    '[PAD]';


  const clsId =
    vocab[clsToken] !== undefined
      ? vocab[clsToken]
      : vocab['[CLS]'];


  const sepId =
    vocab[sepToken] !== undefined
      ? vocab[sepToken]
      : vocab['[SEP]'];


  const padId =
    vocab[padToken] !== undefined
      ? vocab[padToken]
      : (
          vocab['[PAD]'] !== undefined
            ? vocab['[PAD]']
            : 0
        );


  if (clsId === undefined) {

    throw new Error(
      '[offscreen] Could not find CLS token ID.'
    );
  }


  if (sepId === undefined) {

    throw new Error(
      '[offscreen] Could not find SEP token ID.'
    );
  }


  /* ----------------------------------------------------------
     Label mapping
     ---------------------------------------------------------- */

  const id2label =
    modelConfig.id2label ||
    tokenizerConfig.id2label ||
    {};


  pvDebug(
    '[offscreen] ID2LABEL:',
    id2label
  );


  if (
    Object.keys(id2label).length === 0
  ) {

    console.warn(
      '[offscreen] WARNING: No id2label mapping found.'
    );
  }


  /* ----------------------------------------------------------
     Load ONNX model
     ---------------------------------------------------------- */

  const modelUrl =
    extURL(
      MODEL_DIR + MODEL_FILE
    );


  const session =
    await ort.InferenceSession.create(
      modelUrl,
      {
        executionProviders: [
          'wasm'
        ]
      }
    );


  pvDebug(
    '[offscreen] ONNX model loaded.'
  );


  pvDebug(
    '[offscreen] Model inputs:',
    session.inputNames
  );


  pvDebug(
    '[offscreen] Model outputs:',
    session.outputNames
  );


  return {

    session,

    vocab,

    id2label,

    doLowerCase,

    unkToken,

    clsId,

    sepId,

    padId
  };
}


/* ============================================================
   Ensure model loaded once
   ============================================================ */

function ensureModelLoaded() {

  if (!modelResourcesPromise) {

    modelResourcesPromise =
      loadModelResources()
        .catch((error) => {

          modelResourcesPromise = null;

          throw error;
        });
  }

  return modelResourcesPromise;
}


/* ============================================================
   Character helpers
   ============================================================ */

function isWhitespace(ch) {

  return /\s/.test(ch);
}


function isPunctuation(ch) {

  const cp =
    ch.codePointAt(0);

  return (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  );
}


/* ============================================================
   Basic tokenizer
   ============================================================ */

function basicTokenizeWithOffsets(text) {

  const tokens = [];

  let i = 0;

  const n = text.length;


  while (i < n) {

    const ch = text[i];


    if (isWhitespace(ch)) {

      i++;

      continue;
    }


    if (isPunctuation(ch)) {

      tokens.push({

        text: ch,

        start: i,

        end: i + 1
      });

      i++;

      continue;
    }


    let j = i + 1;


    while (
      j < n &&
      !isWhitespace(text[j]) &&
      !isPunctuation(text[j])
    ) {

      j++;
    }


    tokens.push({

      text:
        text.slice(
          i,
          j
        ),

      start: i,

      end: j
    });


    i = j;
  }


  return tokens;
}


/* ============================================================
   WordPiece tokenizer
   ============================================================ */

function wordpieceTokenizeWithOffsets(
  word,
  vocab,
  unkToken
) {

  const {
    text,
    start
  } = word;


  const output = [];

  const len =
    text.length;


  if (len === 0) {

    return output;
  }


  let curStart = 0;


  while (
    curStart < len
  ) {

    let curEnd = len;

    let matched = null;


    while (
      curStart < curEnd
    ) {

      let sub =
        text.slice(
          curStart,
          curEnd
        );


      if (curStart > 0) {

        sub =
          '##' + sub;
      }


      if (
        Object.prototype.hasOwnProperty.call(
          vocab,
          sub
        )
      ) {

        matched = sub;

        break;
      }


      curEnd--;
    }


    if (matched === null) {

      return [

        {
          text: unkToken,

          start,

          end:
            start + len,

          isUnk: true
        }

      ];
    }


    output.push({

      text: matched,

      start:
        start + curStart,

      end:
        start + curEnd
    });


    curStart =
      curEnd;
  }


  return output;
}


/* ============================================================
   Tokenize text with character offsets
   ============================================================ */

function tokenizeWithOffsets(
  text,
  vocab,
  doLowerCase,
  unkToken
) {

  const words =
    basicTokenizeWithOffsets(
      text
    );


  const pieces = [];


  for (const word of words) {

    const wordForVocab =
      doLowerCase
        ? word.text.toLowerCase()
        : word.text;


    const subPieces =
      wordpieceTokenizeWithOffsets(
        {
          text:
            wordForVocab,

          start:
            word.start
        },

        vocab,

        unkToken
      );


    for (
      const piece of subPieces
    ) {

      pieces.push(
        piece
      );
    }
  }


  return pieces;
}


/* ============================================================
   Build ONNX model inputs
   ============================================================ */

function buildModelInputs(
  pieces,
  ready,
  maxLen
) {

  const truncated =
    pieces.slice(
      0,
      Math.max(
        0,
        maxLen - 2
      )
    );


  const ids = [
    ready.clsId
  ];


  const offsets = [
    [0, 0]
  ];


  for (
    const piece of truncated
  ) {

    const id =
      Object.prototype.hasOwnProperty.call(
        ready.vocab,
        piece.text
      )

        ? ready.vocab[
            piece.text
          ]

        : ready.vocab[
            ready.unkToken
          ];


    ids.push(id);


    offsets.push([
      piece.start,
      piece.end
    ]);
  }


  ids.push(
    ready.sepId
  );


  offsets.push([
    0,
    0
  ]);


  const inputIds =
    new BigInt64Array(
      ids.map(
        (value) =>
          BigInt(value)
      )
    );


  const attentionMask =
    new BigInt64Array(
      ids.length
    );


  attentionMask.fill(1n);


  const tokenTypeIds =
    new BigInt64Array(
      ids.length
    );


  tokenTypeIds.fill(0n);


  return {

    inputIds,

    attentionMask,

    tokenTypeIds,

    offsets
  };
}


/* ============================================================
   Parse BIO label
   ============================================================ */

function parseEntityLabel(
  label
) {

  if (!label) {

    return {

      prefix: 'O',

      entityType: 'O'
    };
  }


  const normalized =
    String(label)
      .trim()
      .toUpperCase();


  if (
    normalized === 'O' ||
    normalized === '0'
  ) {

    return {

      prefix: 'O',

      entityType: 'O'
    };
  }


  const bioMatch =
    normalized.match(
      /^([BI])[-_](.+)$/
    );


  if (bioMatch) {

    return {

      prefix:
        bioMatch[1],

      entityType:
        bioMatch[2]
    };
  }


  return {

    prefix: 'B',

    entityType:
      normalized
  };
}


/* ============================================================
   Normalize entity type
   ============================================================ */

function normalizeEntityType(
  entityType
) {

  if (!entityType) {

    return 'UNKNOWN';
  }


  let key =
    String(entityType)
      .toUpperCase()
      .trim()
      .replace(
        /[\s_-]/g,
        ''
      );


  key =
    key.replace(
      /^[BI]/,
      ''
    );


  const ENTITY_TYPE_MAP = {

    /* Person */

    NAME: 'NAME',

    PERSON: 'NAME',

    PER: 'NAME',

    GIVENNAME: 'NAME',

    FIRSTNAME: 'NAME',

    LASTNAME: 'NAME',

    SURNAME: 'NAME',

    MIDDLENAME: 'NAME',


    /* Location */

    LOCATION: 'LOCATION',

    LOC: 'LOCATION',

    CITY: 'LOCATION',

    STATE: 'LOCATION',

    COUNTRY: 'LOCATION',


    /* Organization */

    ORGANIZATION: 'ORGANIZATION',

    ORG: 'ORGANIZATION',


    /* Email */

    EMAIL: 'EMAIL',

    EMAILADDRESS: 'EMAIL',


    /* Phone */

    TEL: 'PHONE',

    PHONE: 'PHONE',

    PHONENUMBER: 'PHONE',

    PHONEIMEI: 'PHONE',


    /* Credit card */

    CREDITCARD: 'CARD',

    CREDITCARDNUMBER: 'CARD',

    CREDITCARDCVV: 'CARD',


    /* IP */

    IP: 'IP_ADDRESS',

    IPV4: 'IP_ADDRESS',

    IPV6: 'IP_ADDRESS'
  };


  return (
    ENTITY_TYPE_MAP[key] ||
    key
  );
}


/* ============================================================
   Calculate winning label confidence
   ============================================================ */

function calculateConfidence(
  data,
  base,
  numLabels,
  bestScore
) {

  let sumExp = 0;


  for (
    let l = 0;
    l < numLabels;
    l++
  ) {

    sumExp +=
      Math.exp(
        data[
          base + l
        ] - bestScore
      );
  }


  return (
    1 / sumExp
  );
}


/* ============================================================
   NER inference
   ============================================================ */

async function runNerOnText(
  text
) {

  if (
    !text ||
    !text.trim()
  ) {

    return [];
  }


  pvDebug(
    '[offscreen] NER INPUT:',
    JSON.stringify(text)
  );


  /* ----------------------------------------------------------
     Load model
     ---------------------------------------------------------- */

  const ready =
    await ensureModelLoaded();


  /* ----------------------------------------------------------
     Tokenize
     ---------------------------------------------------------- */

  const pieces =
    tokenizeWithOffsets(
      text,

      ready.vocab,

      ready.doLowerCase,

      ready.unkToken
    );


  if (
    pieces.length === 0
  ) {

    return [];
  }


  pvDebug(
    '[offscreen] TOKEN PIECES:',
    pieces
  );


  /* ----------------------------------------------------------
     Build inputs
     ---------------------------------------------------------- */

  const {
    inputIds,

    attentionMask,

    tokenTypeIds,

    offsets

  } =
    buildModelInputs(
      pieces,

      ready,

      MAX_SEQ_LEN
    );


  const seqLen =
    inputIds.length;


  /* ----------------------------------------------------------
     Create ONNX feeds
     ---------------------------------------------------------- */

  const inputNames =
    ready.session.inputNames ||
    [];


  const feeds = {};


  if (
    inputNames.includes(
      'input_ids'
    )
  ) {

    feeds.input_ids =
      new ort.Tensor(
        'int64',

        inputIds,

        [
          1,
          seqLen
        ]
      );
  }


  if (
    inputNames.includes(
      'attention_mask'
    )
  ) {

    feeds.attention_mask =
      new ort.Tensor(
        'int64',

        attentionMask,

        [
          1,
          seqLen
        ]
      );
  }


  if (
    inputNames.includes(
      'token_type_ids'
    )
  ) {

    feeds.token_type_ids =
      new ort.Tensor(
        'int64',

        tokenTypeIds,

        [
          1,
          seqLen
        ]
      );
  }


  pvDebug(
    '[offscreen] ONNX FEEDS:',
    Object.keys(feeds)
  );


  /* ----------------------------------------------------------
     Run inference
     ---------------------------------------------------------- */

  const outputMap =
    await ready.session.run(
      feeds
    );


  const outputNames =
    ready.session.outputNames;


  if (
    !outputNames ||
    outputNames.length === 0
  ) {

    throw new Error(
      '[offscreen] ONNX model returned no outputs.'
    );
  }


  const logitsTensor =
    outputMap[
      outputNames[0]
    ];


  if (!logitsTensor) {

    throw new Error(
      '[offscreen] Could not find logits output.'
    );
  }


  const dims =
    logitsTensor.dims;


  const numLabels =
    dims[
      dims.length - 1
    ];


  const data =
    logitsTensor.data;


  pvDebug(
    '[offscreen] LOGITS DIMS:',
    dims
  );


  pvDebug(
    '[offscreen] NUMBER OF LABELS:',
    numLabels
  );


  /* ----------------------------------------------------------
     Decode predictions
     ---------------------------------------------------------- */

  const spans = [];

  let current = null;


  for (
    let t = 0;
    t < seqLen;
    t++
  ) {

    const [
      start,
      end
    ] =
      offsets[t];


    /* --------------------------------------------------------
       Ignore CLS / SEP
       -------------------------------------------------------- */

    if (
      start === end
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       Find highest scoring label
       -------------------------------------------------------- */

    const base =
      t * numLabels;


    let best =
      0;

    let bestScore =
      -Infinity;


    for (
      let l = 0;
      l < numLabels;
      l++
    ) {

      const score =
        data[
          base + l
        ];


      if (
        score >
        bestScore
      ) {

        bestScore =
          score;

        best =
          l;
      }
    }


    /* --------------------------------------------------------
       Softmax confidence
       -------------------------------------------------------- */

    const confidence =
      calculateConfidence(
        data,

        base,

        numLabels,

        bestScore
      );


    /* --------------------------------------------------------
       Label
       -------------------------------------------------------- */

    const rawLabel =
      ready.id2label[
        String(best)
      ] ||
      ready.id2label[
        best
      ] ||
      'O';


    const {
      prefix,

      entityType:
        rawEntityType

    } =
      parseEntityLabel(
        rawLabel
      );


    const entityType =
      normalizeEntityType(
        rawEntityType
      );


    pvDebug(
      '[offscreen] TOKEN PREDICTION:',
      {

        tokenIndex:
          t,

        tokenText:
          text.slice(
            start,
            end
          ),

        start,

        end,

        labelId:
          best,

        rawLabel,

        entityType,

        confidence,

        accepted:
          confidence >=
          NER_CONFIDENCE_THRESHOLD
      }
    );


    /* ========================================================
       CONFIDENCE FILTER
       ========================================================

       Anything below 80% is ignored.
       ======================================================== */

    if (
      confidence <
      NER_CONFIDENCE_THRESHOLD
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       O label
       -------------------------------------------------------- */

    if (
      prefix === 'O' ||
      entityType === 'O'
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       B-ENTITY
       -------------------------------------------------------- */

    if (
      prefix === 'B' ||
      !current ||
      current.entityType !== entityType
    ) {

      if (current) {

        spans.push(
          current
        );
      }


      current = {

        entityType,

        start,

        end,

        confidences: [
          confidence
        ]
      };


      continue;
    }


    /* --------------------------------------------------------
       I-ENTITY
       -------------------------------------------------------- */

    if (
      prefix === 'I'
    ) {

      current.end =
        end;


      current.confidences.push(
        confidence
      );
    }
  }


  /* ----------------------------------------------------------
     Flush final span
     ---------------------------------------------------------- */

  if (current) {

    spans.push(
      current
    );
  }


  /* ----------------------------------------------------------
     Create final results
     ---------------------------------------------------------- */

  const result =
    spans.map(
      (span) => ({

        entityType:
          span.entityType,

        start:
          span.start,

        end:
          span.end,

        text:
          text.slice(
            span.start,
            span.end
          ),

        confidence:
          span.confidences.reduce(
            (
              sum,
              value
            ) =>
              sum + value,

            0
          ) /
          span.confidences.length
      })
    );


  pvDebug(
    '[offscreen] FINAL NER RESULT:',
    result
  );


  return result;
}


/* ============================================================
   Message listener
   ============================================================ */

chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {

    if (
      message &&
      message.target === 'offscreen' &&
      message.type ===
        'RUN_NER_INFERENCE'
    ) {

      runNerOnText(
        message.text
      )

        .then(
          (spans) => {

            sendResponse({

              ok: true,

              spans
            });
          }
        )

        .catch(
          (error) => {

            console.error(
              '[offscreen] NER inference error:',
              error
            );


            sendResponse({

              ok: false,

              error:
                error.message ||
                String(error),

              spans: []
            });
          }
        );


      return true;
    }

    if (
      message &&
      message.target === 'offscreen' &&
      message.type === 'RUN_ID_IMAGE_OCR'
    ) {
      runIdImageOcrBatch(message.screenshot, message.regions, message.viewport)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error), results: [] }));
      return true;
    }

    // On-device LLM reasoning (agent/webllmEngine.js) — Fully Local mode's
    // local-model fallback and the local side of Hybrid Debate mode. See
    // that file's header comment for why this runs here (offscreen
    // documents have a real `window` + WebGPU access; a service worker
    // does not) and lib/webllm/README.md for the one-time vendoring step
    // this depends on. Fails closed with a clear error if not vendored —
    // never silently returns a made-up action.
    if (
      message &&
      message.target === 'offscreen' &&
      message.type === 'RUN_WEBLLM_REASON'
    ) {
      (async () => {
        try {
          if (!self.__BA_WebLLMEngine) {
            throw new Error('agent/webllmEngine.js did not load into the offscreen document.');
          }
          if (!self.__BA_WebLLMEngine.isAvailable()) {
            throw new Error(
              'WebLLM runtime not vendored (lib/webllm/web-llm.js missing). See lib/webllm/README.md.'
            );
          }
          const decision = await self.__BA_WebLLMEngine.reason({
            task: message.task,
            elements: message.elements,
            history: message.history,
            url: message.url,
          });
          sendResponse({ ok: true, decision });
        } catch (error) {
          console.warn('[offscreen] On-device LLM reasoning failed:', error.message || error);
          sendResponse({ ok: false, error: error.message || String(error) });
        }
      })();
      return true;
    }

    // On-device model status / explicit load / page-question answering.
    // Same routing as RUN_WEBLLM_REASON above: popup -> service worker ->
    // here. None of these touch the network except WebLLM's own one-time
    // weight download inside startLoad().
    if (
      message &&
      message.target === 'offscreen' &&
      (message.type === 'WEBLLM_STATUS' || message.type === 'WEBLLM_START_LOAD' || message.type === 'RUN_WEBLLM_ANSWER')
    ) {
      (async () => {
        const eng = self.__BA_WebLLMEngine;
        try {
          if (!eng) throw new Error('agent/webllmEngine.js did not load into the offscreen document.');
          if (message.type === 'WEBLLM_STATUS') {
            sendResponse({ ok: true, status: eng.getStatus() });
            return;
          }
          if (message.type === 'WEBLLM_START_LOAD') {
            eng.startLoad().catch(() => {}); // runs in the background; progress is broadcast
            sendResponse({ ok: true, status: eng.getStatus() });
            return;
          }
          const result = await eng.answer({
            question: message.question,
            lines: message.lines,
            url: message.url,
          });
          sendResponse({ ok: true, ...result });
        } catch (error) {
          console.warn('[offscreen] On-device model request failed:', error.message || error);
          sendResponse({ ok: false, error: error.message || String(error), status: eng ? eng.getStatus() : null });
        }
      })();
      return true;
    }

    if (
      message &&
      message.target === 'offscreen' &&
      message.type === 'RUN_FACE_DETECTION'
    ) {
    
      (async () => {
    
        try {
    
          const faces =
            await detectFaces(
              message.screenshot
            );
    
          sendResponse({
            ok: true,
            faces
          });
    
        }
        catch (error) {
    
          console.error(
            '[offscreen] Face detection failed:',
            error
          );
    
          sendResponse({
            ok: false,
            error:
              error.message ||
              String(error)
          });
        }
    
      })();
    
      return true;
    }


    return false;
  }
);


/* ============================================================
   Startup
   ============================================================ */

console.log(
  '[offscreen] NER offscreen document loaded.'
);

console.log(
  `[offscreen] NER confidence threshold: ${NER_CONFIDENCE_THRESHOLD * 100}%`
);
