/**
 * lib/webllm/web-llm-loader.mjs
 *
 * Thin ES-module shim bridging the vendored WebLLM runtime onto the
 * `self.webllm` global `agent/webllmEngine.js` expects.
 *
 * Why this exists: @mlc-ai/web-llm ships no UMD/IIFE browser-global
 * build — its package.json is `"type": "module"`, `"main": "lib/index.js"`,
 * with nothing else in `exports`/`browser`/`unpkg`/`jsdelivr`. A plain
 * `<script src="lib/webllm/web-llm.js">` (this extension's convention for
 * every other vendored library, e.g. lib/ort.min.js) would throw a syntax
 * error the moment the parser hits that file's top-level `export {...}`
 * statement — `export` is only legal inside a module. Converting
 * `agent/webllmEngine.js` itself to a module was the other option
 * (`lib/webllm/README.md`'s originally-anticipated fallback), but that
 * would mean rewriting its two `self.webllm.*` references to a bare
 * `import` and touching a file with its own detailed non-trivial header
 * comment for a one-line reason. This shim is smaller and changes nothing
 * about the rest of the codebase's plain-<script>-tag convention.
 *
 * Timing: loaded as `<script type="module">` in offscreen.html, so this
 * file executes deferred — after the document finishes parsing, which is
 * AFTER the classic `<script src="agent/webllmEngine.js">` tag below it
 * has already been parsed and evaluated. That's fine: webllmEngine.js
 * only reads `self.webllm` from inside functions (`isAvailable()`,
 * `loadEngine()`), never at top-level script-evaluation time, and those
 * functions are only ever actually called later, in response to a
 * chrome.runtime message — long after the whole document (including this
 * deferred module) has finished loading. See webllmEngine.js's own header
 * comment for the message-driven call chain.
 */
import * as webllm from './web-llm.js';

self.webllm = webllm;
