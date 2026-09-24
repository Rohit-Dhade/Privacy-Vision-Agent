/**
 * background/service-worker.js
 *
 * Chrome-Extension-API plumbing:
 *   - open the popup as a detached window (stays open when user clicks
 *     the page — only closes when the user clicks the × close button)
 *   - inject the content-script bundle into the active tab
 *   - ask it to run the (entirely local) extraction pipeline
 *   - capture the visible-tab screenshot
 *   - lazily create + relay messages to the offscreen document that
 *     hosts the local NER model (see offscreen/offscreen.js)
 *   - forward click/type/scroll action requests into the page
 *   - hand results back to the popup, which renders/redacts them and
 *     talks to the backend agent API (agent/agentBackend.js)
 *
 * The ONLY outbound network call anywhere in this extension happens in
 * agent/agentBackend.js, and only ever carries already-redacted data.
 * Nothing in this file makes a network request.
 */

// ── Side Panel management ─────────────────────────────────────────────────────
// Using the Chrome Side Panel API (Chrome 114+) instead of a popup or a
// detached window. The side panel is embedded in the browser chrome itself —
// it is NEVER dismissed by clicking on the web page, only by the user
// explicitly closing it via the × button or the panel handle.
//
// openPanelOnActionClick: true  →  Chrome opens/closes the panel
// automatically when the toolbar icon is clicked, so we don't need an
// onClicked listener at all for basic open/close.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[BA] sidePanel.setPanelBehavior failed:', err));

// ─────────────────────────────────────────────────────────────────────────────

const CONTENT_SCRIPT_FILES = [
  'utils/logger.js',
  'utils/geometry.js',
  'utils/selectors.js',
  'utils/i18nLabels.js',
  'content/visibility.js',
  'content/interactiveElements.js',
  'content/iconCandidateDetector.js',
  'content/textExtractor.js',
  'content/piiDetector.js',
  'content/idImageDetector.js',
  'content/coordinateMapper.js',
  'content/domExtractor.js',
  'content/semanticDomBuilder.js',
  'content/content.js'
];

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  return tab;
}

async function ensureContentScriptInjected(tabId) {
  // allFrames: a payment iframe's card number is painted into the very same
  // screenshot as the top document, so a scan that only runs in the top
  // frame leaves it undetected and unredacted. See mergeFrameExtractions().
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: CONTENT_SCRIPT_FILES
  });
}

/**
 * Folds every frame's extraction into one top-level result.
 *
 * Each frame reports coordinates in its OWN viewport. The screenshot is in
 * the top frame's coordinates, so every subframe box has to be shifted by
 * that frame's offset before it can be used as a redaction rectangle — get
 * this wrong and the black box lands somewhere harmless while the card
 * number stays perfectly readable.
 *
 * Three cases, in order of how much is known:
 *
 *   top frame            offset (0,0); used as the base result
 *   same-origin subframe knows its own offset; boxes translated exactly
 *   cross-origin subframe cannot know where it is on screen, so nothing it
 *                        found can be placed. Instead the WHOLE frame
 *                        rectangle — which the parent can always measure —
 *                        is redacted whenever that frame reported anything
 *                        sensitive. Coarse, and deliberately so: the failure
 *                        mode is "too much is blacked out", never "PII was
 *                        transmitted".
 *
 * Element ids are re-namespaced per frame so two frames cannot collide, and
 * subframe elements are marked so the agent knows an action on them has to
 * be dispatched into that frame.
 */
