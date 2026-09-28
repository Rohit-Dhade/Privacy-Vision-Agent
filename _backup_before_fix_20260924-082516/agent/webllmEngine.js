/**
 * agent/webllmEngine.js
 *
 * The on-device reasoning engine for Fully Local mode and the "local"
 * side of Hybrid Debate mode, per claude/v25-master-implementation-guide.md
 * (Part 1 v23/v24 pivot, Part 2 Mode 1 & Mode 3, Part 3 Task 1.1/1.2/2.1).
 *
 * Runs Qwen2.5-1.5B-Instruct (WebLLM/MLC-AI pre-compiled q4f16 build),
 * falling back to Qwen2.5-0.5B-Instruct if the primary model doesn't
 * respond within PRIMARY_TIMEOUT_MS on the device it's running on. WebLLM
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
  const PRIMARY_TIMEOUT_MS = 9000;   // v25 spec: primary reasoning target is 3-7s
  const FALLBACK_TIMEOUT_MS = 6000;  // v25 spec: fallback target is 2-3s
  const MAX_ELEMENTS_IN_PROMPT = 40; // keep the local prompt small — this model has no vision, text-only DOM summary

  let enginePromise = null;
  let activeModelId = null;

  function isAvailable() {
    return typeof self !== 'undefined' && typeof self.webllm !== 'undefined' &&
      typeof self.webllm.CreateMLCEngine === 'function';
  }

  function broadcastProgress(modelId, report) {
    try {
      chrome.runtime.sendMessage({
        target: 'popup',
        type: 'WEBLLM_INIT_PROGRESS',
        modelId,
        progress: report && typeof report.progress === 'number' ? report.progress : null,
        text: report && report.text ? report.text : '',
      });
    } catch (_) {
      // Popup may not be open to receive this — never fatal, purely informational.
    }
  }

  async function loadEngine(modelId, timeoutMs) {
    if (!isAvailable()) {
      throw new Error(
        'WebLLM runtime not vendored (lib/webllm/web-llm.js missing). See lib/webllm/README.md.'
      );
    }
    const createPromise = self.webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => broadcastProgress(modelId, report),
    });
    const engine = await Promise.race([
      createPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`WEBLLM_LOAD_TIMEOUT(${modelId})`)), Math.max(timeoutMs, 30000))),
      // Model *loading* (first-run download or OPFS read) is allowed a much
      // longer budget than a single *reasoning* turn — 30s floor regardless
      // of the per-turn timeout passed in, since a cold OPFS read alone can
      // take longer than one reasoning turn is allowed to.
    ]);
    activeModelId = modelId;
    return engine;
  }

  function ensureEngine() {
    if (!enginePromise) {
      enginePromise = loadEngine(PRIMARY_MODEL_ID, PRIMARY_TIMEOUT_MS).catch((primaryErr) => {
        console.warn('[webllmEngine] Primary model unavailable, trying fallback:', primaryErr.message);
        return loadEngine(FALLBACK_MODEL_ID, FALLBACK_TIMEOUT_MS).catch((fallbackErr) => {
          enginePromise = null; // let the next call retry from scratch rather than caching a permanent failure
          throw fallbackErr;
        });
      });
    }
    return enginePromise;
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
   * @param {{task:string, elements:Array, history:Array, url:string, timeoutMs?:number}} args
   * @returns {Promise<{action:string,targetSelector:?string,value:?string,confidence:number,reasoning:string,modelId:string}>}
   */
  async function reason({ task, elements, history, url, timeoutMs } = {}) {
    const engine = await ensureEngine();
    const prompt = buildUserPrompt({ task, elements, history, url });
    const perTurnTimeout = timeoutMs || (activeModelId === FALLBACK_MODEL_ID ? FALLBACK_TIMEOUT_MS : PRIMARY_TIMEOUT_MS);

    const genPromise = engine.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const result = await Promise.race([
      genPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('LOCAL_LLM_REASONING_TIMEOUT')), perTurnTimeout)),
    ]);

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
      modelId: activeModelId,
    };
  }

  root.__BA_WebLLMEngine = {
    isAvailable,
    reason,
    ensureEngine,
    PRIMARY_MODEL_ID,
    FALLBACK_MODEL_ID,
  };

})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
