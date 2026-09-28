# Privacy — technical detail behind CONSTITUTION.md

`CONSTITUTION.md` is the plain-language, publicly readable version of what this extension will and won't do, with each rule pointing at the file that enforces it. This document is the technical layer underneath it: exact patterns, exact allowlists, exact storage locations, and an honest accounting of what's checksum-validated versus merely format-matched. Where the two documents could be read as disagreeing, `CONSTITUTION.md` is the authoritative plain-language statement and this document explains the mechanism behind it — nothing here loosens anything it says.

## What data leaves the browser, and when

The only function in the entire codebase that makes an outbound network request is `agent/agentBackend.js`'s `decideNextAction()`. It has a hard guard — independent of any caller — that refuses to run at all when the Privacy Dial is set to `local`. Every other reasoning path (`decideNextActionLocalOnly`, `decideNextActionLocalLLM`) either does pure local computation or sends one internal `chrome.runtime.sendMessage` to this extension's own offscreen document, which never touches the network.

That said, `manifest.json`'s Content Security Policy (`connect-src http://localhost:* https://*`) is an allowlist *ceiling*, not an enforcement mechanism — it permits any HTTPS host, it does not itself confirm that only `agentBackend.js` calls out. The "one network call" claim is a code-discipline convention backed by the hard guard described above, not something the manifest's CSP narrows on its own. If you're auditing this claim, verify it by grep for `fetch(` across the codebase (as of this writing, `agentBackend.js`'s `decideNextAction()` and `isAvailable()` are the only two call sites, plus the models this repo fetches at load time via `chrome.runtime.getURL` — those are local extension resources, not third-party network calls) rather than trusting the CSP shape alone.

### Privacy Dial modes, exactly

| Mode | What actually happens |
|---|---|
| `local` (Fully Local) | Zero network requests carrying page data. `decideNextAction()` refuses to run. Field-filling is deterministic (`fieldMatcher.js`) with an on-device-LLM fallback (`webllmEngine.js`, run inside the offscreen document — the WebLLM runtime is vendored, see `lib/webllm/README.md`) that also never sends page data over the network, provided the browser supports WebGPU. One caveat worth stating plainly: the *first* time that LLM fallback actually runs, WebLLM fetches its model weights (not vendored — ~800MB, see `docs/DEPLOYMENT.md`) from MLC-AI's model CDN and caches them in OPFS; that one-time download carries no page/task data, only the model itself, and every run after the first is fully offline. |
| `hybrid` | Every step goes through `agent/decisionRouter.js`'s `route()`: an exact local field match (TREE), then a looser local match (HEURISTIC), then the on-device LLM (LOCAL_LLM) — all zero network requests — and only calls `decideNextAction()` (CLOUD) when none of those three could confidently answer. How often each layer actually fires is shown live in the Privacy Receipt panel's routing-stats line, per task. |
| `cloud` | Calls `decideNextAction()` directly and unconditionally, every step, with no local-first attempt — by design, for maximum-capability comparison against the cloud reasoner. |
| `debate` | Makes the *same* `decideNextAction()` call `cloud` always makes and `hybrid` makes on its CLOUD layer, in parallel with a local-LLM attempt, purely to compare the two and show disagreement, on every step. This is explicitly **not** a more private mode than `cloud` — its privacy profile for that call is identical, and unlike `hybrid` it never skips the cloud call. Use `local` if the goal is zero cloud contact. |

Whatever the mode, every payload actually sent goes through two independent layers before it leaves: `agent/privacyBoundary.js`'s `sanitizeOutboundPayload()` (structural allowlist filtering — see below) and then `assertSafeForTransmission()` (a hard pre-flight regex re-scan that throws, aborting the send, if anything unredacted is still found). Both outcomes — sent, or blocked — are recorded and shown live in the Privacy Receipt panel, including the exact sanitized payload text.

## The structural allowlists (`agent/privacyBoundary.js`)

Nothing outside these exact key lists reaches the network, regardless of what any upstream module happens to attach to an object:

