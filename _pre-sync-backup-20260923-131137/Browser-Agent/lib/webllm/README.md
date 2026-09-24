# Vendoring WebLLM (required for Fully Local reasoning and Hybrid Debate mode)

This extension never loads code from a CDN at runtime (MV3 CSP only
allows `'self'` scripts) — every model/library it uses ships inside the
extension, the same way `lib/ort.min.js` and `models/ner/*` already do
(and `models/ocr/*` will once its own weight files are vendored — see
`models/ocr/README.md`). On-device LLM reasoning
(`agent/webllmEngine.js`, run inside `offscreen.js`) follows that same
pattern, but the actual WebLLM runtime and model weight files aren't
checked into this repo yet and need to be vendored once, locally.

**This is a one-time manual step.** Nothing else in this feature requires
it — if you skip this step:

- **Fully Local mode** still works exactly as before: it fills whatever
  the deterministic field matcher (`agent/fieldMatcher.js`) can resolve
  and asks you directly for everything else. It just won't get the extra
  "ask the on-device Qwen2.5 model before giving up" step described in
  `claude/v25-master-implementation-guide.md`.
- **Hybrid Debate mode** (the 4th Privacy Dial position) falls back to
  cloud-only for every step, with a system message explaining why, instead
  of running the local-vs-cloud comparison.

## Steps

1. From the repo root (needs network access — do this on your own
   machine, not inside any restricted sandbox):

   ```bash
   npm install @mlc-ai/web-llm@latest --no-save
   ```

2. Copy the built ESM bundle from `node_modules/@mlc-ai/web-llm/lib/`
   into this folder (`Browser-Agent/lib/webllm/`) as `web-llm.js`. WebLLM
   ships as an ES module; the simplest drop-in for this project's plain
   `<script>`-tag loading pattern (see `offscreen.html`) is the bundled
   IIFE/UMD build if the package provides one (check
   `node_modules/@mlc-ai/web-llm/lib/index.js` and the package's `exports`
   field for the non-ESM entry point), so that `self.webllm` is exposed as
   a plain global — exactly like `lib/ort.min.js`/`lib/ort.wasm.min.js`
   already are. If only an ESM build is available,
   convert `offscreen.html`'s `<script src="agent/webllmEngine.js">` tag
   (and this one) to `type="module"` and change `agent/webllmEngine.js`'s
   `self.webllm` reference to `import * as webllm from './lib/webllm/
   web-llm.js'` instead.

3. Do **not** try to vendor the Qwen2.5 model weight shards themselves —
   they're multiple hundred-MB files fetched once at first use and cached
   by WebLLM in this extension's OPFS storage automatically (this is the
   same "download once, cache forever" behavior as the rest of this
   project's model handling). `agent/webllmEngine.js` requests:

   - Primary: `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` (~800MB, 3-7s/turn)
   - Fallback: `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (~500MB, 2-3s/turn),
     used automatically if the primary model fails to load or respond
     within its timeout on the current device.

   Confirm both model IDs are still current in MLC-AI's prebuilt model
   list (`https://mlc.ai/models` at the time this was written) — WebLLM
   periodically renames or re-quantizes entries, and `agent/
   webllmEngine.js`'s `PRIMARY_MODEL_ID`/`FALLBACK_MODEL_ID` constants
   will need updating if so.

4. Update `manifest.json`'s `web_accessible_resources` if you rename
   anything from `web-llm.js` (`lib/webllm/*` is already listed).

5. Reload the unpacked extension, switch the Privacy Dial to **Fully
   Local** or **Hybrid Debate**, and run a task. Check the offscreen
   document's console (`chrome://extensions` → this extension → "service
   worker" / inspect views → the offscreen document) for `[webllmEngine]`
   log lines. The first run downloads the model (progress is broadcast to
   the popup as a system message); every run after that loads from OPFS
   with no network call.

## Why this step can't be automated here

The sandbox this code was written in has network access restricted to an
allowlist that does not include `registry.npmjs.org`, `unpkg.com`,
`cdn.jsdelivr.net`, or `huggingface.co` (the same restriction documented
in `models/ocr/README.md`), so neither the WebLLM runtime nor any model
weight file could be downloaded and committed automatically. Everything
else — the message plumbing in `service-worker.js`, the prompt
construction and response parsing in `agent/webllmEngine.js`, the
`agentBackend.decideNextActionLocalLLM()` bridge, the Hybrid Debate
orchestration in `agent/debateManager.js`, and every UI surface for it in
`popup/popup.js` — is already wired up and will start working the moment
this file is present.
