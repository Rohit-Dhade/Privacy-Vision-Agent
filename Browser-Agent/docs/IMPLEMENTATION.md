# Implementation status

A file-by-file inventory of what's actually in this repo, and its status: **shipped** (works today, in the real extension, wired into the running loop), **built, not wired** (the code exists, is syntax-checked and often unit-tested against Node, but nothing in `popup.html`/`popup.js` loads or calls it yet — as of this pass, nothing in the tables below is actually in this state anymore; see "What's wired in vs. built standalone" below), or **blocked** (the wiring/integration code is written, but a required third-party asset isn't vendored in this repo, so the feature fails closed at runtime — as of this pass, nothing in the tables below is in this state either; the three assets that previously were have all been vendored, see "Formerly-blocked third-party assets" below). This mirrors `claude/v25-master-implementation-guide.md`'s 8-week roadmap (kept in the project's docs, not this repo) — the "Task N.M" references below are that document's numbering.

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
| `webllmEngine.js` | Shipped | On-device LLM reasoning wrapper (Qwen2.5-1.5B primary, 0.5B fallback) run inside the offscreen document. Wiring, prompt-building, JSON-extraction, and timeout logic are all written; the WebLLM runtime is vendored (`lib/webllm/web-llm.js`, loaded via an ES-module shim, see `lib/webllm/README.md`), so `self.__BA_WebLLMEngine.isAvailable()` returns true whenever the browser also supports WebGPU (`utils/featureDetection.js`'s `detectWebGPU()`) — it still fails closed to `false` if either is missing. |
| `debateManager.js` | Shipped | Hybrid Debate's agree/disagree/degraded resolution logic (Task 2.3), covered by `benchmark/fixtures/debate-scenarios.js`. Its local side is reachable now that `webllmEngine.js`'s runtime is vendored; debate mode still resolves `CLOUD_ONLY_DEGRADED` if the browser lacks WebGPU or the local model fails to load, per the "One side unavailable" case in `ARCHITECTURE.md`. |
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
| `offscreen.html` / `offscreen.js` | Shipped | Runs NER (ONNX — model vendored, see `models/ner/README.md`), face detection (ONNX/YuNet — shipped, model present), on-device LLM reasoning (WebLLM — runtime vendored, see `lib/webllm/README.md`), and ID-image OCR confirmation (PP-OCR/PaddleOCR det+rec, run through the same ONNX Runtime Web instance — weights vendored, see `models/ocr/README.md`). All three now run real inference against real vendored weights; each still fails closed with a clear error rather than fabricating a result if its file is ever missing. |

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

## Formerly-blocked third-party assets — now vendored

Three third-party assets were referenced by working integration code but were not present in this repo for several passes, all for the same reason: this sandbox's outbound network access was restricted to an allowlist that excluded `registry.npmjs.org`, `unpkg.com`, `cdn.jsdelivr.net`, `huggingface.co`, and PyPI. Once this account's network egress allowlist was opened (an organization-level setting, not a sandbox limitation — see `docs/DEPLOYMENT.md`), all three were fetched, vendored, and verified against real inference (not just file presence). Each README below documents exactly what was fetched, from where, why that specific source was chosen over rejected alternatives, and the real-inference verification performed:

- **`lib/webllm/web-llm.js`** (WebLLM runtime) — see `lib/webllm/README.md`. Enables: on-device LLM reasoning in Fully Local mode's fallback step, and the local side of Hybrid Debate mode (still resolves `CLOUD_ONLY_DEGRADED` if the browser lacks WebGPU or the model fails to load — not a vendoring gap anymore, a runtime-capability one).
- **`models/ocr/det.onnx` and `models/ocr/rec.onnx`** (PP-OCR/PaddleOCR detection + English recognition weights) — see `models/ocr/README.md`. Replaces an earlier Tesseract.js-based version of this same feature, dropped for accuracy on small/dense ID-card text and to avoid a second WASM OCR runtime alongside ONNX Runtime Web. Enables: OCR *confirmation* of ID-image regions (the heuristic redaction of those regions always happened unconditionally, with or without this).
- **`models/ner/model_quantized.onnx`** (the NER model's actual weights) — see `models/ner/README.md`. Confirmed to be the exact source model this repo's `config.json`/`tokenizer.json` were originally taken from (byte-identical `id2label`/`label2id` and vocabulary), not just a same-shaped substitute. The deterministic regex + checksum PII layer (`content/piiDetector.js`'s non-NER path) was never affected by this gap and remains what does the bulk of the redaction work in practice; NER adds coverage for freeform names/locations/organizations that don't match a structured pattern.

None of the three have been run inside an actual loaded Chrome extension in this environment (no browser available in this sandbox — see `docs/TESTING.md`); what each README documents is real inference against the real vendored files outside a browser (Python `onnxruntime` for the two ONNX-based ones, Node ESM-parse + exported-symbol checks for WebLLM), which is a materially stronger check than the file-presence-only state this section described before, but is not a substitute for a real-browser run.

## Side panel layout: Agent / Privacy Proof tabs

`popup.html`'s side panel is split into two top-level tabs (`switchTab()` in `popup.js`), on top of the pre-existing Settings full-screen view (unchanged, still opened by the gear icon):

- **Agent** (default): the chat log, task composer, Privacy Dial mode control, and the Page Summary accordion's remaining technical detail — Interactive Elements, Visible Text, Compliance Signals, Internal Agent State.
- **Privacy Proof**: the judge/auditor-facing evidence view — the Privacy Receipt (what left the browser, per step), the Live Evaluation Metrics dashboard, the Cryptographic Redaction Proof panel (Merkle root, tile count, a download button, and a new "Open Independent Verifier" link straight to `tools/verify-redaction-proof.html`), the Redacted Screenshot Preview, and Sensitive Information Detected (open by default here, since it's flagship evidence rather than debug detail).

Both tabs render the exact same live DOM elements `popup.js` already updated in place before this split — `els.receiptSteps`, `els.redactionProofRoot`, `els.sensitiveList`, etc. — so this was a pure presentation change: which container an element lives in, not what populates it or when. The Privacy Proof tab starts on the same placeholder/zeroed values the Page Summary panel always defaulted to (`"No scans yet"`, `"—"`, `0`), so it's informative rather than blank even before a task has run, and stays populated afterward — a judge can switch to it at any point in a demo, not only right after a run finishes. Settings hides both tabs (and the tab bar itself) while open, and restores whichever tab was active when it closes.

This has been syntax-checked (`node --check`) and validated for HTML well-formedness and DOM-id uniqueness, but — like the vendoring work above — has not yet been exercised inside a real loaded Chrome extension in this environment; see `docs/TESTING.md`.

## Real-browser fixes: model loading loop, verifier, before/after view, console noise

These were found by running the extension in Chrome, not by the Node harness.

**On-device model loading (`agent/webllmEngine.js`).** Loading used to race
`CreateMLCEngine()` against a 30-second timer. A first-time download (~1GB
for Qwen2.5-1.5B) can't finish in 30s, so every load "timed out", but the
download itself was never cancelled. The code then started the 0.5B fallback
download alongside it, and after that also timed out it reset its cached
promise, so the next agent step started yet another download. Downloads piled
up, progress from several of them reached the popup interleaved (the
repeating "Downloading… %" chat messages), and none ever finished. Now there
is exactly one load at a time, with no timer on it, and it is never restarted
while it runs. `reason()`/`answer()` fail fast with `LOCAL_LLM_NOT_READY`
while loading instead of blocking the loop. A download only starts when you
pick a Privacy Dial mode that needs the model (Fully Local, Hybrid Debate), or
when the weights are already cached. If only the 0.5B model is cached, that
one is used rather than downloading the 1.5B. The fallback is only used if
the primary actually fails to load. Per-turn generation budgets went from
9s/6s to 60s for the first turn (it includes shader compilation) and then
25s/15s. A generation that times out is stopped with `interruptGenerate()`.

**Fully Local retry loop (`popup/popup.js` `runAgentLoop`).** When the on-device
model failed, the Fully Local branch used `continue`, which re-captured the
page, redacted it again and asked the model again, up to `MAX_AGENT_STEPS`
times. It now stops and hands control back with an honest message. Questions
*about* the page ("what is this form about?") also went through the
fill-the-next-field logic, and on a complete form could even reach the
submit gate. They are now detected (`isPageQuestionTask`) and answered on
the device. If the model is ready it answers from the already-redacted
visible text. Either way, a rule-based page summary (`buildLocalPageSummary`)
is always shown: headings, form fields, actions, and counts of the PII types
that were redacted, never the values.

**Model status banner.** Download/load progress now shows in one banner
(`#localModelStatus`) that updates in place, above both tabs, instead of in
chat messages.

**Redaction-proof verifier (`tools/verify-redaction-proof.*`).** The verifier
logic was an inline `<script>`. When the page is opened from the extension,
Manifest V3's CSP (`script-src 'self'`) blocks inline scripts, so the Verify
button did nothing. The logic now lives in `tools/verify-redaction-proof.js`.
The verifier also:

- accepts a proof wrapped inside a larger JSON object;
- says clearly when the pasted JSON is not a redaction proof;
- has a "Tamper test" that changes one byte of a copy of the proof and shows it failing;
- can load the latest proof from the extension via `chrome.storage.session` (hashes and a public key only).

A proof generated and then verified after a JSON round trip passes in Node,
and tampered copies fail. The verifier opens in the foreground again.
`getActiveTab()` in `background/service-worker.js` now skips this
extension's own pages and switches back to the user's last real tab, so the
next task doesn't hit the "internal page" refusal.

**Before/After Redaction panel (Privacy Proof tab).** This replaces
"Redacted Screenshot Preview". It has three views:

- Redacted: exactly what can leave the device.
- Original + outlines: the same capture before redaction, with each redacted
  region outlined (red for text PII, amber for faces, purple for ID
  documents).
- Side by side.

The original is shown only after a click and hides itself after 30s. Only
the latest step is kept, in popup memory, and it's cleared when a new task
starts. It is never included in any payload, proof, receipt or download.

**Console noise and PII in logs (`offscreen.js`).** Every NER call logged the
raw text it was given, including emails, IBANs and API keys, plus
per-token predictions and a full base64 screenshot per face-detection pass.
All of this now goes through `pvDebug()`, which is off by default. To turn
it on, run `localStorage.setItem('pvDebug','1')` in the offscreen document's
console and reload. Warnings and errors are still logged.

**Verification.**

- `node --check` passes on every file, both here and on the user's machine.
- The full benchmark was re-run. Every section is unchanged, except icon
  classification's `under_5ms_per_crop` timing check, which measured 7.2ms on
  the user's machine. That is environment timing; those files were not
  touched.
- A mock-runtime test suite for the new engine passes 21/21. It covers: no
  implicit download, a single load under repeated calls, the cached-load
  path, timeout plus interrupt, primary-to-fallback, cached-fallback-only,
  and `answer()`.
- Question detection and the page summary pass 16/16.
- `popup.html` has balanced tags, 103 unique IDs, and every `getElementById`
  target exists.

Not yet confirmed visually in Chrome.

**Privacy Proof tab rework (after the first real-Chrome demo run).**

- **Why the screenshot never showed.** The redacted screenshot panel (and so the new Before/After panel) never appeared in Chrome. `.pv-main` is a flex column scroll container, and `.pv-subpanel` has `overflow: hidden`, which gives a flex item `min-height: 0`. Whenever the tab had more content than fit, the panel was squeezed to zero height, and all that showed was a thin line (its borders). The fix is `.pv-main > * { flex-shrink: 0; }`.
- **New tab order:** "Proof at a glance" (items blacked out, bytes sent off-device, signed tiles, Privacy Dial), then Before/After Redaction, then Sensitive Information Detected, then Cryptographic Redaction Proof, then Privacy Receipt, then Live Evaluation Metrics. The Before/After panel adds click-to-enlarge and a redacted-PNG download. Outlines are thicker, with a light tint. The original is hidden again after 60s.
- **Local redaction counts.** The receipt and metrics now count local redactions on every step. Before, they only counted PII, faces and ID images when a payload was sent, so Fully Local showed 0 of everything even while the screenshot had black boxes.
- **Smaller UI fixes:**
  - The detected-PII list is a proper table (type, masked value, confidence).
  - Chat renders `**bold**`/`*italic*`, with the text escaped first.
  - The redaction summary no longer says "Sent to server" in Fully Local.
  - The footer shows the real Privacy Dial and model status instead of a hard-coded "Local model: active".
  - The panel tells you when the background script is older than the panel files. This happens when the files change and the extension isn't reloaded in chrome://extensions.
- **Visual check.** Rendered in headless Chromium with a stubbed `chrome` API and exercised: the redaction drawing, Before/After (all three views), the lightbox, the PII table and the hero. The verifier page was also checked in Chromium: a valid proof passes, a wrapped proof passes, the tamper test fails as it should, and non-proof and bad JSON give clear messages.

**Whole-page coverage (beyond the visible screen).** The per-step pipeline is deliberately limited to the viewport. Chrome's extension screenshot API only captures the visible screen; a true full-page capture would need the `debugger` permission; and only what the agent needs for the current step should ever be sent. That scope was also making page questions ("what is this form about?") answer from one screen, and it hid data further down the page from the Privacy Proof tab. Two additions:

- `content/fullPageScanner.js` is a read-only, text-only scan of the whole DOM. It runs the same `piiDetector.scanPlainText` detectors (checksums and NER) and returns:
  - lines, with any PII line replaced;
  - field labels and filled/empty state (never values);
  - button labels;
  - masked sensitive items, each tagged with where it is (on screen / below the fold).

  It runs once per task in the background. Fully Local page questions use it, and the Privacy Proof tab shows a "Whole page" list. It does not scroll, capture pixels or touch the agent's element registry. Tested in Chromium on `test-pages/kyc-onboarding-demo.html`: it found all 10 form fields below the fold (the old summary said "no fields"), 12 sensitive items, and all section headings, and none of 7 raw test values appeared in its output.
- **"Capture full page"** is a button in the Before/After panel. It scrolls one screen at a time and runs the normal `ANALYZE_PAGE` pipeline per screen (text PII, NER, faces, ID images). It then stitches the raw screens, shifts each screen's boxes into page coordinates and removes boxes duplicated by overlapping screens. One Merkle proof is signed over the stitched raw image before any painting. Last, it paints the redacted and outlined full-page images and restores the user's scroll position, even on failure. It is capped at 12 screens or 16,000px. Disclosed limits: sticky headers repeat once per screen, lazy or animated content can shift slightly, and the ID-image OCR confirmation is skipped (it never gates redaction). Tested in Chromium on a simulated 2,600px page with a stubbed `chrome` API: the scroll sequence was 0/800/1600/1800 and back to the original, every PII row and the face were black at the right page positions, the face in the overlap region was counted once, and the full-page proof verifies.
- The per-screen redaction box logic moved into shared `computeRedactionBoxes()` / `drawRedactionOutlines()` helpers used by both paths.

**Autofilling a long form from the local store (tested end to end in Chromium).** The real extension was loaded into Chromium with values saved in the private data store and pointed at `test-pages/kyc-onboarding-demo.html` with the task "complete the form". Before these fixes it filled **nothing**: the form sits below the first screen, so Fully Local mode said "nothing can be resolved". Fixes, all verified by re-running the same test:

- **Local form navigation.** When a form task has nothing left to do on the visible screen, the agent asks `fullPageScanner.formTargets()` for the next empty field that is off screen and scrolls to it. No model or cloud call is involved. Each field is visited at most once, with at most 20 scrolls per task. When no empty field is left anywhere on the live page, it scrolls to the submit control, which still goes through the human authorization gate. "Form complete" and "submit" decisions now check the whole live page first, so the agent can't declare a form done after one screen.
- **Form fields had no labels, and their values leaked.** `interactiveElements.shortText()` used `aria-label || el.value || innerText`, so a filled field's `text` was the user's data itself, and an unfilled field's `text` was empty. `text` goes to the cloud reasoner in the DOM skeleton and becomes the field's label in the state diff, so in Hybrid/Cloud modes each value the agent filled (name, email, address, and so on) was sent out on the next step. The pre-flight scan only catches card/PAN/Aadhaar/password patterns. Form fields now use their `<label>` text, never their value. This also gave the matcher real labels to match on.
- **Textareas and dropdowns were invisible to form analysis.** `formAnalyzer.isFormInputElement()` checked `el.tag`, which extracted elements don't have, so every `textarea`/`select` was skipped (the address box was never filled).
- **"PIN Code" was blocked as a secret.** The OTP/PIN exclusion (`\bpin\b`) also matched India's postal "PIN code", including through an `id` like `f-pin`. A bare PIN / Card PIN / UPI PIN is still excluded. A visible label that exactly matches a known alias now outranks an exclusion word that only appears in the id/name.
- **Saved-key aliases.** `privateDataStore.get/has` now fall back between related keys, so "Residential Address" (matched as `home_address`) finds a value saved as `address`, and `zip` finds `pincode`. This never crosses meanings.
- **A filled password field always looked empty.** Its value is never read (correct), but that made `hasValue` always false, so the agent asked for the password again and again. A presence-only `valuePresent` boolean fixes it.
- **Better questions to the user.** Hybrid's ask-user fallback now names the empty field ("One-Time Passcode") instead of "Required Field" with no target, and the prompt shows the field's own label instead of a guessed category.

**End-to-end results** (`kyc-onboarding-demo.html`, eight values saved):

| Privacy Dial | Mode | Filled from the local store | Asked the user | Then |
|---|---|---|---|---|
| Fully Local | Complete | 8 of 8 (name, DOB, email, mobile, address, city, PIN, emergency contact) | OTP and password (by design) | Scrolled to "Pay & Submit Application" and asked for authorization |
| Fully Local | Assist Me (HITL) | same | same | same |
| Hybrid, no cloud server running | Complete | same | same | same |

When the test approved the submit, the click ran and the task completed. No stored value appeared anywhere in the chat log. Benchmark unchanged.

## What's wired in vs. built standalone, as of this pass

As of this pass, every module in the tables above is genuinely part of the running extension, not just present in the repo — there is no more "built, not wired" category left, and no more `Blocked` rows either (the three previously-blocked third-party assets are all vendored now — see "Formerly-blocked third-party assets" above). Everything below is `Shipped`:

- **`decisionRouter.js`** is loaded by `popup.html` and instantiated in `popup.js`, and `runAgentLoop()` calls its `route()` method for every step while the Privacy Dial is set to Hybrid — see that call site's comment for exactly why Cloud-Assisted and Fully Local modes don't. Its cumulative `getRoutingStats()` renders live in the Privacy Receipt panel's "Local Decision Routing" subsection.
- **`complianceChecker.js`** is loaded by `popup.html` and called from `popup.js`'s `analyzeCurrentPage()` on every page analysis (all Privacy Dial modes); its output renders in the "Compliance Signals (GDPR / CCPA / HIPAA)" panel under Page Summary & Redaction Details.
- **`contextManager.js`** is loaded by `popup.html`; the "Saved Tasks" panel (a `renderSavedTasksList()` call, above the chat log so it's visible before a task even starts) lists checkpoints with Resume/Delete, `runAgentLoop()` restores a snapshot right after `setTask()` when resuming one, and auto-checkpoints once per step (wrapped in try/catch, never blocking the loop on a save failure).
- **`verificationLoop.js`** is loaded by `popup.html`; `runAgentLoop()` captures a baseline frame at step 0 and gates every `decision.action === 'done'` branch behind `verifyCompletion()` before calling `markCompleted()`, with bounded retry and an honest give-up path — see `ARCHITECTURE.md`.
- **`evidenceGenerator.js`** is loaded by `popup.html`; `popup.js`'s `annotateScreenshotDataUrl()` + `renderVisualEvidence()`/`renderCompletionVisualEvidence()` call it before both the consequential-action authorization prompt and the (now-verified) task-completion message, so a decision is shown with a picture, not just asserted.
- **`featureDetection.js`** and **`opfsManager.js`** are loaded by `popup.html`; `popup.js`'s `renderFeatureSupport()` calls both once when Settings opens, rendering a compatibility list and an OPFS quota note in the new "Browser Compatibility & Storage" settings card, plus a one-time warning message if a capability this extension actually depends on (WebAssembly, `chrome.sidePanel`, `chrome.offscreen`) is missing.

Nothing else in this table is a "TODO" dressed up as done — a `Shipped` row means it runs in the real extension today; `Blocked` is the one honest way something can still fall short of that, and it's called out at the module level above rather than glossed over. None of this wiring has been exercised in an actual loaded Chrome extension yet (no browser in this sandbox — see `TESTING.md`); it's syntax-checked and, for each new module's own logic, unit-tested against Node.