- **Element keys**: `id, tag, type, selector, box, sensitive, redactionTag, hasValue, text, ariaLabel, placeholder, enabled, visible, isSearch, isPagination, inModal, inNav, isSticky, formId, options, radioGroup, accept, multiple, isUntrustedPromptInjection, inferredLabel, visuallyPainted`.
- **History entry keys**: `action, targetSelector, elementId, fieldName, value, result, outcome, matchedKey, authorizedByUser, plan, extractedData` — and even within that, `value` is forced to the literal string `'[REDACTED]'` unless it's one of a handful of permitted placeholder tokens (`null`, `undefined`, `''`, `'[REDACTED]'`, `'[FILLED_FROM_LOCAL]'`, `'[ALREADY_POPULATED]'`). A real value can never appear in a history entry sent to the cloud.
- **Top-level request keys**: `sessionId, taskInstruction, capturedAt, screenshot, domSkeleton, redactionMap, actionHistory, stateDiff, userInteractions, formSummary, pageContext, taskPlan, taskMemory, visualState`.
- **Visual-state keys**: `isLoading, hasBlockingOverlay, overlayConfidence, analyzed`, plus `loadingRegion`/`dialogRegion` reduced to bare `{x,y,width,height}` numbers. `unpaintedElementIds` and `frameDelta.changedBounds` are explicitly never forwarded — they stay local.

On top of the allowlist, every element's `text`/`placeholder`/`ariaLabel` is regex-scanned for the same adversarial PII patterns described below (replaced with `'[REDACTED_PII]'` on a match) and for prompt-injection attempts — "ignore previous instructions," "you are now unrestricted/jailbroken," "reveal ... credentials," "click this button immediately," and similar — which are defanged to `'[UNTRUSTED_CONTENT_DEFANGED: Prompt Injection Blocked]'` with `isUntrustedPromptInjection: true` set on the element, so page content designed to manipulate the reasoning model is neutralized before it ever reaches it.

`assertSafeForTransmission()`'s final pre-flight check is narrower than the full detection layer below — it only re-checks for `CREDIT_CARD`, `PAN_CARD`, `AADHAAR`, and `PASSWORD_FIELD` patterns (`getCheckedPatternNames()` returns exactly this list, and the UI displays this same list so it can't silently drift from what's actually enforced). It is a last-resort net on the fully-serialized payload, not a replacement for the richer per-field detection that already ran upstream in `content/piiDetector.js`.

## PII detection — type table

`content/piiDetector.js` runs two parallel detection pipelines (DOM text nodes with bounding boxes, and plain-text field values) using the same underlying patterns and validators. Every type below is disclosed accurately as checksum-validated or format-only — a format-only type is still detected and redacted, it's just not cryptographically certain the way a checksum match is.

| Type | Jurisdiction | Validation | Notes |
|---|---|---|---|
| `CARD` | Global | Luhn | 13–19 digits |
| `AADHAAR` | India | Verhoeff | 12 digits, first digit 2–9 |
| `PAN` | India | Format + category letter | No public checksum; 4th letter constrained to valid holder-category letters |
| `IBAN` | ~70 countries | ISO 7064 mod-97-10 | |
| `MRZ_PASSPORT` / `MRZ_PASSPORT_NAME` | Global (ICAO 9303) | Check-digit validated | Redacts both the passport-number line and the name line |
| `SSN` | USA | SSA exclusion rules (area/group/serial) | No public check digit exists; requires the hyphenated `###-##-####` grouping |
| `UK_NINO` | UK | Format only | Excludes HMRC's published invalid prefixes (`BG, GB, NK, KN, TN, NT, ZZ`) |
| `EU_VAT` | EU (27 states) | Germany: ISO 7064 mod-11-10. All other member states: format only | Disclosed per-match via a `checksummed` flag |
| `CHINA_ID` | China | GB 11643-1999 weighted-sum mod-11 | 18-digit resident ID, including the `X` check character |
| `JAPAN_MYNUMBER` | Japan | Official weighted check-digit formula | 12-digit Individual Number |
| `BRAZIL_CPF` | Brazil | Standard two-check-digit algorithm | Explicitly rejects all-same-digit sequences, a known false-pass in naive implementations |
| `MEXICO_CURP` / `MEXICO_RFC` | Mexico | Format only | CURP's real check digit depends on name/birthdate this detector can't reconstruct |
| `CANADA_SIN` | Canada | Luhn (reuses `luhnCheck`) | |
| `AU_TFN` | Australia | ATO weighted-sum mod-11 | |
| `AU_ABN` | Australia | ISO 7064-style weighted-sum mod-89 | ATO's own published example ABN is used as the fixture test vector |
| `IPV4` | — | Format | |
| `SECRET_TOKEN` | — | Shannon-entropy + known-prefix heuristics | e.g. `sk-`, `ghp_`, `AKIA`, JWTs |
| `EMAIL`, `PHONE` | — | Format | `PHONE` runs last and skips any range a more specific checksum-validated type already claimed |

