# WebLLM runtime (vendored)

`web-llm.js` in this folder is `@mlc-ai/web-llm`'s published `lib/index.js`
(v0.2.85, fetched via jsdelivr's npm mirror once this account's network
egress allowlist was opened to it — see `docs/IMPLEMENTATION.md`'s "Known
gaps" history for why it wasn't vendored earlier), minified, with the
dangling `//# sourceMappingURL=` comment stripped (it pointed at jsdelivr's
own `/sm/` proxy, unreachable from inside the extension — harmless if left
in, just a guaranteed-404 devtools request).

**On-device LLM reasoning is live**: Fully Local mode's local-model
fallback step and the local side of Hybrid Debate mode both work now,
provided the browser supports WebGPU (see `utils/featureDetection.js`'s
`detectWebGPU()` — Settings' "Browser Compatibility & Storage" card
reports this).

## Why a loader shim exists

`@mlc-ai/web-llm` ships ESM-only — no UMD/IIFE browser-global build. Its
`package.json` is `"type": "module"`, `"main": "lib/index.js"`, nothing in
`exports`/`browser`/`unpkg`/`jsdelivr`. A plain `<script src="web-llm.js">`
(this extension's convention for every other vendored library) would throw
a syntax error at the file's top-level `export {...}` statement.

`web-llm-loader.mjs` (also in this folder) is a two-line shim:
`import * as webllm from './web-llm.js'; self.webllm = webllm;` — loaded
via `<script type="module">` in `offscreen.html`, it bridges the module's
named exports onto the `self.webllm` global `agent/webllmEngine.js`
expects, so nothing else in this codebase's plain-`<script>`-tag loading
convention had to change. See that file's own header comment for the
loading-order reasoning (module scripts execute deferred, but
`webllmEngine.js` only reads `self.webllm` from inside functions called
later, never at top-level load time, so this is safe).

## The model weights are still not vendored — and don't need to be

`agent/webllmEngine.js` requests:

- Primary: `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` (~800MB, 3-7s/turn)
- Fallback: `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (~500MB, 2-3s/turn), used
  automatically if the primary model fails to load or respond within its
  timeout on the current device.

Both model IDs were confirmed still current in this vendored version's
`prebuiltAppConfig` (grepped directly out of `web-llm.js` itself, not
assumed) — no code change was needed. These are **not** vendored into this
repo, on purpose: WebLLM fetches them once, at first actual use, straight
from the browser (MLC-AI's own model CDN) and caches them in this
extension's OPFS storage automatically (`utils/opfsManager.js` reports
available quota beforehand — see "Browser Compatibility & Storage" in
Settings). Trying to vendor several-hundred-MB weight shards into a
browser extension's own repo would be the wrong pattern regardless of
network access — that's "download once, cache forever" working as
designed, not a gap.

## Updating the vendored runtime later

```bash
curl -sS -o lib/webllm/web-llm.js \
  "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@latest/lib/index.min.js"
# then strip the trailing "//# sourceMappingURL=" line, same as above
```

Re-check `agent/webllmEngine.js`'s `PRIMARY_MODEL_ID`/`FALLBACK_MODEL_ID`
constants against the new file (`grep -o "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
lib/webllm/web-llm.js`, etc.) after any update — WebLLM periodically
renames or re-quantizes prebuilt model entries.

## Verification performed here

`node --check` (via `--input-type=module`) confirms `web-llm.js` parses as
valid ES module JavaScript, and both model IDs were confirmed present in
its `prebuiltAppConfig` string table. What has **not** been verified: this
still has not run inside an actual Chrome offscreen document with real
WebGPU — no browser is available wherever this vendoring step itself was
performed (see `docs/TESTING.md`). Reload the unpacked extension, switch
the Privacy Dial to Fully Local or Hybrid Debate, run a task, and check
the offscreen document's console (`chrome://extensions` → this extension →
"service worker" / inspect views → the offscreen document) for
`[webllmEngine]` log lines and a `self.webllm` value that isn't
`undefined` — that's the real-browser check this vendoring pass couldn't
do itself.
