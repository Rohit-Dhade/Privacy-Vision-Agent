/**
 * content/domExtractor.js
 *
 * Ties together visibility.js, interactiveElements.js, textExtractor.js
 * and piiDetector.js into a single extraction pass, and shapes the
 * result into a plain, JSON-serializable object (no live DOM/Text node
 * references) so it can safely cross the boundary out of the page's
 * JS context back to the extension's background/popup contexts.
 */
(function (root) {
  /**
   * Where this frame sits inside the TOP-LEVEL viewport, which is the
   * coordinate space the screenshot is in.
   *
   * This exists because of a measured privacy failure. Content scripts ran
   * only in the top frame, so a card number inside a payment iframe — the
   * normal arrangement on real checkouts; Stripe Elements and Razorpay both
   * work this way — was never detected and never redacted, while being
   * painted into the screenshot that gets transmitted.
   *
   * Detecting it is only half the fix. A box found at (12, 30) inside a
   * frame positioned at (420, 644) must be redacted at (432, 674), or the
   * black rectangle lands somewhere harmless and the number stays readable.
   *
   * Offsets accumulate up the frame chain while each ancestor is
   * same-origin. A cross-origin boundary makes `frameElement` throw, and at
   * that point the frame genuinely cannot know where it is on screen — so it
   * says so, and the merge step falls back to redacting the whole frame
   * rectangle, which the PARENT can always measure. Coarse, but never wrong
   * in the direction that leaks.
   */
  function computeFrameOffset() {
    if (window === window.top) {
      return { isSubframe: false, offsetX: 0, offsetY: 0, offsetKnown: true };
    }
    let offsetX = 0;
    let offsetY = 0;
    let win = window;
    let guard = 0;
    try {
      while (win !== window.top && guard++ < 16) {
        const fe = win.frameElement; // throws when the parent is cross-origin
        if (!fe) {
          return { isSubframe: true, offsetX: 0, offsetY: 0, offsetKnown: false,
                   reason: 'frameElement unavailable' };
        }
        const r = fe.getBoundingClientRect();
        offsetX += r.left;
        offsetY += r.top;
        win = win.parent;
      }
      return { isSubframe: true, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY),
               offsetKnown: true };
    } catch (e) {
      return { isSubframe: true, offsetX: 0, offsetY: 0, offsetKnown: false,
               reason: 'cross-origin ancestor' };
    }
  }

  /**
   * Rects of this frame's own child iframes, in this frame's coordinates.
   * The top frame's list is what makes the cross-origin fallback possible: a
   * parent can always measure where a child frame is, even when the child
   * cannot measure itself.
   */
  function collectChildFrameRects(viewportWidth, viewportHeight) {
    const out = [];
    try {
      document.querySelectorAll('iframe,frame').forEach((f) => {
        const r = f.getBoundingClientRect();
        if (!root.__BA_Geometry.rectIntersectsViewport(r, viewportWidth, viewportHeight)) return;
        let sameOrigin = false;
        try { sameOrigin = !!f.contentDocument; } catch (e) { sameOrigin = false; }
        out.push({
          bbox: { x: Math.round(r.left), y: Math.round(r.top),
                  width: Math.round(r.width), height: Math.round(r.height) },
          sameOrigin,
          src: (f.getAttribute('src') || '').slice(0, 200)
        });
      });
    } catch (e) { /* best effort */ }
    return out;
  }

  function buildViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function extractActiveModal() {
    const dialog = document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]');
    if (!dialog || !root.__BA_Visibility.isElementVisible(dialog, window.innerWidth, window.innerHeight)) return null;
    const heading = dialog.querySelector('h1, h2, h3, h4, [role="heading"], .modal-title, .dialog-title');
    return {
      isOpen: true,
      title: heading ? (heading.innerText || heading.textContent || '').trim().slice(0, 100) : null,
      selector: root.__BA_Selectors ? root.__BA_Selectors.getStableSelector(dialog) : null
    };
  }

  function extractAlerts() {
    const alerts = [];
    document.querySelectorAll('[role="alert"], [aria-invalid="true"], .alert-danger, .error-message, [class*="error" i]').forEach((el) => {
      if (root.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight)) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && text.length > 2 && text.length < 300) {
          alerts.push({ type: 'error', text });
        }
      }
    });
    document.querySelectorAll('[role="status"], .alert-success, .toast-success, [class*="success" i]').forEach((el) => {
      if (root.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight)) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && text.length > 2 && text.length < 300) {
          alerts.push({ type: 'success', text });
        }
      }
    });
    return alerts.slice(0, 5);
  }

  function extractLoadingState() {
    const busy = document.querySelector('[aria-busy="true"], .spinner, [class*="loading-spinner" i], [class*="is-loading" i]');
    if (busy && root.__BA_Visibility.isElementVisible(busy, window.innerWidth, window.innerHeight)) {
      return { isLoading: true, indicator: busy.getAttribute('aria-label') || 'Component loading' };
    }
    return { isLoading: false };
  }

  function extractFormsSummary(elements) {
    const formMap = new Map();
    for (const el of elements) {
      if (el.formId) {
        if (!formMap.has(el.formId)) {
          formMap.set(el.formId, { id: el.formId, fieldCount: 0, populatedCount: 0, hasSubmit: false });
        }
        const f = formMap.get(el.formId);
        f.fieldCount++;
        if (el.hasValue) f.populatedCount++;
        if (el.type === 'button' || el.type === 'input:submit') f.hasSubmit = true;
      }
    }
    return Array.from(formMap.values());
  }

  /**
   * Runs the full local extraction pipeline described in the project
   * spec (sections 4-9): interactive elements -> visible text ->
   * sensitive-info detection. Everything below this call stays inside
   * the content script; only the returned plain object leaves it.
   */
  async function runExtraction() {
    const viewport = buildViewport();

    const { elements, registry } = root.__BA_InteractiveElements.extractInteractiveElements(
      viewport.width,
      viewport.height
    );

    const textNodes = root.__BA_TextExtractor.extractVisibleText(
      viewport.width,
      viewport.height,
      registry
    );

    const { items: sensitiveItems, flaggedNodes } = await root.__BA_PiiDetector.detectSensitiveInfo(
      textNodes,
      viewport.width,
      viewport.height
    );

    // ID/document image redaction (e.g. an Aadhaar/PAN card photo preview
    // on a KYC form). piiDetector only scans text nodes, so a photographed
    // ID rendered as <img>/<canvas> would otherwise pass through
    // untouched. See content/idImageDetector.js for the detection heuristics.
    const idImageRegions = root.__BA_IdImageDetector
      ? root.__BA_IdImageDetector.detectIdImageRegions(viewport.width, viewport.height)
      : [];

    // Also flag interactive elements whose href carries sensitive query params.
    for (const el of elements) {
      if (el.href) {
        const flagged = root.__BA_PiiDetector.detectSensitiveUrl(el.href);
        if (flagged) {
          sensitiveItems.push({
            type: flagged.type,
            masked: flagged.masked,
            confidence: flagged.confidence,
            bbox: el.bbox,
            elementId: el.id
          });
        }
      }

      // IMPORTANT: form-control VALUES — text typed into an
      // <input>/<textarea>, or the visible label of a <select>'s chosen
      // <option> — are painted on screen by the browser's native form
      // control rendering. Mark hasValue=true if a value exists.
      const elType = (el.type || '').toLowerCase();
      const isCheckboxOrRadio = elType.includes('checkbox') || elType.includes('radio');
      const isSelect = elType === 'select' || (el.tag && el.tag.toLowerCase() === 'select');

      let isActuallyFilled = false;
      if (isCheckboxOrRadio) {
        isActuallyFilled = el.value === 'checked';
      } else if (isSelect) {
        isActuallyFilled = el.value != null && el.value !== '' && !el.value.startsWith('--');
      } else {
        isActuallyFilled = el.value != null && el.value !== '' && el.value !== '[REDACTED]';
      }

      el.hasValue = isActuallyFilled;

      if (isActuallyFilled && el.value != null && el.value !== '' && el.value !== 'checked') {
        const fieldLabel = el.ariaLabel || el.placeholder || '';
        const valueMatches = await root.__BA_PiiDetector.scanPlainText(el.value, fieldLabel);
        if (valueMatches.length > 0) {
          for (const m of valueMatches) {
            sensitiveItems.push({
              type: m.type,
              masked: m.masked,
              confidence: m.confidence,
              bbox: el.bbox,
              elementId: el.id
            });
          }
          // Never let the raw value escape this context once flagged.
          el.value = '[REDACTED]';
        }
      }
    }

    // Build a safe, display-ready visible-text summary: any text node
    // that contained a sensitive match is fully replaced, never partially leaked.
    const visibleTextSummary = textNodes.map((entry) => ({
      text: flaggedNodes.has(entry.node) ? '[REDACTED - sensitive text on this line]' : entry.text.slice(0, 300),
      bbox: entry.bbox,
      elementId: entry.elementId
    }));

    // Strip masked/confidence-only sensitive items down to a clean shape.
    const cleanSensitiveItems = sensitiveItems.map((s) => ({
      type: s.type,
      masked: s.masked,
      confidence: s.confidence,
      bbox: s.bbox,
      elementId: s.elementId != null ? s.elementId : null
    }));

    const activeModal = extractActiveModal();
    const alerts = extractAlerts();
    const loadingState = extractLoadingState();
    const forms = extractFormsSummary(elements);

    // Local vision fallback, v0 (claude/v06-local-vision-fallback-scope.md):
    // flag icon-only, unlabeled interactive elements so popup.js can run a
    // cheap classical-CV pass against the already-captured screenshot and
    // enrich the DOM skeleton with an inferredLabel before it's ever built.
    // Near-zero cost on ordinary pages — see iconCandidateDetector.js's own
    // header for why this returns empty almost everywhere.
    const iconCandidates = root.__BA_IconCandidateDetector
      ? root.__BA_IconCandidateDetector.findUnlabeledIconCandidates(elements)
      : [];

    const frame = computeFrameOffset();

    const result = {
      timestamp: Date.now(),
      url: location.href,
      viewport,
      elements,
      visibleText: visibleTextSummary,
      sensitiveItems: cleanSensitiveItems,
      idImageRegions,
      iconCandidates,
      // Frame bookkeeping. Every bbox above is in THIS frame's coordinates;
      // the merge step in background/service-worker.js translates them into
      // top-level (screenshot) space using this.
      frame,
      childFrames: collectChildFrameRects(viewport.width, viewport.height),
      pageContext: {
        activeModal,
        alerts,
        loadingState,
        forms
      },
      counts: {
        interactiveElements: elements.length,
        sensitiveItems: cleanSensitiveItems.length,
        idImageRegions: idImageRegions.length
      }
    };

    // Cache the registry + result locally for later action execution
    root.__BA_state.registry = registry;
    root.__BA_state.lastResult = result;

    return result;
  }

  root.__BA_DomExtractor = { runExtraction };
})(window);