function mergeFrameExtractions(frameResults) {
  const usable = frameResults.filter((r) => r && r.result && r.result.viewport);
  if (usable.length === 0) return null;

  const topEntry = usable.find((r) => r.result.frame && !r.result.frame.isSubframe) || usable[0];
  const merged = topEntry.result;
  merged.frames = { total: usable.length, subframes: 0, unlocatable: 0 };

  const shift = (bbox, dx, dy) => ({
    x: Math.round(bbox.x + dx), y: Math.round(bbox.y + dy),
    width: Math.round(bbox.width), height: Math.round(bbox.height)
  });

  for (const entry of usable) {
    if (entry === topEntry) continue;
    const sub = entry.result;
    const f = sub.frame || {};
    if (!f.isSubframe) continue;
    merged.frames.subframes++;

    const frameTag = `f${entry.frameId != null ? entry.frameId : merged.frames.subframes}`;

    if (!f.offsetKnown) {
      // Cannot place anything from this frame. Fail safe: if it saw anything
      // sensitive, black out every cross-origin child frame rect the top
      // document can see. We cannot attribute which one it was, so all of
      // them go — losing some screenshot fidelity is the acceptable side of
      // this trade.
      merged.frames.unlocatable++;
      const sawSomething = (sub.sensitiveItems || []).length > 0 ||
                           (sub.idImageRegions || []).length > 0;
      if (sawSomething) {
        for (const child of (merged.childFrames || [])) {
          if (child.sameOrigin) continue;
          merged.sensitiveItems.push({
            type: 'CROSS_ORIGIN_FRAME_CONTENT',
            masked: '[CROSS-ORIGIN FRAME REDACTED]',
            confidence: 0.6,
            bbox: child.bbox,
            elementId: null,
            note: 'A cross-origin frame reported sensitive content but cannot ' +
                  'report its own position, so the whole frame is redacted.'
          });
        }
      }
      continue;
    }

    const dx = f.offsetX || 0;
    const dy = f.offsetY || 0;

    for (const item of (sub.sensitiveItems || [])) {
      if (!item.bbox) continue;
      merged.sensitiveItems.push({ ...item, bbox: shift(item.bbox, dx, dy), frameId: entry.frameId });
    }
    for (const region of (sub.idImageRegions || [])) {
      if (!region.bbox) continue;
      merged.idImageRegions.push({ ...region, bbox: shift(region.bbox, dx, dy), frameId: entry.frameId });
    }
    for (const el of (sub.elements || [])) {
      if (!el.bbox) continue;
      merged.elements.push({
        ...el,
        id: `${frameTag}:${el.id}`,
        bbox: shift(el.bbox, dx, dy),
        frameId: entry.frameId,
        inSubframe: true
      });
    }
    for (const cand of (sub.iconCandidates || [])) {
      if (!cand.bbox) continue;
      merged.iconCandidates.push({
        ...cand,
        elementId: `${frameTag}:${cand.elementId}`,
        bbox: shift(cand.bbox, dx, dy),
        frameId: entry.frameId
      });
    }
  }

  merged.counts = {
    interactiveElements: merged.elements.length,
    sensitiveItems: merged.sensitiveItems.length,
    idImageRegions: merged.idImageRegions.length
  };
  return merged;
}

async function runExtractionInTab(tabId) {
  // chrome.scripting.executeScript automatically awaits a Promise
  // returned from the injected function, so domExtractor.js's now-async
  // pipeline (NER round-trip included) works transparently here.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (window.__BA ? window.__BA.runFullExtraction() : null)
  });
  return mergeFrameExtractions(results);
}

/**
 * Captures the visible tab, respecting Chrome's undocumented-but-real rate
 * limit on captureVisibleTab.
 *
 * Chrome caps calls at roughly two per second per window and rejects the
 * excess with MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. This never used to
 * surface because a single analysis pass took about 1.4 seconds, so the
 * agent could not physically ask often enough to trip it. After the NER
 * round-trip fix cut extraction by an order of magnitude, the limit started
 * being hit — the performance work turned a latent bug into a live one, and
 * the perf harness found it immediately.
 *
 * Unhandled, this had exactly the failure shape as the face-detection bug in
 * round 14: a rejected promise propagating out of performAnalysis() and
 * killing the whole step. So it backs off and retries rather than throwing,
 * and only gives up after a few attempts.
 */
