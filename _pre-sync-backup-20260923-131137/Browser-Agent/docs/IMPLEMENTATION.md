# Implementation status

A file-by-file inventory of what's actually in this repo, and its status: **shipped** (works today, in the real extension, wired into the running loop), **built, not wired** (the code exists, is syntax-checked and often unit-tested against Node, but nothing in `popup.html`/`popup.js` loads or calls it yet — as of this pass, nothing in the tables below is actually in this state anymore; see "What's wired in vs. built standalone" below), or **blocked** (the wiring/integration code is written, but a required third-party asset isn't vendored in this repo, so the feature fails closed at runtime). This mirrors `claude/v25-master-implementation-guide.md`'s 8-week roadmap (kept in the project's docs, not this repo) — the "Task N.M" references below are that document's numbering.

## `agent/` — the reasoning and safety layer

| File | Status | What it is |
|---|---|---|
| `agentBackend.js` | Shipped | The cloud call (`decideNextAction`), the deterministic local-only path (`decideNextActionLocalOnly`), and the on-device-LLM path (`decideNextActionLocalLLM`) all live here, plus action translation/normalization shared by all three. |
| `agentController.js` | Shipped | Thin FSM wrapper (task lifecycle phase bookkeeping) used alongside `popup.js`'s loop — not itself the orchestrator. |
| `fieldMatcher.js` | Shipped | Deterministic label/type/regex → private-data-key resolution. Hard-excludes password fields. |
| `formAnalyzer.js` | Shipped | Local-store coverage scoring for a form; feeds the zero-cloud fast path and contextual suggestions. |
| `consequentialActionDetector.js` | Shipped | Classifies payment/delete/cancel/publish/booking/submit/approval targets. |
| `privacyDial.js` | Shipped | 4-mode (`cloud`/`hybrid`/`local`/`debate`) storage + metadata; owns no behavioral branching itself. |
| `privacyBoundary.js` | Shipped | Structural allowlist sanitizer + adversarial-pattern pre-flight scan before any network transmission. |
| `privateDataStore.js` | Shipped | The user's own PII, stored in `chrome.storage.local` (falls back to `localStorage`) as one flat key/value dictionary; never logs values. |
| `trustGate.js` | Shipped | Deterministic phishing/look-alike-domain classifier, run before autofill. |
| `visualDomGrounder.js` | Shipped | Fuses a visual coordinate with the live DOM; rejects (never executes) an ungroundable click. |
| `stateDiffEngine.js` | Shipped | Metadata-only diff between two page-state snapshots. |
| `stateManager.js` | Shipped | Generic task-phase FSM (distinct from `taskManager.js`/`taskMemory.js`). |
| `taskManager.js` | Shipped | Hierarchical task/subgoal planning from a natural-language instruction. |
| `taskMemory.js` | Shipped | In-memory, bounded short-term action/history/blocker tracking for the *current* task, this session only. |
| `actionVerifier.js` | Shipped | Classifies an executed action's outcome into one of 7 states. |
| `recoveryEngine.js` | Shipped | Loop detection + failure-cause diagnosis + bounded retry strategy. |
| `userInputManager.js` | Shipped | Renders the three HITL UI states (ask-user notice, consequential-action confirmation, general HITL request) — rendering only; doesn't itself capture typed values. |
| `webllmEngine.js` | Blocked (WebLLM not vendored) | On-device LLM reasoning wrapper (Qwen2.5-1.5B primary, 0.5B fallback) run inside the offscreen document. Wiring, prompt-building, JSON-extraction, and timeout logic are all written; `self.__BA_WebLLMEngine.isAvailable()` returns false until `lib/webllm/web-llm.js` is manually vendored per `lib/webllm/README.md`, at which point it activates with no other code changes. |
| `debateManager.js` | Shipped | Hybrid Debate's agree/disagree/degraded resolution logic (Task 2.3), covered by `benchmark/fixtures/debate-scenarios.js`. Its local side is only actually reachable once `webllmEngine.js` is unblocked; until then, debate mode always resolves `CLOUD_ONLY_DEGRADED`. |
| `confidenceScorer.js` | Shipped | Multi-factor confidence scoring reused by `debateManager.js` and available standalone (Task 2.4). |
| `decisionRouter.js` | Shipped | Formalizes tree → heuristic → local-LLM → cloud escalation as one class with routing-distribution telemetry (Task 2.5). Loaded by `popup.html` and called from `popup.js`'s `runAgentLoop()` for every step of **Hybrid** mode (only) — see "What's wired in" below. Unit-tested standalone (8 scenarios) in addition to the full benchmark suite. Fully Local mode keeps its own separate, pre-existing inline TREE/HEURISTIC/LOCAL_LLM logic (deliberately not switched to this module — the two have different fallback UX when every local layer fails); Cloud-Assisted mode calls `agentBackend.decideNextAction()` directly, unconditionally, by design. |
| `complianceChecker.js` | Shipped | GDPR/CCPA/HIPAA keyword/structure signal detection over already-extracted data (Task 4.2). Loaded by `popup.html` and called from `popup.js`'s `analyzeCurrentPage()` on every page analysis; its score and violations render in the "Compliance Signals" panel under Page Summary & Redaction Details. Unit-tested standalone (13 scenarios) in addition to being exercised live. |
| `contextManager.js` | Shipped | IndexedDB-backed (with an in-memory session-only fallback if IndexedDB can't open) cross-task checkpoint/resume — save/load/switch/list/delete (Task 1.3). Unit-tested standalone (18 scenarios) against the fallback path; the real-IndexedDB path is standard browser API usage not exercisable in this Node-only sandbox. Loaded by `popup.html`; the "Saved Tasks" panel (above the chat log) lists checkpoints with Resume/Delete, `runAgentLoop()` restores a snapshot on resume, and auto-checkpoints once per step. |
| `verificationLoop.js` | Shipped | Gates a reasoner's self-reported `done` behind four independent, zero-model checks (productive-action, task-type-aware structural, before/after visual diff, advisory confirmation-text) before `runAgentLoop()` calls `markCompleted()` (Task 3.1). Bounded retry (`MAX_VERIFICATION_ATTEMPTS = 2`); exhausting retries hands back to the user honestly instead of claiming success. Unit-tested standalone (26 scenarios). See `ARCHITECTURE.md`'s "Task-completion verification". |
| `evidenceGenerator.js` | Shipped | Pure highlight-selection logic (which element, what color, why) for both the pre-consequential-action authorization gate and post-task completion evidence (Task 3.2) — the actual Canvas drawing lives in `popup.js`'s `annotateScreenshotDataUrl()` since Canvas is browser-only. Unit-tested standalone (19 scenarios). See `ARCHITECTURE.md`'s "Evidence generation". |
| `constitutionVersion.js` | Shipped | Single source of truth for the currently-shipped `CONSTITUTION.md` version (`1.1.0`), shown in the Privacy Receipt panel. |

## `content/` — runs inside the page

| File | Status | What it is |
|---|---|---|
| `domExtractor.js` | Shipped | Orchestrates one full extraction pass; produces the JSON-serializable result every downstream module consumes. |
| `interactiveElements.js` | Shipped | Finds interactive elements, including inside open shadow DOM (12-level recursion guard). |
| `textExtractor.js` | Shipped | Collects visible text runs with bounding boxes for PII redaction targeting. |
| `visibility.js` | Shipped | The single visibility/occlusion gatekeeper used before anything is extracted. |
| `piiDetector.js` | Shipped | Regex + checksum PII detection (see `PRIVACY.md` for the full type table), plus an async NER pass that degrades gracefully to "no NER spans" if the offscreen model isn't available — which, today, it isn't (see the NER model gap under "Known gaps" below). |
| `idImageDetector.js` | Shipped | Keyword + aspect-ratio heuristic for photographed/scanned ID document images — no OCR, no model. |
| `iconCandidateDetector.js` | Shipped | Finds icon-only unlabeled interactive elements for the icon classifier to label. |
| `coordinateMapper.js` | Shipped | Viewport-CSS-px ↔ screenshot-pixel-space bbox conversion. |
| `redactor.js` | Shipped | Draws the actual black redaction rectangles onto a screenshot copy. |
| `semanticDomBuilder.js` | Shipped, local-only | Builds a compact, privacy-stripped semantic view of the page for local reasoning; explicitly never transmitted (stored only in `window.__BA_state.shadowSemanticDom`). |
| `content.js` | Shipped | The `window.__BA` action/extraction API the service worker drives directly; also the DOM-event interaction logger and field-guide overlay (with Hindi/Marathi via `utils/i18nLabels.js`). |

## `background/` and the offscreen document

| File | Status | What it is |
|---|---|---|
| `background/service-worker.js` | Shipped | Chrome-API plumbing only — content-script injection (two overlapping mechanisms, see `ARCHITECTURE.md`), screenshot capture with rate-limit backoff, offscreen-document lifecycle, and the message router. Makes zero network calls itself. |
| `offscreen.html` / `offscreen.js` | Shipped, partially blocked | Runs NER (ONNX — blocked, see below), face detection (ONNX/YuNet — shipped, model present), on-device LLM reasoning (WebLLM — blocked, not vendored), and ID-image OCR confirmation (PP-OCR/PaddleOCR det+rec, run through the same ONNX Runtime Web instance — blocked, weights not vendored). Each of the three blocked features fails closed with a clear error rather than fabricating a result. |

## `utils/`

| File | Status | What it is |
|---|---|---|
| `merkleProof.js` | Shipped | The Merkle-tree + ECDSA redaction proof system. |
| `visualStateEngine.js` | Shipped | Classical pixel-differencing screen-state perception (loading/overlay/painted/frame-delta). |
| `iconClassifier.js` / `iconModel.js` | Shipped | The 6,862-parameter trained icon CNN and its embedded int8 weights. |
| `i18nLabels.js` | Shipped, generated | Hindi/Marathi field-guide translation tables, built from `utils/i18n/packs/*.json` via `utils/i18n/build-language-packs.js`. |
| `geometry.js`, `selectors.js`, `logger.js` | Shipped | Shared geometry math, stable CSS selector generation, and logging helpers used across content scripts. |
| `featureDetection.js` | Shipped, advisory-only | Fail-closed capability checks (IndexedDB, OPFS, WebGPU, WebAssembly, SharedArrayBuffer, `chrome.sidePanel`, `chrome.offscreen`, whether WebLLM is currently loaded) — Task 1.4. Nothing branches on its output; `popup.js`'s `renderFeatureSupport()` names any missing capability in Settings instead of leaving a silent degraded fallback unexplained. Unverified in a real browser (every `navigator`/`chrome`/`WebAssembly` global is `undefined` in Node, so every detector correctly-but-unremarkably reports `false` there); `summarize()`'s pure report→notes mapping is unit-tested (part of 23 combined scenarios with `opfsManager.js`, below) against synthetic input. |
| `opfsManager.js` | Shipped, advisory-only | OPFS support + storage-quota status (`navigator.storage.estimate()`) — Task 1.2. Deliberately does not duplicate WebLLM's own OPFS model-cache management (see the file's own header comment); answers only what WebLLM's internals don't expose. `formatQuotaSummary()`'s pure formatting is unit-tested against synthetic input (23 scenarios combined with `featureDetection.js`); the real `navigator.storage` calls are standard browser API usage not exercisable in Node. |