**One inherent ambiguity, documented rather than hidden**: `CANADA_SIN` and `AU_TFN` are both bare 9-digit numbers with no distinguishing prefix. A number that happens to satisfy both checksums at once (roughly 1-in-100 for a random draw) is labeled by whichever detector runs first (`CANADA_SIN`) — the value is still correctly flagged as sensitive and redacted, only the specific country attribution can be wrong in that rare case.

**NER-derived types** (`NAME`, `LOCATION`, `ORGANIZATION`, plus NER's own `EMAIL`/`PHONE`/`CARD`/`IP_ADDRESS`) exist in the code path but require the offscreen ONNX model, whose weights (`models/ner/model_quantized.onnx`) are not present in this repo — see `IMPLEMENTATION.md`. The regex/checksum layer above is unaffected by this and does the actual redaction work today.

## Compliance signal detection (`agent/complianceChecker.js`)

This is pattern matching over already-extracted page text and link targets — never a legal determination. It runs on every page analysis (all Privacy Dial modes) and its score and violation list render live in the "Compliance Signals" panel under Page Summary & Redaction Details (see `IMPLEMENTATION.md`). It can tell you whether a cookie-consent banner, a privacy-policy link, or a "Do Not Sell My Personal Information" link is present on the page in front of it right now. It cannot tell you whether an organization is actually GDPR/CCPA/HIPAA compliant overall — that depends on data processing agreements, retention policies, and what happens to data after submission, none of which page inspection can see.

Signals checked: GDPR (cookie/consent banner presence, privacy-policy link presence, a data-minimization heuristic that flags 3+ distinct high-sensitivity identifier types collected on one page), CCPA (a "Do Not Sell/Share" or "Your Privacy Choices" link, an unsubscribe/marketing-opt-out mechanism), HIPAA (health-related keywords combined with an insecure HTTP connection — high severity — or combined with a high-sensitivity identifier, which is exactly what turns health data into PHI under HIPAA). Every finding carries a severity (`HIGH`/`MEDIUM`/`LOW`) and a plain-language description of the caveat, not a bare pass/fail.

## Where the user's own data actually lives

- **`agent/privateDataStore.js`** — the user's own PII values (name, email, phone, etc.) they've entered for autofill. Stored as one flat key/value dictionary under `chrome.storage.local['pv_private_store']` (falls back to `localStorage` outside an extension context). Never logged (only key names are logged, never values) and structurally excluded from every outbound-payload allowlist above — there is no path from this store to `sanitizeOutboundPayload()`'s output.
- **`agent/privacyDial.js`** — the current mode, `chrome.storage.local['ba_privacy_dial_mode']`.
- **`agent/contextManager.js`** (built, not wired) — cross-task checkpoints (task objective, subgoal titles, action history, page URLs visited — the same category of data `taskMemory.formatContext()` already puts in front of the reasoning model every step, never PII values) in IndexedDB, with an in-memory session-only fallback if IndexedDB can't open. Nothing here makes a network request.
- **Everything else** (task memory, state diffs, form analysis) is in-memory only, for the current popup session, and discarded when it closes.

## Redaction and its cryptographic proof

`content/redactor.js` draws opaque black rectangles over three region sources in the screenshot before it's ever read for transmission: DOM-detected PII, detected faces, and detected ID-document image regions. `utils/merkleProof.js` then lets a third party independently verify that a given redacted screenshot really was derived from one committed original — without ever seeing the original's pixels — via a SHA-256 Merkle tree over 64×64 tiles plus an ECDSA P-256 signature over the manifest (a fresh, session-only signing key; this proves internal pipeline consistency for that run, not a long-term identity or a formal zero-knowledge proof — the file's own comments are explicit about not overclaiming this). `tools/verify-redaction-proof.html` runs that verification standalone, with no dependency on the extension itself, so the claim can be checked rather than taken on faith.

## Everything this document is not

Same caveat as `CONSTITUTION.md`'s own closing section: nothing here is a legal contract, a compliance certification, or a claim of formal verification. It's an accurate index into what the code actually checks, so a change to any of it shows up as a stale line in this file rather than a silent behavioral drift — which is exactly why `IMPLEMENTATION.md`'s "built, not wired" and "blocked" distinctions exist: a module that isn't in the running loop yet provides none of the protection or insight described for it here, however complete its own code and tests are.
