# API reference

Every module in this extension is a browser-global IIFE (`(function(root){...})(window)` in content/agent/utils code, `self` in offscreen code), attached under a `root.__BA_*` name, with a matching `module.exports` for the handful that also run under Node (via `benchmark/run-benchmark.js` or these modules' own test scripts). Signatures below are as implemented, not aspirational. Where a function has narrower behavior in one Privacy Dial mode, that's noted.

## `agent/agentBackend.js` — `root.__BA_AgentBackend` (class `AgentBackend`)

- `async decideNextAction(payload)` — the one network call in the extension. Throws if `payload.privacyDialMode === 'local'`, independent of the caller. `payload`: `{task, redactedScreenshotDataUrl, elements, viewport, history, pageUrl, sensitiveItems, mode, stateDiff, userInteractions, formSummary, pageContext, taskPlan, taskMemory, privacyDialMode, visualState}`. Sanitizes via `agent/privacyBoundary.js`, records the transmission (success or blocked) for the Privacy Receipt, then POSTs to the configured endpoint. Returns a translated action object.
- `decideNextActionLocalOnly({extraction, formSummary})` — synchronous, deterministic. Finds the first empty, matchable form field via `agent/fieldMatcher.js`; returns `{action:'fill_from_local', elementId, targetSelector, value:null}`, an `ask_user` action, or `{action:'wait', ...}`.
- `async decideNextActionLocalLLM({task, extraction, actionHistory, formSummary, mode})` — sends one internal `chrome.runtime.sendMessage({type:'RUN_WEBLLM_REASON', ...})` (never a `fetch()`), throws if the offscreen document/model isn't available, otherwise returns a translated action plus `{confidence, reasoning, source:'local_llm', modelId}`.
- `async isAvailable()` — HEAD-checks the configured cloud endpoint.
- `async getEndpoint()` / `async setEndpoint(url)` — `chrome.storage.local`-backed.
- `getLastTransmissionSummary()` — the most recent transmission record for the Privacy Receipt panel.
- `buildAskUserAction(el, elementId, targetSelector)`, `findElementByTarget(...)`, `isElementPopulated(el)`, `resolveElementId(...)` — also exposed as static methods on the class.
- `resetSession()` — new session id, clears the last transmission.

## `agent/decisionRouter.js` — `root.__BA_DecisionRouter` (class `DecisionRouter`) — *wired into `popup.js`'s Hybrid-mode step; see `IMPLEMENTATION.md`*

- `constructor({agentBackend, fieldMatcher?, formAnalyzer?, consequentialActionDetector?})`
- `async route({task, extraction, actionHistory, formSummary, cloudArgs, privacyDialMode, mode, localLlmConfidenceFloor=0.5})` → `{decision, routing:{layer, attempts}}`. Escalates TREE → HEURISTIC → LOCAL_LLM → CLOUD → ASK_USER, in that order, stopping as soon as a layer answers confidently; never reaches CLOUD when `privacyDialMode === 'local'`.
- `getRoutingStats()` → `{counts:{TREE,HEURISTIC,LOCAL_LLM,CLOUD,ASK_USER}, total}`; `resetRoutingStats()`.

## `agent/debateManager.js` — `root.__BA_DebateManager` (class `DebateManager`)

- `constructor({agentBackend, confidenceScorer?})`
- `async runDebate({localArgs, cloudArgs, evidence})` → `{decision, debate}`. `debate.mode` is one of `FULL_DEBATE`, `LOCAL_ONLY_DEGRADED`, `CLOUD_ONLY_DEGRADED`; `debate.resolution` (when `FULL_DEBATE`) is one of `AGREE`, `DISAGREE_AUTO_RESOLVE`, `DISAGREE_SHOW_BOTH`, `DISAGREE_ASK_USER_RECOMMENDED`. Throws if both `agentBackend.decideNextActionLocalLLM` and `.decideNextAction` fail, with `.localError`/`.cloudError` on the thrown `Error`.

## `agent/confidenceScorer.js` — `root.__BA_ConfidenceScorer` (static class `ConfidenceScorer`)

- `static score({decision, evidence})` → `{confidence, factors, vulnerabilities}`. `factors`: `modelSelfConfidence, checksumStrength, httpsScore, domainReputation, destinationSafety, piiRarity, contextMatch` — each `null` if the evidence has no opinion, combined via geometric mean of whatever's present. `vulnerabilities` lists factor names scoring below 0.5.

## `agent/complianceChecker.js` — `root.__BA_ComplianceChecker` (static class `ComplianceChecker`) — *wired into `popup.js`'s `analyzeCurrentPage()`*

- `static check({elements, visibleText, sensitiveItems, pageUrl})` → `{score, violations, signals}`. `violations`: array of `{id, law:'GDPR'|'CCPA'|'HIPAA', severity:'HIGH'|'MEDIUM'|'LOW', title, description}`. `score` = `100 - Σ(HIGH:25, MEDIUM:15, LOW:5)` per violation, floored at 0. Every finding is a page-structure/keyword signal, never a legal determination — see the file's own header comment and `PRIVACY.md`.

## `agent/contextManager.js` — `root.__BA_ContextManager` (class `ContextManager`) — *wired into `popup.js`'s "Saved Tasks" panel and `runAgentLoop()`'s checkpoint/resume logic; see `IMPLEMENTATION.md`*

- `async saveCheckpoint(taskId, snapshot)`, `async loadCheckpoint(taskId)`, `async listCheckpoints()` (metadata only, newest-first), `async deleteCheckpoint(taskId)`, `async switchTask(newTaskId, {currentTaskId?, currentSnapshot?})`.
- `isUsingDurableStorage()` — `false` once IndexedDB failed to open and the instance fell back to an in-memory (session-only) `Map`.
- `static buildSnapshotFromLiveState({taskManager, taskMemory, privacyDialMode, lastUrl, label})` / `static applySnapshotToLiveState({taskManager, taskMemory, snapshot})` — read/write `TaskManager`/`TaskMemory`'s public instance fields directly; neither class needed to change.
- `static generateTaskId(taskText)` — slugified text + timestamp.

## `agent/verificationLoop.js` — `root.__BA_VerificationLoop` (class `TaskVerifier` + free functions) — *wired into `runAgentLoop()`'s `done` branch; see `ARCHITECTURE.md`'s "Task-completion verification"*

- `class TaskVerifier` — `captureBaseline(frame)` (stores the pre-task screenshot frame), `reset()`, `verify(input)` (delegates to `verifyCompletion()` below, threading the captured baseline in as `compareFrames()`'s first argument).
- `verifyCompletion({task, actionHistory, visibleText, baselineFrame, currentFrame})` → `{verified, confidence, intent, checks:{productiveAction, structural, visualChange, confirmationText}, reason}`. `checks.productiveAction` is a hard gate — zero productive (non-`wait`/`replan`) actions in the whole task fails verification outright regardless of the other three checks.
- `classifyTaskIntent(taskText)` → `'gather'|'form'|'navigate'|'general'` — reuses the exact intent regexes already in `agent/taskManager.js`'s `decomposeTaskIntoSubgoals()` and `popup.js`'s `isExplicitFormTask`.
- `hasProductiveAction(actionHistory)` → boolean. `hasConfirmationText(visibleText)` → boolean, advisory-only, skips any `[REDACTED` line so it never reads PII.
- `CONFIRMATION_PATTERNS` (~14 regexes: "thank you", "success", "order placed", etc.), `NON_PRODUCTIVE_ACTIONS = new Set(['wait','replan'])`, `FAILING_OUTCOMES = new Set(['FAILED','NO_EFFECT','TARGET_DISAPPEARED'])`, `MAX_VERIFICATION_ATTEMPTS = 2`.

## `agent/evidenceGenerator.js` — `root.__BA_EvidenceGenerator` — *wired into `popup.js`'s `annotateScreenshotDataUrl()` / `renderVisualEvidence()`; see `ARCHITECTURE.md`'s "Evidence generation"*

- `buildAuthorizationHighlights({targetBbox, isReversible, actionType, sensitiveItems})` → highlight array — the consequential-action target (red if irreversible, orange if reversible) plus any still-visible sensitive-item boxes.
- `buildCompletionHighlights({actionHistory, elements, sensitiveItems})` → highlight array — every element actually acted on (green if the action succeeded, red if it failed; deduplicated by element id, first success wins) plus remaining sensitive items.
- `summarizeEvidence({decision, verification, sensitiveItems, highlights})` → `{decision, verification, piiCount, highlightCounts:{safe, danger, ambiguous}}` — the compact object rendered in the evidence card's legend.
- `COLORS = Object.freeze({SAFE:'#16a34a', DANGER:'#dc2626', AMBIGUOUS:'#d97706'})`, `FAILING_OUTCOMES = new Set(['FAILED','NO_EFFECT','TARGET_DISAPPEARED'])`. Pure highlight-selection logic only — this module never touches a Canvas; the actual drawing is `popup.js`'s `annotateScreenshotDataUrl()`, which reuses `content/coordinateMapper.js`'s `mapDomBoxToScreenshot()`.

## `agent/fieldMatcher.js` — `root.__BA_FieldMatcher` (static class `FieldMatcher`)

- `static matchElement(element)` → `{matched, key, confidence:'high'|'medium'|'low'|'none', reason}`. Order: excluded-pattern/password check → exact label/placeholder alias match (`high`) → regex pattern match (`high`) → HTML input-type match (`high`) → fallback regex (`medium`) → no match.
- `static matchElements(elements)` → per-element results.
- `static normalizeText(str)`, `static extractCandidateStrings(el)` — helpers.

## `agent/formAnalyzer.js` — `root.__BA_FormAnalyzer` (static class `FormAnalyzer`)

- `static isFormInputElement(el)` — excludes buttons/submit/reset/hidden.
- `static async analyzeForm(elements, privateDataStore)` → `{formDetected, totalFields, alreadyCompleted, emptyFields, locallyMatchable, requiresUserInput}`.
- `static deriveSuggestion({formSummary, stateDiff, userInteractions, mode, step})` → `{type, message}` or `null`.

## `agent/consequentialActionDetector.js` — `root.__BA_ConsequentialActionDetector`

- `static isConsequentialElement(el, targetSelector, {pageUrl, taskInstruction, pageContext, surroundingText})` → `{isConsequential, actionType:'PAYMENT'|'DELETE'|'CANCEL'|'PUBLISH'|'BOOK'|'SUBMIT'|'APPROVE'|'WORKFLOW_CONTINUE'|null, label, promptMessage, isReversible, riskLevel:'HIGH'|'MEDIUM'|'LOW'}`.

## `agent/privacyBoundary.js` — `root.__BA_PrivacyBoundary`

- `sanitizeElement(element)`, `sanitizeHistoryItem(item)`, `sanitizeVisualState(state)` — per-object allowlist filtering + adversarial/injection defanging.
- `sanitizeOutboundPayload(payload)` — top-level allowlist filter, recursively sanitizing `domSkeleton.elements`, `actionHistory`, `visualState`.
- `assertSafeForTransmission(payload)` — throws `PrivacyBoundaryViolationError` if `CREDIT_CARD`/`PAN_CARD`/`AADHAAR`/`PASSWORD_FIELD` patterns are found in the serialized payload; returns `true` otherwise.
- `getCheckedPatternNames()` → `['CREDIT_CARD','PAN_CARD','AADHAAR','PASSWORD_FIELD']`.

## `agent/privateDataStore.js` — `root.__BA_PrivateDataStore` (class `PrivateDataStore`)

- `async getAll()`, `async getAllKeys()`, `async get(key)`, `async has(key)`, `async set(key, value)`, `async remove(key)`, `async clear()`.
- `static isValueAvailable(val)`.
- Backing store: `chrome.storage.local['pv_private_store']` (one flat dictionary), falling back to `localStorage` outside an extension context.

## `agent/privacyDial.js` — `root.__BA_PrivacyDial`

- `MODES = ['cloud','hybrid','local','debate']`, `DEFAULT_MODE = 'hybrid'`.
- `isValidMode(mode)`, `getModeMeta(mode)` → `{label, shortLabel, description}`.
- `async getMode()` / `async setMode(mode)` — `chrome.storage.local['ba_privacy_dial_mode']`; never rejects, falls back to `DEFAULT_MODE`.

## `agent/trustGate.js` — `root.__BA_TrustGate`

- `evaluate({pageUrl, formAction, elements})` → `{level:'allow'|'warn'|'block', reasons, domain, isHttps, sensitiveCombo}`.
- `getDomain(url)`, `levenshtein(a,b)`, `findImpersonatedDomain(domain)`, `TRUSTED_REFERENCE_DOMAINS` (16 hardcoded Indian gov/banking domains — a look-alike reference list, not an allowlist).

## `agent/visualDomGrounder.js` — `root.__BA_VisualDomGrounder`

- `groundPoint(point, elements, options)` → exact-containment or proximity match (≤45px default), or `{grounded:false}`.
- `fuseVisualWithDom(action, elements, options)` — used by `agentBackend.js`'s `translateAction()`; rejects (`{ok:false}`, original action untouched) an action with visual coordinates that can't be grounded to a real element, rather than executing raw coordinates.

## `agent/stateDiffEngine.js` — `root.__BA_StateDiffEngine`

- `captureState(extraction)` → `{timestamp, url, elementCount, elementMap}` (a `Map`, metadata only).
- `computeDiff(previousState, currentState)` → `{urlChanged, navigationOccurred, previousUrl, currentUrl, addedElements(≤10), removedElements(≤10), changedElements(≤15)}`. **Note:** does not itself set a `hasChanges` boolean — code elsewhere that reads `stateDiff.hasChanges` expects the caller to have added it.
- `formatDiffSummary(diff)` → human-readable bullet lines.
- `sanitizeUrl(urlString)` — strips sensitive-looking query params.

## `agent/stateManager.js` — `root.__BA_StateManager` (class `StateManager`)

- `STATES` (15 values: `IDLE, OBSERVING, UNDERSTANDING, PLANNING, WAITING_FOR_REASONER, VALIDATING_ACTION, EXECUTING_ACTION, VERIFYING_ACTION, WAITING_FOR_USER, WAITING_FOR_CONFIRMATION, REPLANNING, COMPLETED, BLOCKED, FAILED, STOPPED`, plus legacy aliases).
- `canTransition(next)`, `transition(next)` (warns but doesn't hard-block an unlisted transition), `reset()`, `onChange(fn)`.

## `agent/taskManager.js` — `root.__BA_TaskManager` (class `TaskManager`)

- `setTask(taskText, pageContext)`, `get activeSubgoal()`, `advanceSubgoal(reason)`, `recordGatheredInfo(...)`, `recordUserInfo(values)`, `clearCollectedInfo()`, `replan(reason, pageContext)`, `updateProgress({...})`, `getPlanSummary()`, `formatPlanSummary()`.

## `agent/taskMemory.js` — `root.__BA_TaskMemory` (class `TaskMemory`)

- `recordPageVisit(url)`, `recordAttempt(decision)`, `recordResult(decision, verification)`, `recordUserIntervention(fieldIdOrSelector, label)`, `recordConfirmation(action, target, granted)`, `updateSubgoal(desc, isCompleted)`, `reconcileWithLiveState(liveElements, currentUrl, pageContext)`, `getSummary()`, `formatContext()`. Bounded 6-entry recent-action window.

## `agent/actionVerifier.js` — `root.__BA_ActionVerifier` / `root.__BA_OUTCOMES`

- `OUTCOMES`: `SUCCEEDED, NO_EFFECT, FAILED, TARGET_DISAPPEARED, PAGE_CHANGED, TASK_COMPLETED, USER_INTERVENTION_REQUIRED`.
- `static verifyAction({decision, actionResponse, stateDiff, extraction})` → `{outcome, details, shouldReplan, verified}`.

## `agent/recoveryEngine.js` — `root.__BA_RecoveryEngine` (class `RecoveryEngine`)

- `FAILURE_CAUSES` (11), `RECOVERY_STRATEGIES` (7 — `ABORT_TO_USER` is defined but never actually returned; halting is signaled via `shouldHalt:true` instead).
- `detectLoop(candidateAction, stateDiff, currentUrl)` → `{isLoop, type?, description?}`.
- `diagnose({decision, targetEl, liveElements, pageContext, actionResult, currentUrl})` → `{cause, strategy, message, canRetryAutonomously}`.
- `evaluateNextStep(diagnosis)` → halts after `MAX_CONSECUTIVE_FAILURES = 3` or on any non-autonomously-retryable cause.
- `reset()`, `recordSuccess()`.

## `agent/userInputManager.js` — `root.__BA_UserInputManager` (class `UserInputManager`)

- `constructor(container)`
- `renderForm(fields, onSubmit)` — the `ask_user` notice; `onSubmit({})` is called with an **empty object** — the actual typed value is read back by re-observing the DOM, not captured here.
- `renderConfirmation(options, onDecision)` — the consequential-action gate; `onDecision(true|false)`.
- `renderHitlRequest(options, onDecision)` — general HITL request with optional `choices`/`needsTextInput`; `onDecision({resumed:true, choice?, text?})`.
- `clear()`.

## `agent/agentController.js` — `root.__BA_AgentController` (class `AgentController`)

- `startTask`, `beginObserving`, `beginUnderstanding(extractionResult)`, `beginPlanning`, `waitForReasoner`, `beginValidating`, `beginExecuting(action)`, `beginVerifying(action)`, `waitForUser(fields)`, `waitForConfirmation(consequential)`, `triggerReplanning(reason)`, `markCompleted`, `markBlocked(reason)`, `markFailed(err)`, `markStopped(reason)`, `reset()`. Thin wrapper around `StateManager` + `TaskManager`; does not itself call the perception/reasoning/execution pipeline.

## `content/piiDetector.js` — `root.__BA_PiiDetector`

- `async detectSensitiveInfo(textNodes, viewportWidth, viewportHeight)` → `{items, flaggedNodes}` — the main DOM-scan entry point.
- `async scanPlainText(text, fieldLabel)` → `items[]` — non-DOM text scan (used for filled-field values, benchmark fixtures).
- `detectSensitiveUrl(href)` → flagged sensitive query params, or `null`.
- `maskValue(type, text)` → display-safe masked string, per-type.
- Checksum validators, each independently exported: `luhnCheck(digitsOnly)` (cards, Canada SIN), `verhoeffValidate(numStr)` (Aadhaar), `ibanValidate(iban)` (ISO 7064 mod-97-10), `validateMrzLine1(line1)` / `validateMrzLine2(line2)` (ICAO 9303), `ssnValidate(digitsOnly)` (USA), `ukNinoValidate(match)` (format-only), `euVatValidate(match)` (Germany checksummed, others format-only), `chinaIdValidate(match)` (GB 11643-1999), `japanMyNumberValidate(digitsOnly)`, `brazilCpfValidate(digitsOnly)`, `mexicoCurpValidate(match)` / `mexicoRfcValidate(match)` (format-only), `auTfnValidate(digitsOnly)`, `auAbnValidate(digitsOnly)`.
- `looksLikeSecret(token)`, `looksLikePhone(match)`, `shannonEntropy(str)` — secret/phone heuristics.
- `ensureModelLoaded` — no-op resolved promise (NER model loading is handled inside `runNerOnText`, not here).
- See `PRIVACY.md` for the full `PATTERNS` type table and checksum-vs-format-only status per jurisdiction.

## `content/domExtractor.js` — `root.__BA_DomExtractor`

- `async runExtraction()` → `{timestamp, url, viewport, elements, visibleText, sensitiveItems, idImageRegions, iconCandidates, frame, childFrames, pageContext, counts}`.

## `content/interactiveElements.js` — `root.__BA_InteractiveElements`

- `extractInteractiveElements(viewportWidth, viewportHeight)` → `{elements, registry}` (`registry` is a live `Map<id, HTMLElement>`, never serialized). Element record: `{id, type, text, ariaLabel, placeholder, value, href, options, radioGroup, accept, multiple, bbox, selector, visible, enabled, isSearch, isPagination, inModal, inNav, isSticky, formId, formAction}`.

## `content/textExtractor.js` — `root.__BA_TextExtractor`

- `extractVisibleText(viewportWidth, viewportHeight, elementRegistry)` → `[{node, text, bbox, elementId}]`.

## `content/visibility.js` — `root.__BA_Visibility`

- `isElementVisible(el, viewportWidth, viewportHeight)`, `isStyleVisible(el)`, `composedParent(node)`, `composedContains(ancestor, node)`, `deepElementFromPoint(x, y)`.

## `content/coordinateMapper.js` — `root.__BA_CoordinateMapper`

- `mapDomBoxToScreenshot(domBbox, viewport, imageWidth, imageHeight, padding=4)`, `mapScreenshotPointToViewport(point, viewport, imageWidth, imageHeight)`.

## `content/redactor.js` — `root.__BA_Redactor`

- `async redactScreenshot(screenshotDataUrl, sensitiveItems, viewport, padding=4, faceBoxes=[], idImageRegions=[])` → `{canvas, dataUrl}`.

## `content/idImageDetector.js` / `content/iconCandidateDetector.js`

- `detectIdImageRegions(viewportWidth, viewportHeight)` → `[{bbox, reason:'id_keyword_match'|'upload_preview_aspect_match', tag}]`.
- `findUnlabeledIconCandidates(elements, maxCandidates=16)` → `[{elementId, bbox}]`.

## `content/content.js` — `window.__BA`

- `runFullExtraction(taskInstruction)`, `getLastResult()`, `getRecentUserInteractions()`, `click`, `type`/`fill`, `clear`, `check`, `hover`, `focus`, `press_key`, `scroll`, `navigate`, `back`, `forward`, `extract`, `select`, `highlightField`, `clearHighlight`, `startObserving`/`stopObserving`. Invoked directly by the service worker via `chrome.scripting.executeScript({func: ...})`, not via `chrome.runtime` messages.

## `utils/merkleProof.js` — `root.__BA_MerkleProof`

- `async generateRedactionProof(rawCtx, width, height, redactedBboxesPixelSpace, tileSize=64)` → the proof object (`merkleRoot`, `redactedTiles` with inclusion proofs, ECDSA `signature`, `publicKeyJwk`).
- `async verifyRedactionProof(proof)` → `{signatureValid, inclusionProofsValid, tileResults, overallValid}`.
- `tileIndicesForBbox(bbox, tileSize, cols, rows)`, `sha256Hex`, `buildMerkleLevels`, `getInclusionProof`, `recomputeRootFromProof`, `canonicalStringify`.

## `utils/visualStateEngine.js` — `root.__BA_VisualStateEngine`

- `compareFrames(prev, curr, tileSize=16)` → `{comparable, changeRatio, changedBounds, verdict:'no_change'|'localized_change'|'partial_change'|'major_change'}`.
- `detectLoadingIndicator(prev, curr)` → `{isLoading, region, changeRatio, edgeDensity, reason}`.
- `detectBlockingOverlay(imageData, prevImageData=null)` → `{hasBlockingOverlay, confidence:'high'|'moderate'|'none', dialogRegion, ...}`.
- `verifyElementPainted(imageData, box)` → `{painted, confident, variance, edgeDensity, reason}` — fails open (`painted:true, confident:false`) when unmeasurable.
- `analyzeScreenState(currImageData, prevImageData, elementBoxes)` → combined report.
- `deriveVisualDecision(report, lastActionKind)` → `{action:'wait'|'flag_ineffective_action'|'constrain_to_dialog', reason}` or `null`.

## `utils/iconClassifier.js` — `root.__BA_IconClassifier`

- `loadModel(raw)`, `isLoaded()`, `classifyIcon(imageData)` → `{label, confidence, index}` or `null` (never throws), `getMetrics()`.

## `utils/i18nLabels.js` — `root.__BA_I18nLabels`

- `LANGUAGES = {'hi-IN': {...}, 'mr-IN': {...}}`, `getTranslation(langTag, key)`, `getHindi(key)`.

## `utils/featureDetection.js` — `root.__BA_FeatureDetection` — *wired into `popup.js`'s `renderFeatureSupport()`, advisory-only*

- `detectIndexedDB()`, `detectOPFS()`, `detectWebGPU()`, `detectWasm()`, `detectSharedArrayBuffer()`, `detectCrossOriginIsolated()`, `detectChromeSidePanel()`, `detectChromeOffscreen()`, `detectWebLLMLoaded()` — each a boolean, each try/catch-wrapped, each fails closed to `false`.
- `detectAll()` → `{indexedDB, opfs, webgpu, wasm, sharedArrayBuffer, crossOriginIsolated, chromeSidePanel, chromeOffscreen, webllmLoaded, notes}`.
- `summarize(report)` → `string[]` — pure mapping from a capability report to plain-English notes, one per *missing* capability only (an all-good report is an empty array).

## `utils/opfsManager.js` — `root.__BA_OpfsManager` — *wired into `popup.js`'s `renderFeatureSupport()`, advisory-only*

- `isSupported()` → boolean (`navigator.storage.getDirectory` presence).
- `async checkStorageQuota()` → `{supported, usageBytes, quotaBytes, usageRatio, error}` (via `navigator.storage.estimate()`).
- `async fileExists(fileName, dirPath=[])` → boolean — generic OPFS existence check; not a WebLLM cache lookup (see the file's own header comment for why this deliberately doesn't reach into WebLLM's private cache structure). Nothing in this codebase calls this yet.
- `formatQuotaSummary(quota)` → one human-readable status line for the Settings panel.

## `background/service-worker.js` — message router

| `message.type` | Handling |
|---|---|
| `ANALYZE_PAGE` | `performAnalysis()` |
| `AGENT_ACTION` | `performAction(message.action, message.args)` |
| `START_OBSERVING` | injects content scripts, calls `window.__BA.startObserving()` |
| `RUN_NER_INFERENCE` | forwards to the offscreen document, relays the response |
| `RUN_FACE_DETECTION` | `detectFacesInScreenshot(message.screenshot)` |
| `RUN_WEBLLM_REASON` | forwards to the offscreen document, relays the response |
| `RUN_ID_IMAGE_OCR` | forwards to the offscreen document; fails soft to `[]` on any relay error |
| *(guard)* `message.target === 'offscreen'` | ignored (`return false`) — lets the offscreen document's own listener handle it |
| *(guard)* `message.target==='popup' && type==='WEBLLM_INIT_PROGRESS'` | ignored (`return false`) — informational broadcast for the popup's model-download progress UI |
| *default* | `{ok:false, error:'Unknown message type: ...'}` |

## `offscreen.js` — message router (all branches gated on `message.target === 'offscreen'`)

| `message.type` | Handling |
|---|---|
| `RUN_NER_INFERENCE` | `runNerOnText(message.text)` → `{ok, spans}` |
| `RUN_ID_IMAGE_OCR` | `runIdImageOcrBatch(...)` → `{ok, results}` |
| `RUN_WEBLLM_REASON` | `self.__BA_WebLLMEngine.reason({...})` → `{ok, decision}` |
| `RUN_FACE_DETECTION` | `detectFaces(message.screenshot)` → `{ok, faces}` |

## `manifest.json` — permissions and resources

- `permissions`: `activeTab, scripting, storage, offscreen, sidePanel`. No `tabs`, `webRequest`, `cookies`, `history`, or `downloads`.
- `host_permissions`: `<all_urls>` (needed for `chrome.scripting.executeScript` / `captureVisibleTab` on arbitrary sites).
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src http://localhost:* https://*`. Note: this CSP is an allowlist ceiling permitting connections to any HTTPS host — it does not itself restrict outbound calls to only `agentBackend.js`; that's a code-discipline convention, not something this CSP enforces.
- `web_accessible_resources`: `models/ner/*, models/ocr/*, lib/*.js, lib/*.wasm, lib/*.mjs, lib/webllm/*` for `<all_urls>`.
- `content_scripts`: `lib/ort.min.js, content/piiDetector.js`, all frames, `document_idle` — the always-on injection path (see `ARCHITECTURE.md`'s "Two injection paths").
- `minimum_chrome_version`: `114` (required for the side panel API).