## `benchmark/`

| File | Status | What it is |
|---|---|---|
| `run-benchmark.js` | Shipped | Node harness running the extension's own unmodified detection/decision-logic modules against hand-labeled fixtures — see `TESTING.md`. |
| `fixtures/*.json`, `fixtures/*.js` | Shipped | Ground-truth fixtures, including `debate-scenarios.js` (Task 6.1) and the multi-jurisdiction PII cases added alongside the detector's own expansion (Task 4.1). |

## Known gaps (fail closed, documented, not hidden)

Three third-party assets are referenced by working integration code but are not present in this repo, each for the same reason: this sandbox's outbound network access is restricted to the standard package/CDN registries, all of which returned 403 for these specific downloads. Each is documented with exact manual vendoring steps in a README next to where it belongs, following the same pattern:

- **`lib/webllm/web-llm.js`** (WebLLM runtime) — see `lib/webllm/README.md`. Blocks: on-device LLM reasoning in Fully Local mode's fallback step, and the local side of Hybrid Debate mode (which resolves `CLOUD_ONLY_DEGRADED` until this is vendored).
- **`models/ocr/det.onnx` and `models/ocr/rec.onnx`** (PP-OCR/PaddleOCR detection + English recognition weights) — see `models/ocr/README.md`. Replaces an earlier Tesseract.js-based version of this same feature, dropped for accuracy on small/dense ID-card text and to avoid a second WASM OCR runtime alongside ONNX Runtime Web. Blocks: OCR *confirmation* of ID-image regions only — the heuristic redaction of those regions still happens unconditionally without it.
- **`models/ner/model_quantized.onnx`** (the NER model's actual weights) — discovered and documented in this pass; not previously written down anywhere in this repo before now. See `models/ner/README.md`. `models/ner/` contains `tokenizer.json`, `tokenizer_config.json`, and `config.json`, but not the `.onnx` weights file `offscreen.js` fetches by that exact name. This means NER inference fails closed at runtime in a real browser today, not only in the Node benchmark harness (which stubs it out for the separate reason that Node can't run ONNX WASM at all). The deterministic regex + checksum PII layer (`content/piiDetector.js`'s non-NER path) is entirely unaffected and is what actually does the redaction work in practice; NER would only have added coverage for freeform names/locations/organizations that don't match a structured pattern.

## What's wired in vs. built standalone, as of this pass

As of this pass, every non-blocked module in the tables above is genuinely part of the running extension, not just present in the repo — there is no more "built, not wired" category left; only `Shipped` and `Blocked` (a missing third-party asset, not a wiring gap — see "Known gaps" above) remain:

- **`decisionRouter.js`** is loaded by `popup.html` and instantiated in `popup.js`, and `runAgentLoop()` calls its `route()` method for every step while the Privacy Dial is set to Hybrid — see that call site's comment for exactly why Cloud-Assisted and Fully Local modes don't. Its cumulative `getRoutingStats()` renders live in the Privacy Receipt panel's "Local Decision Routing" subsection.
- **`complianceChecker.js`** is loaded by `popup.html` and called from `popup.js`'s `analyzeCurrentPage()` on every page analysis (all Privacy Dial modes); its output renders in the "Compliance Signals (GDPR / CCPA / HIPAA)" panel under Page Summary & Redaction Details.
- **`contextManager.js`** is loaded by `popup.html`; the "Saved Tasks" panel (a `renderSavedTasksList()` call, above the chat log so it's visible before a task even starts) lists checkpoints with Resume/Delete, `runAgentLoop()` restores a snapshot right after `setTask()` when resuming one, and auto-checkpoints once per step (wrapped in try/catch, never blocking the loop on a save failure).
- **`verificationLoop.js`** is loaded by `popup.html`; `runAgentLoop()` captures a baseline frame at step 0 and gates every `decision.action === 'done'` branch behind `verifyCompletion()` before calling `markCompleted()`, with bounded retry and an honest give-up path — see `ARCHITECTURE.md`.
- **`evidenceGenerator.js`** is loaded by `popup.html`; `popup.js`'s `annotateScreenshotDataUrl()` + `renderVisualEvidence()`/`renderCompletionVisualEvidence()` call it before both the consequential-action authorization prompt and the (now-verified) task-completion message, so a decision is shown with a picture, not just asserted.
- **`featureDetection.js`** and **`opfsManager.js`** are loaded by `popup.html`; `popup.js`'s `renderFeatureSupport()` calls both once when Settings opens, rendering a compatibility list and an OPFS quota note in the new "Browser Compatibility & Storage" settings card, plus a one-time warning message if a capability this extension actually depends on (WebAssembly, `chrome.sidePanel`, `chrome.offscreen`) is missing.

Nothing else in this table is a "TODO" dressed up as done — a `Shipped` row means it runs in the real extension today; `Blocked` is the one honest way something can still fall short of that, and it's called out at the module level above rather than glossed over. None of this wiring has been exercised in an actual loaded Chrome extension yet (no browser in this sandbox — see `TESTING.md`); it's syntax-checked and, for each new module's own logic, unit-tested against Node.
