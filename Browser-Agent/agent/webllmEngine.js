/**
 * agent/webllmEngine.js
 *
 * The on-device reasoning engine for Fully Local mode and the "local"
 * side of Hybrid Debate mode, per claude/v25-master-implementation-guide.md
 * (Part 1 v23/v24 pivot, Part 2 Mode 1 & Mode 3, Part 3 Task 1.1/1.2/2.1).
 *
 * Runs Qwen2.5-1.5B-Instruct (WebLLM/MLC-AI pre-compiled q4f16 build),
 * falling back to Qwen2.5-0.5B-Instruct if the primary model fails to load
 * on this device (or if only the 0.5B model is already cached). WebLLM
 * (not ONNX Runtime Web — see v23/v24 for why the earlier ONNX-for-LLM
 * plan was abandoned) does its own autoregressive token generation,
 * KV-cache management, and OPFS model-weight caching; nothing here
 * reimplements any of that.
 *
 * WHERE THIS RUNS: loaded as a plain <script> in offscreen.html, exactly
 * like utils/visualStateEngine.js and the YuNet/NER code already inlined
 * in offscreen.js — an offscreen document has a real `window` and can use
 * WebGPU, which a service worker cannot. offscreen.js's message handlers
 * (RUN_WEBLLM_INIT / RUN_WEBLLM_REASON) are the only callers of this
 * module; agent/agentBackend.js reaches it from the popup via one
 * chrome.runtime.sendMessage() round trip — an internal extension
 * message, never a network request, so it runs identically in every
 * Privacy Dial position, including Fully Local.
 *
 * HONESTY ABOUT "FULLY LOCAL": the very first time a model is used, WebLLM
 * fetches its weight shards over HTTPS from the model provider's CDN and
 * caches them in this origin's OPFS storage. That one-time fetch is a
 * software-installation step (like npm installing a library), not
 * per-step "cloud reasoning" — CONSTITUTION.md's Fully Local guarantee is
 * specifically about agentBackend.js's decideNextAction() (the per-step
 * reasoning call), which this file never touches. Even so, in the spirit
 * of this project's existing transparency (see privacyDial.js's very
 * explicit mode descriptions), initProgressCallback below broadcasts
 * download progress so popup.js can show the user plainly that a
 * one-time model download is happening and why.
 *
 * VENDORED: this file calls the WebLLM runtime through the global
 * `self.webllm`, set by lib/webllm/web-llm-loader.mjs (an ES-module shim
 * around the vendored lib/webllm/web-llm.js — see that folder's README.md
 * for why a shim is needed: @mlc-ai/web-llm ships ESM-only, no UMD/IIFE
 * global build). isAvailable() below still fails closed to `false` if
 * self.webllm is ever missing for any reason (extension loaded from a
 * source tree with lib/webllm/ stripped, a future WebLLM version renaming
 * its export shape, etc.) — every caller degrades gracefully on that:
 * Fully Local mode falls back to asking the user, and Hybrid Debate mode
 * falls back to cloud-only for that step — exactly the same "fail closed,
 * never fail silently" pattern already used for the PP-OCR/PaddleOCR OCR
 * confirmation pass (see models/ocr/README.md). What isAvailable() cannot
 * detect on its own: whether the browser actually supports WebGPU — see
 * utils/featureDetection.js's detectWebGPU(), surfaced in Settings.
 */
