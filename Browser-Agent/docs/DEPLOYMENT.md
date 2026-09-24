# Deployment

## Loading the unpacked extension

1. Open `chrome://extensions` in Chrome 114 or later (the side panel API this extension uses didn't exist before Chrome 114 — `manifest.json`'s `minimum_chrome_version` enforces this).
2. Enable "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this folder (`Browser-Agent/`, the one containing `manifest.json`).
4. Click the extension's icon in the toolbar to open the side panel (this extension uses `chrome.sidePanel`, not a popup window — it stays open across page navigations until explicitly closed).

No build step exists or is needed — every file is loaded as plain JavaScript/HTML, as-is.

### Testing against a local (`file://`) page

The extension supports `http://`/`https://` pages by default. To point it at a page saved on disk instead (e.g. a local test fixture), Chrome needs one extra, per-extension step Chrome does not turn on by default for any extension: on `chrome://extensions`, find this extension's card, click "Details", and enable "Allow access to file URLs". Do this before opening the local page — content scripts are only (re-)evaluated for injection on a fresh navigation/analysis after the toggle is on.

This was previously broken even with that toggle enabled: `background/service-worker.js`'s own page-scheme check (`performAnalysis()` and `performAction()`) used `/^https?:/`, which rejected every `file://` page outright before Chrome's file-access permission ever got a chance to matter, producing the same "internal page — content scripts cannot run" refusal regardless of the toggle. Fixed by widening both checks to `/^(https?|file):/` — the manifest's `host_permissions`/`content_scripts` already use `<all_urls>`, which does cover `file://` once a user grants that toggle, so no other permission change was needed.

## What's already vendored and what isn't

This extension's own rule, stated in each of the READMEs below, is that it never loads code from a CDN at runtime (the CSP only allows `'self'` scripts) — everything it uses ships inside the extension folder. Most of that is already done:

| Dependency | Status | Used for |
|---|---|---|
| ONNX Runtime Web (`lib/ort.min.js`, `lib/ort.wasm.min.js`, `lib/ort-wasm-simd-threaded.*`) | Vendored | NER, face-detection, and OCR inference (the one shared inference engine for all three) |
| Face detection model (`models/face_detection_yunet_2023mar.onnx`) | Vendored | Face redaction |
| NER tokenizer/config (`models/ner/tokenizer.json`, `tokenizer_config.json`, `config.json`) | Vendored | — |
| **NER model weights** (`models/ner/model_quantized.onnx`) | **Vendored** | Freeform-name/location/organization PII detection — see `models/ner/README.md` |
| **PP-OCR/PaddleOCR models** (`models/ocr/det.onnx`, `models/ocr/rec.onnx`) | **Vendored** | OCR confirmation of detected ID-document images — see `models/ocr/README.md`. Replaces an earlier Tesseract.js-based version, dropped for accuracy on small/dense ID-card text and to avoid a second WASM OCR runtime alongside ONNX Runtime Web. |
| **WebLLM runtime** (`lib/webllm/web-llm.js`, the `@mlc-ai/web-llm` inference engine — 6MB) | **Vendored** | On-device LLM reasoning (Fully Local mode's fallback step, and Hybrid Debate mode's local side) — see `lib/webllm/README.md` |
| **WebLLM model weights** (Qwen2.5-1.5B-Instruct-q4f16_1-MLC, ~800MB; Qwen2.5-0.5B-Instruct fallback, ~500MB) | **Deliberately NOT vendored** | The actual LLM the runtime above executes. WebLLM fetches these from MLC-AI's own model CDN the first time Fully Local's local-model fallback or Hybrid Debate actually runs, and caches them in this extension's OPFS storage from then on — see `lib/webllm/README.md`'s "The model weights are still not vendored — and don't need to be" for why that's correct rather than a gap (a browser extension bundling ~1GB of model shards would be the wrong pattern regardless of network access). **This is why the extension folder is ~60MB, not ~1GB+**: the code and every runtime dependency are here; the LLM's weights download on first real use of a mode that needs them, exactly like any other model-hub-backed on-device AI tool. `local`/`hybrid`'s field-matching and PII detection do not depend on this at all — only the local-LLM fallback step and Hybrid Debate's local side do. |