async function captureScreenshot(tab) {
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || String(err);
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg)) throw err;
      // The quota is per second, so a short wait is all that is needed.
      const waitMs = 350 * (attempt + 1);
      console.warn(`[background] Screenshot rate-limited by Chrome; retrying in ${waitMs}ms ` +
                   `(attempt ${attempt + 1}/${MAX_ATTEMPTS}).`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function performAnalysis() {
  const tab = await getActiveTab();
  const isSupported = /^https?:/.test(tab.url || '');

  // If current page is an unsupported/internal page (e.g. chrome://newtab, about:blank),
  // return clean metadata indicating unsupported scheme so the agent can evaluate navigation.
  if (!isSupported) {
    return {
      isUnsupportedScheme: true,
      url: tab.url || 'about:blank',
      tabId: tab.id
    };
  }

  /*
   * Inject the content scripts.
   */
  await ensureContentScriptInjected(tab.id);

  /*
   * Extract DOM + PII information.
   */
  const extraction =
    await runExtractionInTab(tab.id);

  /*
   * Capture the screenshot.
   */
  const screenshotDataUrl =
    await captureScreenshot(tab);

  console.log(
    "[background] Screenshot captured:",
    typeof screenshotDataUrl,
    screenshotDataUrl?.substring(0, 30)
  );

  /*
   * Run YuNet on the SAME screenshot.
   *
   * detectFacesInScreenshot() sends the screenshot to the offscreen
   * document, which loads the ONNX runtime and the YuNet model.
   *
   * This is wrapped rather than awaited bare, and the reason matters.
   * Previously a rejection here propagated straight out of
   * performAnalysis(), which meant ANY failure to initialise the face
   * model killed the entire page analysis — no DOM extraction, no PII
   * detection, no redaction, no agent. That is the wrong failure mode:
   * face detection is one of several redaction inputs, and losing it
   * should not cost the user everything else. It was found by the
   * first real-browser end-to-end run (benchmark/e2e/), where the ORT
   * WASM binary was unavailable and the whole agent died with
   * "no available backend found" instead of degrading.
   *
   * But it must not degrade SILENTLY either, because faces are
   * privacy-relevant: reporting an empty list is indistinguishable from
   * "this page genuinely contains no faces", and that difference decides
   * whether an un-redacted face reaches the cloud reasoner. So a failure
   * is reported explicitly as faceDetectionAvailable:false and surfaced
   * to the user in the Privacy Receipt, where the popup treats it as a
   * degraded privacy state rather than a clean scan.
   */
  let faces = [];
  let faceDetectionAvailable = true;
  let faceDetectionError = null;
  try {
    faces = await detectFacesInScreenshot(screenshotDataUrl);
  } catch (err) {
    faceDetectionAvailable = false;
    faceDetectionError = err && err.message ? err.message : String(err);
    console.warn(
      '[background] Face detection unavailable — continuing WITHOUT face redaction. ' +
      'Text/PII redaction and the rest of the pipeline are unaffected, but the user ' +
      'is told this scan is degraded. Reason:',
      faceDetectionError
    );
  }

  console.log('[background] Detected faces:', faces.length,
    faceDetectionAvailable ? '' : '(face detection UNAVAILABLE)');

  /*
   * Return EVERYTHING to popup.
   */
  return {
    isUnsupportedScheme: false,
    extraction,
    screenshotDataUrl,
    faces,
    faceDetectionAvailable,
    faceDetectionError,
    tabId: tab.id
  };
}

async function performAction(action, args) {
  const tab = await getActiveTab();

  // If action is navigation, execute via chrome.tabs.update directly
  // (works on all tabs including internal browser pages like chrome://newtab).
  if (action === 'navigate' && args && args[0]) {
    await chrome.tabs.update(tab.id, { url: args[0] });
    return { success: true, navigatingTo: args[0] };
  }

  const isSupported = /^https?:/.test(tab.url || '');
  if (!isSupported) {
    throw new Error('Cannot execute DOM actions on an unsupported internal browser page.');
  }

  await ensureContentScriptInjected(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (actionName, actionArgs) => window.__BA[actionName](...actionArgs),
    args: [action, args]
  });
  return result;
}

// --- Offscreen document management (hosts the local NER model) ---