(function (root) {

  const PRIMARY_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
  const FALLBACK_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

  // Per-turn generation budgets. v25's 3-7s target assumes a discrete GPU;
  // on the integrated laptop GPUs this actually runs on in practice, a
  // ~1-2k-token prefill regularly takes longer than that, and the very
  // first turn after loading also pays one-time WebGPU shader compilation.
  // The earlier 9s/6s budgets timed out on essentially every first turn.
  const FIRST_TURN_TIMEOUT_MS = 60000;
  const PRIMARY_TIMEOUT_MS = 25000;
  const FALLBACK_TIMEOUT_MS = 15000;
  const MAX_ELEMENTS_IN_PROMPT = 40; // keep the local prompt small — this model has no vision, text-only DOM summary
  const MAX_TEXT_LINES_FOR_ANSWER = 60;

  /*
   * LOADING MODEL (rewritten — see docs/IMPLEMENTATION.md "On-device model
   * loading" for the bug this replaces).
   *
   * Before: loading raced CreateMLCEngine() against a 30s timer. A first-time
   * download (~1GB for the 1.5B model) can never finish in 30s, so the timer
   * always "won" — but the underlying download was never cancelled. The code
   * then started the 0.5B fallback download IN PARALLEL, and after that also
   * timed out it reset its cached promise, so the NEXT agent step started a
   * brand-new 1.5B download on top of the two still running. Every step of
   * the agent loop added more concurrent downloads, the popup received
   * interleaved progress reports from all of them (the "repeating" progress
   * messages), and no load ever completed.
   *
   * Now: there is exactly ONE load in flight at a time, it is never raced
   * against a timer, and it is never restarted while running. reason() and
   * answer() fail FAST with LOCAL_LLM_NOT_READY while the load is still in
   * progress (the caller shows the progress and stops), instead of blocking
   * the agent loop for 30s per step. The load keeps going in the background
   * and the next call after it finishes just works.
   */
  const state = {
    status: 'idle',      // 'idle' | 'loading' | 'ready' | 'error'
    modelId: null,
    progress: 0,         // 0..1, as reported by WebLLM
    text: '',
    error: null,
    turnsCompleted: 0,
  };
  let loadPromise = null;
  let engine = null;
  let busy = false;

  function isAvailable() {
    return typeof self !== 'undefined' && typeof self.webllm !== 'undefined' &&
      typeof self.webllm.CreateMLCEngine === 'function';
  }

  function getStatus() {
    return {
      available: isAvailable(),
      status: state.status,
      modelId: state.modelId,
      progress: state.progress,
      text: state.text,
      error: state.error,
      busy,
    };
  }

  function broadcastStatus() {
    try {
      chrome.runtime.sendMessage({
        target: 'popup',
        type: 'WEBLLM_INIT_PROGRESS',
        ...getStatus(),
      });
    } catch (_) {
      // Popup may not be open to receive this — never fatal, purely informational.
    }
  }

  async function isCached(modelId) {
    try {
      if (typeof self.webllm.hasModelInCache === 'function') {
        return await self.webllm.hasModelInCache(modelId);
      }
    } catch (_) { /* treat as not cached */ }
    return false;
  }

  /** Prefer whatever is already on disk: if only the small fallback model
   *  was ever downloaded, use it rather than kicking off a ~1GB download of
   *  the primary. With nothing cached, download the primary (v25 default)
   *  and only fall back to the smaller model if the primary actually FAILS
   *  (unsupported GPU, out of memory, fetch error) — never on a timer. */
  async function chooseLoadOrder() {
    if (await isCached(PRIMARY_MODEL_ID)) return [PRIMARY_MODEL_ID, FALLBACK_MODEL_ID];
    if (await isCached(FALLBACK_MODEL_ID)) return [FALLBACK_MODEL_ID];
    return [PRIMARY_MODEL_ID, FALLBACK_MODEL_ID];
  }

  function startLoad() {
    if (loadPromise) return loadPromise;
    if (!isAvailable()) {
      state.status = 'error';
      state.error = 'WebLLM runtime not vendored (lib/webllm/web-llm.js missing). See lib/webllm/README.md.';
      broadcastStatus();
      return Promise.reject(new Error(state.error));
    }

    state.status = 'loading';
    state.error = null;
    state.progress = 0;
    state.text = 'Preparing on-device model…';
    broadcastStatus();

    loadPromise = (async () => {
      const order = await chooseLoadOrder();
      let lastErr = null;
      for (const modelId of order) {
        state.modelId = modelId;
        state.progress = 0;
        state.text = `Loading ${modelId}…`;
        broadcastStatus();
        try {
          const created = await self.webllm.CreateMLCEngine(modelId, {
            initProgressCallback: (report) => {
              if (report && typeof report.progress === 'number') state.progress = report.progress;
              if (report && report.text) state.text = report.text;
              broadcastStatus();
            },
          });
          engine = created;
          state.status = 'ready';
          state.progress = 1;
          state.text = `${modelId} ready`;
          state.turnsCompleted = 0;
          broadcastStatus();
          return created;
        } catch (err) {
          lastErr = err;
          console.warn(`[webllmEngine] Loading ${modelId} failed:`, err && err.message ? err.message : err);
        }
      }
      throw lastErr || new Error('No on-device model could be loaded.');
    })().catch((err) => {
      state.status = 'error';
      state.error = (err && err.message) ? err.message : String(err);
      state.text = '';
      loadPromise = null; // allow an explicit retry later (e.g. after the user frees GPU memory)
      broadcastStatus();
      throw err;
    });

    return loadPromise;
  }

  /** Kept for compatibility with existing callers: resolves to the engine,
   *  waiting for the (single, shared) load however long it takes. Only use
   *  this where waiting is actually wanted — the agent loop should not. */
  function ensureEngine() {
    return startLoad();
  }

  function notReadyError() {
    if (state.status === 'error') {
      return new Error(`LOCAL_LLM_UNAVAILABLE: ${state.error || 'model failed to load'}`);
    }
    const pct = Math.round((state.progress || 0) * 100);
    return new Error(
      `LOCAL_LLM_NOT_READY: the on-device model (${state.modelId || PRIMARY_MODEL_ID}) is still loading — ${pct}% ` +
      '(one-time download, cached after this). Try again once it reports ready.'
    );
  }

  /** Common gate for reason()/answer(): never blocks the caller on a
   *  download. A short grace wait (graceMs) covers the fast case where the
   *  weights are already cached and only need a few seconds to warm up. */
  async function requireReadyEngine(graceMs) {
    if (state.status === 'idle' && isAvailable()) {
      // Never start a ~1GB download as a side effect of an ordinary agent
      // step (e.g. Hybrid mode's optional LOCAL_LLM routing layer). The
      // download only starts from an explicit startLoad() — popup.js sends
      // WEBLLM_START_LOAD when the Privacy Dial is set to Fully Local or
      // Hybrid Debate. If the weights are already cached, loading them is
      // cheap, so that case is allowed to proceed here.
      const cached = (await isCached(PRIMARY_MODEL_ID)) || (await isCached(FALLBACK_MODEL_ID));
      if (!cached) {
        throw new Error(
          'LOCAL_LLM_NOT_READY: the on-device model has not been downloaded yet. Select Fully Local or ' +
          'Hybrid Debate in the Privacy Dial to start the one-time download.'
        );
      }
    }
    if (state.status !== 'ready') {
      const p = startLoad();
      p.catch(() => {});
      if (graceMs > 0) {
        await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, graceMs))]);
      }
      if (state.status !== 'ready' || !engine) throw notReadyError();
    }
    if (busy) {
      throw new Error('LOCAL_LLM_BUSY: the on-device model is still finishing a previous request.');
    }
    return engine;
  }

  function turnTimeoutMs(override) {
    if (override) return override;
    if (state.turnsCompleted === 0) return FIRST_TURN_TIMEOUT_MS;
    return state.modelId === FALLBACK_MODEL_ID ? FALLBACK_TIMEOUT_MS : PRIMARY_TIMEOUT_MS;
  }

  async function generate(eng, messages, maxTokens, timeoutMs) {
    busy = true;
    let timer = null;
    try {
      const genPromise = eng.chat.completions.create({ messages, temperature: 0.2, max_tokens: maxTokens });
      const result = await Promise.race([
        genPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`LOCAL_LLM_REASONING_TIMEOUT (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
        }),
      ]);
      state.turnsCompleted++;
      return result;
    } catch (err) {
      // Stop the abandoned generation so it doesn't keep the GPU busy and
      // collide with the next request.
      try { if (typeof eng.interruptGenerate === 'function') eng.interruptGenerate(); } catch (_) {}
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      busy = false;
    }
  }

  const SYSTEM_PROMPT = [
    'You are the on-device reasoning step of a privacy-preserving browser agent.',
    'You run entirely on the user\'s device; nothing you are told here ever leaves it.',
    'You are given the task, a compact list of interactive elements on the current page,',
    'and recent action history. Choose exactly ONE next action.',
    '',
    'Respond with STRICT JSON ONLY, no prose, no markdown fences, matching:',
    '{"action":"click|fill|select|check|uncheck|hover|focus|press_key|scroll|navigate|back|forward|wait|done",',
    '"targetSelector":"<selector from the list below, or null>","value":"<string or null>",',
    '"confidence":0.0-1.0,"reasoning":"<one short sentence>"}',
    '',
    'Rules:',
    '- targetSelector MUST be copied exactly from the element list, or null for actions with no target (wait/done/back/forward/navigate).',
    '- Never invent a selector that was not given to you.',
    '- Never choose "fill" for a field marked sensitive:true — that field is handled outside your reach.',
    '- If nothing in the list moves the task forward, return {"action":"wait",...} with a low confidence.',
    '- confidence must honestly reflect how sure you are, not just be high by default.',
  ].join('\n');

  const ANSWER_SYSTEM_PROMPT = [
    'You are the on-device assistant of a privacy-preserving browser agent.',
    'You run entirely on the user\'s device. You are given the visible text of the',
    'current page, with every line that contained personal data already replaced by',
    '"[REDACTED - sensitive text on this line]". Answer the user\'s question about the',
    'page in at most 5 short sentences, using ONLY the text given. Never guess or',
    'reconstruct redacted values. If the text does not contain the answer, say so.',
  ].join('\n');

  function summarizeElementsForPrompt(elements) {
    const list = Array.isArray(elements) ? elements.slice(0, MAX_ELEMENTS_IN_PROMPT) : [];
    return list.map((el) => {
      const label = el.text || el.ariaLabel || el.placeholder || el.inferredLabel || '(unlabeled)';
      const flags = [
        el.sensitive ? 'SENSITIVE' : null,
        el.hasValue ? 'FILLED' : null,
        el.enabled === false ? 'DISABLED' : null,
      ].filter(Boolean).join(',');
      return `- selector=${JSON.stringify(el.selector || '')} tag=${el.tag || el.type || '?'} label=${JSON.stringify(label)}${flags ? ` [${flags}]` : ''}`;
    }).join('\n');
  }

  function summarizeHistoryForPrompt(history) {
    const list = Array.isArray(history) ? history.slice(-6) : [];
    if (list.length === 0) return '(none yet)';
    return list.map((h) => `- ${h.action}${h.targetSelector ? ` on ${h.targetSelector}` : ''}${h.result && h.result.success === false ? ' (failed)' : ''}`).join('\n');
  }

  function buildUserPrompt({ task, elements, history, url }) {
    return [
      `TASK: ${task || '(no task given)'}`,
      `PAGE: ${url || '(unknown)'}`,
      '',
      'INTERACTIVE ELEMENTS (this step only, already redacted of any real values):',
      summarizeElementsForPrompt(elements) || '(none)',
      '',
      'RECENT ACTION HISTORY:',
      summarizeHistoryForPrompt(history),
      '',
      'Return the single next action as strict JSON now.',
    ].join('\n');
  }

  /** Pulls the first balanced {...} object out of the model's raw text —
   *  small local models sometimes wrap JSON in a sentence or a code fence
   *  despite instructions not to; this is more forgiving than a bare
   *  JSON.parse() on the whole string without accepting arbitrary text. */
  function safeParseJson(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  const ALLOWED_ACTIONS = new Set([
    'click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'focus',
    'press_key', 'scroll', 'navigate', 'back', 'forward', 'wait', 'done',
  ]);

  /**
   * @param {{task:string, elements:Array, history:Array, url:string, timeoutMs?:number, graceMs?:number}} args
   * @returns {Promise<{action:string,targetSelector:?string,value:?string,confidence:number,reasoning:string,modelId:string}>}
   */
  async function reason({ task, elements, history, url, timeoutMs, graceMs = 5000 } = {}) {
    const eng = await requireReadyEngine(graceMs);
    const prompt = buildUserPrompt({ task, elements, history, url });
    const result = await generate(eng, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], 300, turnTimeoutMs(timeoutMs));

    const text = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    const parsed = safeParseJson(text);
    if (!parsed || typeof parsed.action !== 'string' || !ALLOWED_ACTIONS.has(parsed.action)) {
      throw new Error('Local LLM returned an unparseable or disallowed action.');
    }

    return {
      action: parsed.action,
      targetSelector: typeof parsed.targetSelector === 'string' ? parsed.targetSelector : null,
      value: parsed.value === undefined ? null : parsed.value,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      modelId: state.modelId,
    };
  }

  /**
   * Answers a question ABOUT the current page ("what is this form about?")
   * from its already-redacted visible text. Used by Fully Local mode, where
   * no cloud model is ever asked. Same fail-fast readiness rules as reason().
   *
   * @param {{question:string, lines:string[], url:string, timeoutMs?:number, graceMs?:number}} args
   * @returns {Promise<{answer:string, modelId:string}>}
   */
  async function answer({ question, lines, url, timeoutMs, graceMs = 5000 } = {}) {
    const eng = await requireReadyEngine(graceMs);
    const safeLines = (Array.isArray(lines) ? lines : [])
      .filter((l) => typeof l === 'string' && l.trim())
      .slice(0, MAX_TEXT_LINES_FOR_ANSWER)
      .map((l) => `- ${l.trim().slice(0, 200)}`);
    const prompt = [
      `QUESTION: ${question || ''}`,
      `PAGE: ${url || '(unknown)'}`,
      '',
      'VISIBLE PAGE TEXT (personal data already redacted):',
      safeLines.join('\n') || '(no visible text)',
    ].join('\n');
    const result = await generate(eng, [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], 220, turnTimeoutMs(timeoutMs));
    const text = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Local LLM returned an empty answer.');
    return { answer: text.trim(), modelId: state.modelId };
  }

  root.__BA_WebLLMEngine = {
    isAvailable,
    getStatus,
    startLoad,
    reason,
    answer,
    ensureEngine,
    PRIMARY_MODEL_ID,
    FALLBACK_MODEL_ID,
  };

})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