All three vendored rows above were fetched once this account's network egress allowlist was opened to `cdn.jsdelivr.net` and `huggingface.co` (it previously excluded `registry.npmjs.org`, `unpkg.com`, `cdn.jsdelivr.net`, `huggingface.co`, and PyPI, which is why these couldn't be completed earlier — see each README's "vendored" section for exactly what was fetched, from where, and how it was verified against real inference, not just file presence). Each still fails closed with a clear degradation if its file is ever missing (a stripped-down source tree, a bad copy) rather than crashing — the affected feature falls back to the same documented, safe alternative described in each README.

## Permissions this extension requests, and why

From `manifest.json`:

- `activeTab`, `scripting` — inject content scripts and run functions in the active tab on demand (`chrome.scripting.executeScript`), the mechanism `background/service-worker.js` uses instead of a broader always-on content-script permission for most of its work.
- `storage` — `chrome.storage.local` for the Privacy Dial mode and the user's own private-data store.
- `offscreen` — host the offscreen document where every on-device ML model actually runs.
- `sidePanel` — the side panel UI (Chrome 114+).
- `host_permissions: ["<all_urls>"]` — required for `chrome.scripting.executeScript` and `chrome.tabs.captureVisibleTab` to work on arbitrary sites the user points the agent at; this is the broadest permission requested and the one most worth a reviewer's attention.

Notably absent: `tabs`, `webRequest`, `cookies`, `history`, `downloads` — none of these are requested, and nothing in the codebase needs them today.

## Configuring the cloud endpoint

`agent/agentBackend.js`'s `getEndpoint()`/`setEndpoint()` read/write a single URL from `chrome.storage.local` (falling back to `http://localhost:5000/api/agent/step` if unset). This is the one address `decideNextAction()` ever POSTs to, in `cloud`/`hybrid`/`debate` Privacy Dial modes. `decideNextAction()`'s request/response shape (documented in `docs/API_REFERENCE.md` and `docs/PRIVACY.md`) is the contract a backend needs to satisfy — this `Browser-Agent/` folder itself does not include one, but its sibling `Brower-Agent-Server/` (one level up) is a real Express server implementing exactly this contract (`POST /api/agent/step`, port 5000, matching the default above) against the Mistral AI API. Run it (`npm install && npm run dev` inside `Brower-Agent-Server/`) before using `cloud`/`hybrid`/`debate` mode, or point the endpoint at a different backend of your own.

## Known limitations for a demo or production run

- **No real-browser verification has been performed on the newest pieces** — the multi-jurisdiction PII pack, `agent/decisionRouter.js`, `agent/complianceChecker.js`, and `agent/contextManager.js` are unit-tested and (for the two that are wired in) exercised through Node-level syntax and integration checks, but none have been run inside an actual loaded extension in this environment (no Chrome available in this sandbox). See `docs/TESTING.md`'s manual-verification checklist before treating any of these as demo-ready.
- **`decisionRouter.js` and `complianceChecker.js` are now loaded by `popup.html` and called from `popup.js`** — Hybrid mode's per-step decision goes through `decisionRouter.js`'s TREE → HEURISTIC → LOCAL_LLM → CLOUD escalation instead of always calling the cloud reasoner directly, and `complianceChecker.js` runs on every page analysis with its output shown in the new "Compliance Signals" panel. `agent/contextManager.js` remains unwired — it would need a task-list/resume UI in `popup.js` that doesn't exist yet, not just a script tag. See `docs/IMPLEMENTATION.md` for the full breakdown.
- **Hybrid Debate mode's local side, Fully Local mode's on-device-LLM fallback, and NER-based PII detection are all now live** (WebLLM and the NER model weights are vendored — see `lib/webllm/README.md` and `models/ner/README.md`), provided the browser supports WebGPU for the WebLLM piece (`utils/featureDetection.js`'s `detectWebGPU()` — Settings' "Browser Compatibility & Storage" card reports this). None of this has run inside an actual loaded extension in this environment yet (no Chrome available in this sandbox — see "No real-browser verification" above); what has been verified is real ONNX/WebLLM inference against the vendored files outside a browser (see each README's verification section).
- **The extension's own `package.json`/build tooling does not exist** — there's no bundler, no minification, no TypeScript compilation step. Every `.js` file is exactly what Chrome loads. This is a deliberate simplicity choice for a hackathon-scale project, not an oversight, but it means there's no build-time type checking or linting gate before loading the unpacked extension — `node --check <file>.js` (syntax only) and the benchmark harness (logic, for the pieces it covers) are the available pre-flight checks.
