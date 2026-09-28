/**
 * utils/featureDetection.js
 *
 * Browser capability detection (claude/v25-master-implementation-guide.md
 * Part 3, Task 1.4 — "Browser Compatibility Check"). v25's own spec names
 * OPFS/WebLLM/WebGPU/IndexedDB as the things to check; this file checks
 * exactly those plus the two capabilities this specific extension's own
 * architecture actually depends on that the spec didn't separately name:
 * `chrome.offscreen` (every on-device model — NER, YuNet face detection,
 * PP-OCR — runs inside the offscreen document; see offscreen.js) and
 * `chrome.sidePanel` (manifest.json's own `minimum_chrome_version` exists
 * specifically because this API requires Chrome 114+).
 *
 * Every detector here fails closed to `false` (wrapped in try/catch) —
 * an environment where even checking for a feature throws is treated as
 * "doesn't have it", never as a crash propagating up into the caller.
 *
 * This module is read-only and advisory: nothing in this codebase's
 * actual control flow branches on its output today. It exists so a
 * missing capability is named plainly (in the Settings panel — see
 * popup.js's renderFeatureSupport()) instead of only showing up later as
 * an unexplained silent fallback (the exact pattern already established
 * for face-detection and OCR availability elsewhere in this codebase).
 *
 * Honesty note: this has not been run in a real browser — no browser is
 * available in the sandbox this was written in (see docs/TESTING.md). In
 * Node, every navigator/chrome/WebAssembly global is undefined, so every
 * detector here correctly (and unremarkably) reports false — real
 * verification of what each one reports in an actual Chrome build is
 * still pending. What IS unit-tested is summarize()'s pure mapping from
 * a capability report to human-readable notes, against synthetic input.
 */
(function (root) {
  function detectIndexedDB() {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch (_) {
      return false;
    }
  }

  function detectOPFS() {
    try {
      return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
    } catch (_) {
      return false;
    }
  }

  function detectWebGPU() {
    try {
      return typeof navigator !== 'undefined' && !!navigator.gpu;
    } catch (_) {
      return false;
    }
  }

  function detectWasm() {
    try {
      return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
    } catch (_) {
      return false;
    }
  }

  function detectSharedArrayBuffer() {
    try {
      return typeof SharedArrayBuffer !== 'undefined';
    } catch (_) {
      return false;
    }
  }

  function detectCrossOriginIsolated() {
    try {
      return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
    } catch (_) {
      return false;
    }
  }

  function detectChromeSidePanel() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.sidePanel;
    } catch (_) {
      return false;
    }
  }

  function detectChromeOffscreen() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.offscreen;
    } catch (_) {
      return false;
    }
  }

  /** True once agent/webllmEngine.js's runtime is actually loaded — not whether the browser COULD run it, whether it currently HAS (see lib/webllm/README.md; not vendored by default). */
  function detectWebLLMLoaded() {
    try {
      return typeof self !== 'undefined' && typeof self.webllm !== 'undefined';
    } catch (_) {
      return false;
    }
  }

  /**
   * Pure mapping from a capability report to plain-English notes — only
   * ever emits a note for something MISSING, never praises what's
   * present, so an all-good report is an empty array (nothing to say).
   *
   * @param {Object} report - as produced by detectAll() (minus its own `notes` field)
   * @returns {string[]}
   */
  function summarize(report) {
    const notes = [];
    if (!report) return notes;
    if (!report.indexedDB) notes.push('IndexedDB is unavailable — agent/contextManager.js will fall back to in-memory (this-session-only) task checkpoints.');
    if (!report.opfs) notes.push('OPFS (navigator.storage.getDirectory) is unavailable — once vendored, WebLLM\'s on-device model cache will not persist across browser sessions here.');
    if (!report.webgpu) notes.push('WebGPU is unavailable — on-device LLM reasoning (agent/webllmEngine.js), once vendored, will fall back to its slower WASM execution path.');
    if (!report.wasm) notes.push('WebAssembly is unavailable — NER, face detection, and OCR (all ONNX Runtime Web) cannot run at all in this browser; every one of them fails closed to its documented fallback.');
    if (report.wasm && !report.sharedArrayBuffer) notes.push('SharedArrayBuffer is unavailable — ONNX Runtime Web falls back to its single-threaded WASM build instead of lib/ort-wasm-simd-threaded.*, which is slower but still correct.');
    if (!report.chromeSidePanel) notes.push('chrome.sidePanel is unavailable — this extension requires Chrome 114+ (see manifest.json\'s minimum_chrome_version); this build is not supported.');
    if (!report.chromeOffscreen) notes.push('chrome.offscreen is unavailable — NER, face detection, and OCR all run inside the offscreen document; without this API none of them can run at all.');
    return notes;
  }

  /**
   * @returns {{
   *   indexedDB: boolean, opfs: boolean, webgpu: boolean, wasm: boolean,
   *   sharedArrayBuffer: boolean, crossOriginIsolated: boolean,
   *   chromeSidePanel: boolean, chromeOffscreen: boolean, webllmLoaded: boolean,
   *   notes: string[]
   * }}
   */
  function detectAll() {
    const report = {
      indexedDB: detectIndexedDB(),
      opfs: detectOPFS(),
      webgpu: detectWebGPU(),
      wasm: detectWasm(),
      sharedArrayBuffer: detectSharedArrayBuffer(),
      crossOriginIsolated: detectCrossOriginIsolated(),
      chromeSidePanel: detectChromeSidePanel(),
      chromeOffscreen: detectChromeOffscreen(),
      webllmLoaded: detectWebLLMLoaded(),
    };
    report.notes = summarize(report);
    return report;
  }

  root.__BA_FeatureDetection = {
    detectIndexedDB,
    detectOPFS,
    detectWebGPU,
    detectWasm,
    detectSharedArrayBuffer,
    detectCrossOriginIsolated,
    detectChromeSidePanel,
    detectChromeOffscreen,
    detectWebLLMLoaded,
    summarize,
    detectAll,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__BA_FeatureDetection;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
