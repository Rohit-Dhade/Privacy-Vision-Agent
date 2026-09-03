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

    const result = {
      timestamp: Date.now(),
      url: location.href,
      viewport,
      elements,
      visibleText: visibleTextSummary,
      sensitiveItems: cleanSensitiveItems,
      pageContext: {
        activeModal,
        alerts,
        loadingState,
        forms
      },
      counts: {
        interactiveElements: elements.length,
        sensitiveItems: cleanSensitiveItems.length
      }
    };

    // Cache the registry + result locally for later action execution
    root.__BA_state.registry = registry;
    root.__BA_state.lastResult = result;

    return result;
  }

  root.__BA_DomExtractor = { runExtraction };
})(window);