let creatingOffscreenPromise = null;

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
    return contexts.length > 0;
  }
  // Older Chrome fallback.
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS'], // local ML inference; adjust if your build uses a different reason
    justification: 'Runs a local NER model to detect names/PII entities without any network call.'
  });
  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function forwardToOffscreen(text) {
  await ensureOffscreenDocument();
  // IMPORTANT: chrome.runtime.sendMessage() broadcasts to every extension
  // context (background, popup, offscreen document). Without a `target`
  // discriminator, this service worker's own listener below would also
  // try to handle the message it just forwarded to itself, racing
  // against the offscreen document's real response. Every listener in
  // this file checks `message.target` up front and bails out
  // immediately for anything not addressed to it — the standard pattern
  // for talking to an offscreen document.
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'RUN_NER_INFERENCE', text });
}

async function runIdImageOcr(screenshotDataUrl, regions, viewport) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        target: 'offscreen',
        type: 'RUN_ID_IMAGE_OCR',
        screenshot: screenshotDataUrl,
        regions: regions || [],
        viewport
      },
      (response) => {
        if (chrome.runtime.lastError) {
          // Non-fatal: OCR is a confirmation layer only. The heuristic
          // idImageRegions still get redacted either way (see redactor.js) —
          // this just fails to add the "confirmed by OCR" evidence.
          console.warn('[BA] ID-image OCR message failed:', chrome.runtime.lastError.message);
          return resolve([]);
        }
        if (!response || !response.ok) {
          console.warn('[BA] ID-image OCR error:', response?.error);
          return resolve([]);
        }
        resolve(response.results || []);
      }
    );
  });
}

async function detectFacesInScreenshot(
  screenshotDataUrl
) {

  await ensureOffscreenDocument();

  return new Promise(
    (resolve, reject) => {

      chrome.runtime.sendMessage(
        {
          target: 'offscreen',
          type: 'RUN_FACE_DETECTION',
          screenshot:
            screenshotDataUrl
        },
        (response) => {

          if (
            chrome.runtime.lastError
          ) {
            reject(
              new Error(
                chrome.runtime.lastError.message
              )
            );
            return;
          }

          if (
            !response ||
            !response.ok
          ) {
            reject(
              new Error(
                response?.error ||
                'Face detection failed.'
              )
            );
            return;
          }

          resolve(
            response.faces || []
          );
        }
      );
    }
  );
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore anything addressed to the offscreen document — let its own
  // listener (offscreen/offscreen.js) handle it instead. Without this
  // guard, this same handler would also fire for messages this service
  // worker forwards to itself via chrome.runtime.sendMessage() below.
  if (message.target === 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'ANALYZE_PAGE': {
          const data = await performAnalysis();
          sendResponse({ ok: true, data });
          break;
        }
        case 'AGENT_ACTION': {
          const result = await performAction(message.action, message.args || []);
          sendResponse({ ok: true, data: result });
          break;
        }
        case 'START_OBSERVING': {
          const tab = await getActiveTab();
          await ensureContentScriptInjected(tab.id);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__BA.startObserving()
          });
          sendResponse({ ok: true });
          break;
        }
        case 'RUN_NER_INFERENCE': {
          // Relayed here from content/piiDetector.js (running inside the
          // page's isolated world, which cannot talk to the offscreen
          // document directly) to the offscreen document that hosts the
          // model, and the response relayed straight back.
          const response = await forwardToOffscreen(message.text || '');
          sendResponse(response || { ok: false, error: 'No response from offscreen document.' });
          break;
        }
        case 'RUN_FACE_DETECTION': {
          const faces =
            await detectFacesInScreenshot(
                message.screenshot
            );

          console.log(
            "[background] YuNet faces:",
            faces
            );

          sendResponse({
            ok: true,
            faces: faces
            });
          break;
        }
        case 'RUN_ID_IMAGE_OCR': {
          // On-device OCR confirmation pass for id-image regions flagged
          // by content/idImageDetector.js's heuristic (keywords + aspect
          // ratio). Runs entirely in the offscreen document via a
          // locally-vendored Tesseract.js build — no network call, same
          // privacy boundary as the NER/face models. See offscreen.js.
          const results = await runIdImageOcr(
            message.screenshotDataUrl,
            message.regions,
            message.viewport
          );
          sendResponse({ ok: true, results });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

