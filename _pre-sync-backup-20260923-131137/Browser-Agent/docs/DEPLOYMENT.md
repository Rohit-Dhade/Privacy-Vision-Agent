# Deployment

## Loading the unpacked extension

1. Open `chrome://extensions` in Chrome 114 or later (the side panel API this extension uses didn't exist before Chrome 114 — `manifest.json`'s `minimum_chrome_version` enforces this).
2. Enable "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this folder (`Browser-Agent/`, the one containing `manifest.json`).
4. Click the extension's icon in the toolbar to open the side panel (this extension uses `chrome.sidePanel`, not a popup window — it stays open across page navigations until explicitly closed).

No build step exists or is needed — every file is loaded as plain JavaScript/HTML, as-is.

## What's already vendored and what isn't

This extension's own rule, stated in each of the READMEs below, is that it never loads code from a CDN at runtime (the CSP only allows `'self'` scripts) — everything it uses ships inside the extension folder. Most of that is already done:

| Dependency | Status | Used for |
|---|---|---|
| ONNX Runtime Web (`lib/ort.min.js`, `lib/ort.wasm.min.js`, `lib/ort-wasm-simd-threaded.*`) | Vendored | NER, face-detection, and OCR inference (the one shared inference engine for all three) |
| Face detection model (`models/face_detection_yunet_2023mar.onnx`) | Vendored | Face redaction |
| NER tokenizer/config (`models/ner/tokenizer.json`, `tokenizer_config.json`, `config.json`) | Vendored | — |
| **NER model weights** (`models/ner/model_quantized.onnx`) | **Not vendored** | Freeform-name/location/organization PII detection — see `models/ner/README.md` |
| **PP-OCR/PaddleOCR models** (`models/ocr/det.onnx`, `models/ocr/rec.onnx`) | **Not vendored** | OCR confirmation of detected ID-document images — see `models/ocr/README.md`. Replaces an earlier Tesseract.js-based version, dropped for accuracy on small/dense ID-card text and to avoid a second WASM OCR runtime alongside ONNX Runtime Web. |
| **WebLLM** (`lib/webllm/web-llm.js`) | **Not vendored** | On-device LLM reasoning (Fully Local mode's fallback step, and Hybrid Debate mode's local side) — see `lib/webllm/README.md` |

Each unvendored item fails closed with a clear degradation, not a crash: the extension loads and runs normally without any of the three, and the affected feature falls back to a documented, safe alternative (see each README for exactly what that fallback is). All three READMEs give exact, tested steps to vendor the missing file(s) from a machine with normal network access — this repo's own sandbox environment has outbound access restricted to an allowlist that excludes `registry.npmjs.org`, `unpkg.com`, `cdn.jsdelivr.net`, `huggingface.co`, and PyPI, which is why these three specific steps couldn't be completed automatically here (documented per-file, not glossed over).

## Permissions this extension requests, and why

From `manifest.json`:

- `activeTab`, `scripting` — inject content scripts and run functions in the active tab on demand (`chrome.scripting.executeScript`), the mechanism `background/service-worker.js` uses instead of a broader always-on content-script permission for most of its work.
- `storage` — `chrome.storage.local` for the Privacy Dial mode and the user's own private-data store.
- `offscreen` — host the offscreen document where every on-device ML model actually runs.
- `sidePanel` — the side panel UI (Chrome 114+).
- `host_permissions: ["<all_urls>"]` — required for `chrome.scripting.executeScript` and `chrome.tabs.captureVisibleTab` to work on arbitrary sites the user points the agent at; this is the broadest permission requested and the one most worth a reviewer's attention.

Notably absent: `tabs`, `webRequest`, `cookies`, `history`, `downloads` — none of these are requested, and nothing in the codebase needs them today.

## Configuring the cloud endpoint

`agent/agentBackend.js`'s `getEndpoint()`/`setEndpoint()` read/write a single URL from `chrome.storage.local` (falling back to a default if unset). This is the one address `decideNextAction()` ever POSTs to, in `cloud`/`hybrid`/`debate` Privacy Dial modes. Point this at your own reasoning backend implementation before using any mode other than `local` — this repo does not include a reference server implementation; `decideNextAction()`'s request/response shape (documented in `docs/API_REFERENCE.md` and `docs/PRIVACY.md`) is the contract such a backend needs to satisfy.

## Known limitations for a demo or production run

- **No real-browser verification has been performed on the newest pieces** — the multi-jurisdiction PII pack, `agent/decisionRouter.js`, `agent/complianceChecker.js`, and `agent/contextManager.js` are unit-tested and (for the two that are wired in) exercised through Node-level syntax and integration checks, but none have been run inside an actual loaded extension in this environment (no Chrome available in this sandbox). See `docs/TESTING.md`'s manual-verification checklist before treating any of these as demo-ready.
- **`decisionRouter.js` and `complianceChecker.js` are now loaded by `popup.html` and called from `popup.js`** — Hybrid mode's per-step decision goes through `decisionRouter.js`'s TREE → HEURISTIC → LOCAL_LLM → CLOUD escalation instead of always calling the cloud reasoner directly, and `complianceChecker.js` runs on every page analysis with its output shown in the new "Compliance Signals" panel. `agent/contextManager.js` remains unwired — it would need a task-list/resume UI in `popup.js` that doesn't exist yet, not just a script tag. See `docs/IMPLEMENTATION.md` for the full breakdown.
- **Hybrid Debate mode's local side, and Fully Local mode's and Hybrid mode's on-device-LLM fallback, all silently degrade to their fallback behavior** until `lib/webllm/web-llm.js` is vendored — debate mode will report `CLOUD_ONLY_DEGRADED` for every step, and Hybrid mode's `decisionRouter.js` will fall through past its LOCAL_LLM layer to CLOUD on essentially every step, until then. This is correct, documented behavior, not a bug, but worth knowing before demoing debate mode's disagreement UI (which needs both sides responding to show anything interesting) or Hybrid mode's routing-stats panel (which will show mostly TREE/HEURISTIC/CLOUD, with LOCAL_LLM rarely if ever firing, until WebLLM is vendored).
- **NER-based PII detection does not run at all** until `models/ner/model_quantized.onnx` is vendored (see `models/ner/README.md`) — the deterministic regex/checksum layer, which is the majority of this system's detection coverage, is unaffected.
- **The extension's own `package.json`/build tooling does not exist** — there's no bundler, no minification, no TypeScript compilation step. Every `.js` file is exactly what Chrome loads. This is a deliberate simplicity choice for a hackathon-scale project, not an oversight, but it means there's no build-time type checking or linting gate before loading the unpacked extension — `node --check <file>.js` (syntax only) and the benchmark harness (logic, for the pieces it covers) are the available pre-flight checks.
