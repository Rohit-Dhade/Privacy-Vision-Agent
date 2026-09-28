# Privacy-Vision-Agent — Agent Constitution

**Version 1.1.0** — effective as of this build. Shown in-product in the Privacy Receipt panel as `Policy vX.Y.Z`, so if this document's version ever changes, the change is visible from inside the extension itself, not just in this file. Whenever a rule below changes in a way that affects what the agent will or won't do, the version number changes too (see **Versioning rule**, at the end).

**What changed in 1.1.0:** added a 4th Privacy Dial position, Hybrid Debate (`agent/debateManager.js`), and an on-device LLM reasoning fallback for Fully Local mode (`agent/webllmEngine.js`, run inside `offscreen.js`). Both are new autonomous capabilities, so this is a minor version bump per the **Versioning rule** below — no existing protection was loosened or removed. See the new **Hybrid Debate mode** and **On-device LLM reasoning** entries below.

This is a plain-language, publicly readable statement of exactly what this browser agent will and will not do on its own, and what always requires you to say yes first. It exists so that "trust the extension" isn't the only option — every rule below names the specific file that enforces it, so the claim can be checked against the actual code, not just this description of it.

## What the agent will NEVER do autonomously

1. **It will never submit a payment, place an order, delete or cancel anything, publish anything publicly, or approve/accept a binding agreement without your explicit, per-action confirmation.** Every one of these is detected by `agent/consequentialActionDetector.js` before any click happens, and routed through a fixed 9-step authorization protocol (`popup/popup.js`'s `authorizeAndExecuteConsequential`): stop, re-observe the live page, verify the target still exists, explain exactly what it's about to do and why, ask you directly, bind that specific yes to that specific action and target, re-verify the target hasn't changed while it waited for you, execute only then, and immediately invalidate that authorization so it can never be silently reused for a second action.

2. **It will never fill a password field on your behalf.** `agent/fieldMatcher.js` explicitly excludes password-type fields from its matching logic — there is no code path that lets a password value be looked up or filled automatically, regardless of mode.

3. **It will never send your raw, unredacted screen or unredacted personal data anywhere — including to the cloud reasoning backend.** Faces and detected ID-document images are blacked out in the screenshot before it's ever read for transmission (`popup/popup.js`'s `drawRedactedScreenshot`), and every PII value found in the page (`content/piiDetector.js`) is replaced with a masked placeholder in the structural data sent onward. `agent/privacyBoundary.js` runs a second, independent adversarial scan on the exact bytes about to be sent and hard-aborts the request if anything unredacted is found — a blocked transmission is recorded and shown to you in the Privacy Receipt panel as proof the check ran, not just an assumption that it did.

4. **It will never contact the cloud reasoning backend at all while the Privacy Dial (`agent/privacyDial.js`) is set to Fully Local.** This isn't a preference the agent tries to honor — `agent/agentBackend.js`'s `decideNextAction()`, the single function in the entire extension that makes a network request, refuses to run at all in this mode, independent of what any calling code does.

5. **It will never treat an already-filled field as something to overwrite**, or guess at a value for a field it isn't confident about — an unmatched or low-confidence field always becomes a direct question to you (`ask_user`), never a guess.

## What the agent WILL do, and how you stay informed

- It will always show you, live, what it detected as sensitive on the page and what it redacted, before and while acting (the Privacy Receipt panel), including the exact sanitized payload that crossed — or was blocked from crossing — the network boundary.
- It will always let you generate a downloadable, independently-verifiable cryptographic proof (`utils/merkleProof.js`, verified with `tools/verify-redaction-proof.html`) that a given screenshot really was redacted as claimed, rather than asking you to take the claim on faith.
- It will always tell you which Privacy Dial position is active and let you change it — Cloud-Assisted, Hybrid, or Fully Local — from Settings, with the tradeoff of each spelled out in plain language in the product itself.
- When it needs information it can't resolve locally, it will always ask you directly, highlight exactly which field on the real page it means, and explain in the field-guide callout what's being asked for and why — including, where a translated version exists, in Hindi or Marathi (`utils/i18nLabels.js`) rather than English only.
- Before autofilling anything into a page, it will always check that page against the trust/phishing gate (`agent/trustGate.js`) and pause for your explicit override if the destination looks unfamiliar or suspicious.

## Hybrid Debate mode

When the Privacy Dial is set to **Hybrid Debate**, every step runs the on-device reasoner (Qwen2.5, via `agent/webllmEngine.js`) and the cloud reasoner (`agent/agentBackend.js`'s `decideNextAction()`) in parallel and compares them (`agent/debateManager.js`). This changes what you are shown, never what is allowed to happen autonomously:

- If they agree, the higher-confidence framing is used with no further fuss.
- If they disagree, the evidence panel always shows both decisions, both confidence scores, and the disagreement gap — a wrong or uncertain decision is visible and explainable, not hidden behind a single answer.
- Every existing rule in this document still applies to whichever side's action is chosen — a disagreement never bypasses the consequential-action confirmation protocol, the sensitive-field `ask_user` guard, or any other rule above. Debate adds transparency; it does not add autonomy.
- This mode makes the same one cloud call `decideNextAction()` already made in Cloud-Assisted/Hybrid modes, so its privacy profile for that call is identical to Cloud-Assisted's — it is not a privacy-preserving mode by itself. Choose Fully Local instead if you need the cloud reasoner never contacted at all.

## On-device LLM reasoning (Fully Local mode)

Fully Local mode's local reasoning is no longer limited to deterministic field-matching alone. When `agent/fieldMatcher.js` cannot confidently resolve the next field, Fully Local mode now asks the on-device Qwen2.5 model (`agent/webllmEngine.js`) before falling back to asking you directly. This still makes **zero requests to the cloud reasoning backend** — the model runs inside this extension's own offscreen document, and the only message involved is an internal `chrome.runtime` call to that same document, never a `fetch()` to any server. `agent/agentBackend.js`'s hard network guard on `decideNextAction()` is unchanged and still never runs in this mode.

The one genuine network dependency is a one-time model weight download (a few hundred MB, fetched once from the model provider and cached in this browser's OPFS storage) the first time a device uses Fully Local or Hybrid Debate mode — after that first download, no further network access is needed for local reasoning, on that device, ever. The extension tells you when this download is happening (a progress message in the chat log) rather than doing it silently. See `lib/webllm/README.md` for exactly what is downloaded and from where.

## What this document is not

This is not a legal contract, a certification, or a claim of formal verification. It's a plain-language index into the specific source files that already implement each rule, written so a person without a law degree or a CS degree can still check what's actually true about this software, and so that a change to any of these behaviors is visible as a version bump here rather than a silent behavioral drift.

## Versioning rule

The version number at the top of this file increases whenever a change to the code alters what's listed above — a new autonomous capability, a loosened restriction, or a changed default all bump at least the minor version; anything that removes a protection listed here bumps the major version. Cosmetic edits to this document's wording alone do not require a version bump. The Privacy Receipt panel always shows the version currently in effect for the build you're running, so if it ever differs from what you remember, that's your signal to re-read this file before continuing to trust the agent with anything sensitive.
