/**
 * agent/agentBackend.js
 *
 * Concrete implementation of the backend bridge for the Privacy-Vision
 * Agent. This is the ONLY place in the extension that makes an outbound
 * network request — and it only ever carries already-redacted data.
 */

(function (root) {

  const DEFAULT_ENDPOINT = 'http://localhost:5000/api/agent/step';
  const STORAGE_KEY      = 'ba_backend_endpoint';

  function dataUrlToBase64(dataUrl) {
    const comma = dataUrl.indexOf(',');
    return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  }

  function screenshotMeta(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const format = dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png';
        resolve({ format, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => reject(new Error('Could not decode screenshot for dimension extraction.'));
      img.src = dataUrl;
    });
  }

  function toStringId(id) {
    return String(id);
  }

  function resolveElementId(targetSelector, elements) {
    if (!targetSelector || !Array.isArray(elements)) return null;
  
    const target = String(targetSelector).trim();
  
    // 1. Exact selector match
    let match = elements.find(
      (el) => String(el.selector || '').trim() === target
    );
    if (match != null) return match.id;
  
    // 2. Treat "#17" as an elementId when the ID is numeric/string
    if (target.startsWith('#')) {
      const possibleId = target.slice(1);
  
      match = elements.find(
        (el) => String(el.id) === possibleId
      );
  
      if (match != null) return match.id;
    }
  
    // 3. Direct element ID match
    match = elements.find(
      (el) => String(el.id) === target
    );
    if (match != null) return match.id;
  
    // 4. Existing ID-based CSS selector matching
    if (target.startsWith('#')) {
      const cleanId = target.slice(1);
  
      match = elements.find(
        (el) =>
          el.selector === target ||
          (el.selector && el.selector.includes(`#${cleanId}`))
      );
  
      if (match != null) return match.id;
    }
  
    // 5. Normalized selector matching
    const normalizedTarget = target.toLowerCase();
  
    match = elements.find((el) => {
      if (!el.selector) return false;
  
      const s = String(el.selector).trim().toLowerCase();
  
      return (
        s === normalizedTarget ||
        s.endsWith(normalizedTarget) ||
        normalizedTarget.endsWith(s)
      );
    });
  
    return match != null ? match.id : null;
  }

  function findElementByTarget(targetSelector, elementId, elements) {
    if (!Array.isArray(elements)) return null;
    if (elementId != null) {
      const byId = elements.find(e => e.id === elementId);
      if (byId) return byId;
    }
    if (targetSelector) {
      const resolvedId = resolveElementId(targetSelector, elements);
      if (resolvedId != null) {
        const byResolvedId = elements.find(e => e.id === resolvedId);
        if (byResolvedId) return byResolvedId;
      }
      const direct = elements.find(e => e.selector === targetSelector);
      if (direct) return direct;
    }
    return null;
  }

  function isElementPopulated(el) {
    if (!el) return false;
    if (el.hasValue === true) return true;
    if (el.value != null && el.value !== '' && el.value !== 'unchecked' && el.value !== '[REDACTED]') {
      return true;
    }
    return false;
  }

  function isSubmitElement(el, selector) {
    if (!el && !selector) return false;
    if (typeof root !== 'undefined' && root.__BA_ConsequentialActionDetector) {
      const res = root.__BA_ConsequentialActionDetector.isConsequentialElement(el, selector);
      return res.isConsequential;
    }
    const combined = `${el?.text || ''} ${el?.ariaLabel || ''} ${el?.placeholder || ''} ${el?.type || ''} ${selector || ''}`.toLowerCase();
    const keywords = [
      'submit', 'confirm', 'place order', 'finish', 'checkout', 'pay now', 'pay',
      'purchase', 'buy now', 'book now', 'make payment', 'proceed', 'continue',
      'next step', 'register', 'apply now', 'send message', 'send enquiry', 'delete', 'remove', 'publish'
    ];
    return keywords.some(kw => combined.includes(kw));
  }

  function getExpectedInputHelp(fieldLabel, selector, inputType) {
    const combined = `${fieldLabel} ${selector} ${inputType}`.toLowerCase();

    if (combined.includes('pan')) {
      return {
        fieldName: 'PAN Card Number',
        expectedValue: '10-character alphanumeric PAN identifier (e.g., ABCDE1234F)'
      };
    }
    if (combined.includes('aadhaar') || combined.includes('aadhar')) {
      return {
        fieldName: 'Aadhaar Card Number',
        expectedValue: '12-digit Aadhaar identification number'
      };
    }
    if (combined.includes('email')) {
      return {
        fieldName: 'Email Address',
        expectedValue: 'Valid email address (e.g., user@example.com)'
      };
    }
    if (combined.includes('phone') || combined.includes('mobile') || combined.includes('tel')) {
      return {
        fieldName: 'Mobile / Phone Number',
        expectedValue: '10-digit primary phone number'
      };
    }
    if (combined.includes('pass') || inputType === 'password') {
      return {
        fieldName: 'Password',
        expectedValue: 'Your account password'
      };
    }
    if (combined.includes('dob') || combined.includes('birth') || combined.includes('date')) {
      return {
        fieldName: 'Date of Birth',
        expectedValue: 'Date in DD/MM/YYYY format'
      };
    }
    if (combined.includes('name')) {
      return {
        fieldName: 'Full Name',
        expectedValue: 'Full legal name as specified on official documents'
      };
    }

    return {
      fieldName: fieldLabel || selector || 'Required Input Field',
      expectedValue: `Enter the required ${fieldLabel || 'information'} for this field.`
    };
  }

  function buildDomSkeleton(url, elements, sensitiveItems, pageContext, taskInstruction) {
    // Build a set of element IDs that have been flagged as containing
    // sensitive information by the PII detection pipeline.
    const sensitiveElementIds = new Set();
    if (Array.isArray(sensitiveItems)) {
      for (const item of sensitiveItems) {
        if (item.elementId != null) sensitiveElementIds.add(item.elementId);
      }
    }

    const taskTokens = (taskInstruction || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w));

    const activeModalOpen = Boolean(pageContext?.activeModal?.isOpen);

    // Map each element with semantic categories and relevance scoring
    const scoredElements = elements.map((el) => {
      const tagFromType = (el.type || '').split(':')[0];
      const isFilled = el.hasValue === true || (el.value != null && el.value !== '');
      const isSensitive = sensitiveElementIds.has(el.id) ||
                          (el.sensitive != null ? el.sensitive : false);

      const record = {
        id:         toStringId(el.id),
        tag:        tagFromType || 'unknown',
        type:       el.type  || undefined,
        selector:   el.selector,
        box: {
          x:      el.bbox ? el.bbox.x      : 0,
          y:      el.bbox ? el.bbox.y      : 0,
          width:  el.bbox ? el.bbox.width  : 0,
          height: el.bbox ? el.bbox.height : 0,
        },
        sensitive:    isSensitive,
        redactionTag: el.redactionTag || undefined,
        hasValue:     isFilled,

        // ── Semantic labels ───────────────────────────────────────
        text:        el.text        || undefined,
        ariaLabel:   el.ariaLabel   || undefined,
        placeholder: el.placeholder || undefined,
        // Set only for an unlabeled icon-only button. Either a named glyph
        // from the trained local classifier ('icon_menu', 'icon_close', …;
        // see utils/iconClassifier.js) or 'unlabeled_icon_detected' from
        // the v0 heuristic when the classifier was not confident enough to
        // commit. A purely structural hint drawn from a closed enum, same
        // trust level as text/ariaLabel, never a value read off the page.
        inferredLabel: el.inferredLabel || undefined,

        // ── Element state ─────────────────────────────────────────
        enabled: el.enabled != null ? el.enabled : true,
        visible: el.visible != null ? el.visible : true,
        // Emitted only when the local vision engine found this element's own
        // coordinates featureless — layout says the control is there, the
        // pixels say nothing is drawn. Tells the reasoner the target is
        // unreliable (covered, or not yet rendered) instead of letting it
        // click into nothing. Omitted in the normal case, so it costs
        // nothing on a well-behaved page.
        visuallyPainted: el.visuallyPainted === false ? false : undefined,

        // ── Semantic categorizations ──────────────────────────────
        isSearch:    el.isSearch    || undefined,
        isPagination: el.isPagination || undefined,
        inModal:     el.inModal     || undefined,
        inNav:       el.inNav       || undefined,
        isSticky:    el.isSticky    || undefined,
        formId:      el.formId      || undefined,
      };

      // Enrich special element types
      if (el.options)    record.options    = el.options;
      if (el.radioGroup) record.radioGroup = el.radioGroup;
      if (el.accept)     record.accept     = el.accept;
      if (el.multiple)   record.multiple   = el.multiple;

      // Calculate task-relevance score to filter DOM noise
      let score = 0;
      if (activeModalOpen) {
        if (el.inModal) score += 100;
        else score -= 40;
      }
      const labelText = `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''} ${el.selector || ''}`.toLowerCase();
      for (const tok of taskTokens) {
        if (labelText.includes(tok)) score += 20;
      }
      if (el.isSearch) score += 15;
      if (el.formId) score += 10;
      if (tagFromType === 'input' || tagFromType === 'button' || tagFromType === 'select') score += 10;
      if (el.isPagination) score += 10;
      if (el.isSticky) score += 5;
      if (el.inNav && !el.isSearch) score -= 10; // Demote generic navigation/footer links
      if (!el.enabled) score -= 15;

      return { record, score, isCore: Boolean(el.formId || el.isSearch || el.inModal || isFilled || isSensitive) };
    });

    // Task-relevance prioritization:
    // If elements list is large (> 60), prioritize high scoring & core elements to avoid DOM noise
    const finalRecords = scoredElements.map(s => s.record);

    return {
      url,
      pageContext: pageContext || undefined,
      elements: finalRecords,
    };
  }

  function buildRedactionMap(sensitiveItems) {
    if (!Array.isArray(sensitiveItems)) return [];
    const map = [];
    for (const item of sensitiveItems) {
      if (item.elementId == null) continue;
      map.push({
        elementId: toStringId(item.elementId),
        type:      item.type   || 'UNKNOWN',
        method:    'blackout',
      });
    }
    return map;
  }

  function buildAskUserAction(el, elementId, targetSelector) {
    const isPasswordField = (el?.type === 'password') ||
                            (el?.type && String(el.type).includes('password')) ||
                            (targetSelector && targetSelector.toLowerCase().includes('password')) ||
                            (el?.placeholder && el.placeholder.toLowerCase().includes('password')) ||
                            (el?.ariaLabel && el.ariaLabel.toLowerCase().includes('password'));

    const fieldLabel = el
      ? (el.placeholder || el.ariaLabel || el.text || targetSelector || 'Required Field')
      : (targetSelector || 'Required Field');
    const cleanKey = targetSelector || `field_${elementId || 0}`;
    const help = getExpectedInputHelp(fieldLabel, targetSelector || '', el?.type || '');

    return {
      action: 'ask_user',
      elementId: elementId,
      targetSelector: targetSelector,
      fields: [
        {
          key: cleanKey,
          elementId: elementId,
          targetSelector: targetSelector,
          label: help.fieldName,
          fieldName: help.fieldName,
          expectedValue: help.expectedValue,
          selectorText: targetSelector || (elementId != null ? `#element-${elementId}` : ''),
          type: isPasswordField ? 'password' : 'text'
        }
      ]
    };
  }

  function translateAction(backendAction, elements, mode = 'hitl') {
    // Visual + DOM Fusion: Resolve visual coordinates to validated DOM targets
    const grounder = (typeof root !== 'undefined' && root.__BA_VisualDomGrounder) ? root.__BA_VisualDomGrounder : null;
    let effectiveAction = backendAction;
    if (grounder && Array.isArray(elements) && (!backendAction.targetSelector || !elements.some(e => e.selector === backendAction.targetSelector))) {
      const fused = grounder.fuseVisualWithDom(backendAction, elements);
      if (fused.ok && fused.action) {
        effectiveAction = fused.action;
      }
    }

    const { action, targetSelector, value, reasoning } = effectiveAction;

    switch (action) {
      case 'click': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = Array.isArray(elements) ? elements.find((e) => e.selector === targetSelector || e.id === elementId) : null;

        // Prevent automated submission per privacy policy
        if (isSubmitElement(el, targetSelector)) {
          return {
            action: 'notify_submit',
            elementId: elementId,
            targetSelector: targetSelector,
            message: 'Consequential action detected. Human confirmation required before proceeding.'
          };
        }

        if (elementId == null && !targetSelector) {
          console.warn('[AgentBackend] Target element selector not found for click:', targetSelector);
          return { action: 'wait', elementId: null, value: null };
        }
        return { action: 'click', elementId, targetSelector, value: null };
      }

      case 'fill':
      case 'type': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = findElementByTarget(targetSelector, elementId, elements);

        const isFilled = isElementPopulated(el);

        // If the field is ALREADY filled on the webpage, skip it.
        if (isFilled) {
          console.log(`[AgentBackend] Field ${targetSelector || el?.selector} already has a value in DOM. Skipping.`);
          return {
            action: 'skip_filled',
            elementId: el?.id ?? elementId,
            targetSelector: el?.selector || targetSelector,
            reason: 'Field already populated on page'
          };
        }

        // Never allow LLM to directly fill a sensitive field
        if (el?.sensitive === true || el?.sensitive === 'unknown') {
            return buildAskUserAction(
                el,
                el?.id ?? elementId,
                el?.selector || targetSelector
            );
        }

        // Normal LLM-provided value.
        // Let the action executor actually fill the field.
        return {
            action: 'fill',
            elementId: el?.id ?? elementId,
            targetSelector: el?.selector || targetSelector,
            value: value ?? null
};
      }

      // ── FILL FROM LOCAL PRIVATE STORE ──────────────────────────────────────
      case 'fill_from_local': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = findElementByTarget(targetSelector, elementId, elements);
        const isFilled = isElementPopulated(el);
        if (isFilled) {
          console.log(`[AgentBackend] Field ${targetSelector || el?.selector} already has a value in DOM. Skipping.`);
          return {
            action: 'skip_filled',
            elementId: el?.id ?? elementId,
            targetSelector: el?.selector || targetSelector,
            reason: 'Field already populated on page'
          };
        }

        if (mode === 'complete') {
          return {
            action: 'fill_from_local',
            elementId: el?.id ?? elementId,
            targetSelector: el?.selector || targetSelector,
            value: value || null
          };
        }

        return buildAskUserAction(el, el?.id ?? elementId, el?.selector || targetSelector);
      }

      // ── CLEAR INPUT ───────────────────────────────────────────────────────
      case 'clear': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'clear', elementId, targetSelector, value: null };
      }

      // ── SELECT / DROPDOWN ─────────────────────────────────────────────────
      case 'select': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = Array.isArray(elements) ? elements.find((e) => e.selector === targetSelector || e.id === elementId) : null;
        const isAlreadySelected = el && el.value === value;
        if (isAlreadySelected) return { action: 'wait', elementId: null, value: null };
        return { action: 'select', elementId, targetSelector, value: value || '' };
      }

      // ── CHECKBOX (CHECK / UNCHECK) ────────────────────────────────────────
      case 'check': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'check', elementId, targetSelector, value: true };
      }

      case 'uncheck': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'check', elementId, targetSelector, value: false };
      }

      // ── RADIO BUTTON ──────────────────────────────────────────────────────
      case 'radio': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'click', elementId, targetSelector, value: null };
      }

      // ── HOVER / MOUSEOVER ─────────────────────────────────────────────────
      case 'hover': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'hover', elementId, targetSelector, value: null };
      }

      // ── FOCUS ELEMENT ─────────────────────────────────────────────────────
      case 'focus': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'focus', elementId, targetSelector, value: null };
      }

      // ── KEYBOARD INTERACTION / PRESS KEY ──────────────────────────────────
      case 'press_key': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'press_key', elementId, targetSelector, value: value || 'Enter' };
      }

      // ── BROWSER NAVIGATION ────────────────────────────────────────────────
      case 'navigate':
        return { action: 'navigate', elementId: null, targetSelector: null, value: value || '' };

      case 'back':
        return { action: 'back', elementId: null, targetSelector: null, value: null };

      case 'forward':
        return { action: 'forward', elementId: null, targetSelector: null, value: null };

      // ── DATA EXTRACTION / DIRECT ANSWER ───────────────────────────────────
      case 'extract': {
        const elementId = resolveElementId(targetSelector, elements);
        return { action: 'extract', elementId, targetSelector, value: value || reasoning || '' };
      }

      // ── FILE UPLOAD ───────────────────────────────────────────────────────
      case 'upload':
      case 'file': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = Array.isArray(elements) ? elements.find((e) => e.selector === targetSelector || e.id === elementId) : null;
        const acceptHint = el?.accept ? ` Accepted formats: ${el.accept}.` : '';
        const multiHint  = el?.multiple ? ' Multiple files can be selected.' : '';
        return {
          action: 'ask_user',
          elementId,
          targetSelector,
          isUpload: true,
          fields: [{
            key:           targetSelector || `upload_${elementId}`,
            elementId,
            targetSelector,
            label:         'Upload File',
            fieldName:     'Upload File',
            expectedValue: `Click the highlighted upload button and select the required file from your device.${acceptHint}${multiHint}`,
            selectorText:  targetSelector || '',
            type:          'file'
          }]
        };
      }

      case 'scroll':
        return { action: 'scroll', elementId: resolveElementId(targetSelector, elements), targetSelector, value: value || 'down' };

      case 'wait':
        return { action: 'wait', elementId: null, targetSelector: null, value: null };

      case 'done':
        return { action: 'done', elementId: null, targetSelector: null, value: null };

      case 'ask_user':
        return backendAction;

      case 'notify_submit':
        return backendAction;

      case 'replan':
      case 'failed':
        return {
          action: 'replan',
          elementId: resolveElementId(targetSelector, elements),
          targetSelector: targetSelector || null,
          value: value || reasoning || null
        };

      default:
        console.warn('[AgentBackend] Unrecognised backend action:', action);
        return { action: 'wait', elementId: null, value: null };
    }
  }

  function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Builds a truncated, display-safe copy of the exact payload that just
   * crossed (or was about to cross) the network boundary — for the popup's
   * live "Privacy Receipt" panel. This is NOT a re-sanitization; sanitizedBody
   * has already been through PrivacyBoundary.sanitizeOutboundPayload(), so
   * this only truncates size for the UI (full base64 screenshot, and any
   * very long element list) — it never re-exposes anything that was stripped.
   */
  function buildSanitizedPreview(sanitizedBody, screenshotBytes) {
    try {
      const preview = JSON.parse(JSON.stringify(sanitizedBody || {}));

      if (preview.screenshot) {
        preview.screenshot = {
          format: preview.screenshot.format,
          width: preview.screenshot.width,
          height: preview.screenshot.height,
          dataBase64: `<redacted screenshot omitted from preview — ${screenshotBytes} bytes, no raw pixels shown>`
        };
      }

      if (preview.domSkeleton && Array.isArray(preview.domSkeleton.elements)) {
        const MAX_PREVIEW_ELEMENTS = 6;
        const total = preview.domSkeleton.elements.length;
        if (total > MAX_PREVIEW_ELEMENTS) {
          preview.domSkeleton.elements = [
            ...preview.domSkeleton.elements.slice(0, MAX_PREVIEW_ELEMENTS),
            { note: `… ${total - MAX_PREVIEW_ELEMENTS} more element(s) omitted from this preview only — still sent, still sanitized identically.` }
          ];
        }
      }

      let text = JSON.stringify(preview, null, 2);
      const MAX_CHARS = 4000;
      if (text.length > MAX_CHARS) {
        text = `${text.slice(0, MAX_CHARS)}\n… (truncated for display — full payload was smaller in scope, larger in bytes)`;
      }
      return text;
    } catch (e) {
      return `Preview unavailable: ${e.message}`;
    }
  }

  class AgentBackend {

    constructor() {
      this._sessionId = generateSessionId();
      this._lastTransmission = null;
    }

    /**
     * Builds and stores the telemetry record consumed by the popup's live
     * Privacy Receipt panel. Called for every attempted transmission,
     * including one blocked by the adversarial pre-flight scan — a BLOCKED
     * record is itself proof the boundary works, so it's just as worth
     * showing as a successful one.
     */
    _recordTransmission({ sanitizedBody, domSkeleton, redactionMap, sensitiveItems, endpoint, scanPassed, scanError, blocked }) {
      const screenshotBase64 = sanitizedBody?.screenshot?.dataBase64 || '';
      const screenshotBytes = screenshotBase64 ? Math.ceil((screenshotBase64.length * 3) / 4) : 0;
      const serializedBytes = (() => {
        try { return JSON.stringify(sanitizedBody).length; } catch (_) { return 0; }
      })();

      const patternsChecked = (typeof root !== 'undefined' && root.__BA_PrivacyBoundary && root.__BA_PrivacyBoundary.getCheckedPatternNames)
        ? root.__BA_PrivacyBoundary.getCheckedPatternNames()
        : ['CREDIT_CARD', 'PAN_CARD', 'AADHAAR', 'PASSWORD_FIELD'];

      this._lastTransmission = {
        timestamp: Date.now(),
        sessionId: this._sessionId,
        endpoint,
        blocked: Boolean(blocked),
        bytes: {
          totalPayload: serializedBytes,
          screenshotBase64: screenshotBytes
        },
        counts: {
          elementsSent: domSkeleton?.elements?.length || 0,
          sensitiveItemsDetectedLocally: Array.isArray(sensitiveItems) ? sensitiveItems.length : 0,
          redactionMapEntries: Array.isArray(redactionMap) ? redactionMap.length : 0,
          actionHistoryEntries: Array.isArray(sanitizedBody?.actionHistory) ? sanitizedBody.actionHistory.length : 0
        },
        adversarialScan: {
          passed: Boolean(scanPassed),
          error: scanError || null,
          patternsChecked
        },
        sanitizedPayloadPreview: buildSanitizedPreview(sanitizedBody, screenshotBytes)
      };

      return this._lastTransmission;
    }

    /** Read by popup.js after every decideNextAction() call to render the live Privacy Receipt panel. */
    getLastTransmissionSummary() {
      return this._lastTransmission;
    }

    async getEndpoint() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get([STORAGE_KEY], (result) => {
            resolve(result[STORAGE_KEY] || DEFAULT_ENDPOINT);
          });
        } catch (_) {
          resolve(DEFAULT_ENDPOINT);
        }
      });
    }

    async setEndpoint(url) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: url }, resolve);
        } catch (_) {
          resolve();
        }
      });
    }

    async isAvailable() {
      try {
        const endpoint = await this.getEndpoint();
        const url = new URL(endpoint);
        const healthUrl = `${url.origin}/`;
        const resp = await fetch(healthUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
        return resp.ok;
      } catch (_) {
        return false;
      }
    }

    async decideNextAction(payload) {
      const {
        task,
        redactedScreenshotDataUrl,
        elements     = [],
        viewport     = {},
        history      = [],
        pageUrl,
        sensitiveItems = [],
        mode = 'hitl',
        stateDiff,
        userInteractions = [],
        formSummary,
        pageContext,
        taskPlan,
        taskMemory,
        privacyDialMode,
        visualState,
      } = payload;

      // Hard architectural guard, independent of the caller: if the
      // Privacy Dial (agent/privacyDial.js) is set to "Fully Local", this
      // — the ONLY function in the extension that makes an outbound
      // network request — refuses to run at all. This isn't a preference
      // the cloud call politely honors; it's a second, independent check
      // so the "zero data leaves the device" guarantee doesn't rest on
      // every call site remembering not to invoke this method. Callers in
      // Fully Local mode should use decideNextActionLocalOnly() instead.
      if (privacyDialMode === 'local') {
        throw new Error(
          'Privacy Dial is set to Fully Local — agentBackend.decideNextAction() ' +
          '(the only network call in this extension) refuses to run. This call ' +
          'should never have been attempted; use decideNextActionLocalOnly() instead.'
        );
      }

      const meta    = await screenshotMeta(redactedScreenshotDataUrl);
      const base64  = dataUrlToBase64(redactedScreenshotDataUrl);

      const url           = pageUrl || (typeof location !== 'undefined' ? location.href : 'unknown');
      const domSkeleton   = buildDomSkeleton(url, elements, sensitiveItems, pageContext, task);
      const redactionMap  = buildRedactionMap(sensitiveItems);

      const requestBody = {
        sessionId:       this._sessionId,
        taskInstruction: task,
        capturedAt:      Date.now(),
        screenshot: {
          format:    meta.format,
          dataBase64: base64,
          width:     meta.width,
          height:    meta.height,
        },
        domSkeleton,
        redactionMap,
        actionHistory: Array.isArray(history) ? history : [],
        ...(stateDiff ? { stateDiff } : {}),
        ...(Array.isArray(userInteractions) && userInteractions.length > 0 ? { userInteractions } : {}),
        ...(formSummary ? { formSummary } : {}),
        ...(pageContext ? { pageContext } : {}),
        ...(taskPlan ? { taskPlan } : {}),
        ...(taskMemory ? { taskMemory } : {}),
        // Local screen-state perception (utils/visualStateEngine.js): what
        // the raw pixels showed that the DOM could not report — page still
        // loading, a blocking overlay present, whether the last action
        // changed anything. Filtered field-by-field by
        // privacyBoundary.sanitizeVisualState() before it goes anywhere.
        ...(visualState ? { visualState } : {}),
      };

      // Enforce strict structural privacy boundary
      const boundaryEngine = (typeof root !== 'undefined' && root.__BA_PrivacyBoundary) ? root.__BA_PrivacyBoundary : null;
      const sanitizedBody = boundaryEngine ? boundaryEngine.sanitizeOutboundPayload(requestBody) : requestBody;
      const endpoint = await this.getEndpoint();

      // Pre-flight adversarial scan: ensure no unredacted secret or raw PII crosses the wire.
      // Every attempt — pass or fail — is recorded for the popup's live
      // Privacy Receipt panel, so a BLOCKED transmission is visible proof
      // the boundary works, not just a silently-thrown error.
      try {
        if (boundaryEngine) {
          boundaryEngine.assertSafeForTransmission(sanitizedBody);
        }
        this._recordTransmission({ sanitizedBody, domSkeleton, redactionMap, sensitiveItems, endpoint, scanPassed: true, blocked: false });
      } catch (scanErr) {
        this._recordTransmission({ sanitizedBody, domSkeleton, redactionMap, sensitiveItems, endpoint, scanPassed: false, scanError: scanErr.message, blocked: true });
        throw scanErr; // hard-abort — nothing crosses the wire on a failed scan
      }

      let response;
      try {
        response = await fetch(endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(sanitizedBody),
          signal:  AbortSignal.timeout(30_000),
        });
      } catch (networkErr) {
        throw new Error(
          `Network error reaching backend at ${endpoint}: ${networkErr.message}`
        );
      }

      let json;
      try {
        json = await response.json();
      } catch (_) {
        throw new Error(`Backend returned non-JSON response.`);
      }

      if (!json.success) {
        const reason = json.reason || 'Unknown backend failure';
        console.warn('[AgentBackend] Backend returned success:false —', reason);
        throw new Error(`Backend decision failed: ${reason}`);
      }

      const backendAction = json.action;
      if (!backendAction || typeof backendAction.action !== 'string') {
        throw new Error('Backend response is missing a valid action field.');
      }

      const translated = translateAction(backendAction, elements, mode);
      if (backendAction.suggestion && typeof backendAction.suggestion === 'object') {
        translated.suggestion = backendAction.suggestion;
      }
      return translated;
    }

    /**
     * The Fully Local decision path (Privacy Dial = 'local'). Makes no
     * network request and needs none of the redacted-screenshot / DOM
     * skeleton machinery decideNextAction() builds — it only needs the
     * live elements and the form summary already computed locally each
     * step. It deliberately knows how to do only two things, honestly:
     *
     *   1. Point at the next empty, semantically-matchable form field
     *      (agent/fieldMatcher.js) so the existing 'fill_from_local'
     *      execution path (popup.js) can look up agent/privateDataStore.js
     *      at execution time and either fill it or fall back to asking
     *      the human — exactly the same execution code Hybrid/Cloud mode
     *      already uses for this action, just reached without ever
     *      building a network payload.
     *   2. If no field matches (or none remain), ask the human directly
     *      via the same ask_user shape decideNextAction() would return.
     *
     * It never returns 'click', 'navigate', or any action that requires
     * judgment about page semantics a deterministic local matcher can't
     * responsibly make — that's the honest capability boundary of this
     * mode, not an oversight. Consequential actions (submit/pay/etc.) are
     * handled by the caller via the same handleFormCompletionGate() path
     * used for explicit form-completion tasks, which was already fully
     * local (it runs agent/consequentialActionDetector.js + the 9-step
     * human-authorization protocol, no network involved either way).
     */
    decideNextActionLocalOnly({ extraction, formSummary } = {}) {
      const elements = (extraction && Array.isArray(extraction.elements)) ? extraction.elements : [];
      const formAnalyzer = (typeof root !== 'undefined') ? root.__BA_FormAnalyzer : null;
      const fieldMatcher = (typeof root !== 'undefined') ? root.__BA_FieldMatcher : null;

      for (const el of elements) {
        const isFormField = formAnalyzer ? formAnalyzer.isFormInputElement(el) : (el && el.tag === 'input');
        if (!isFormField) continue;
        if (isElementPopulated(el)) continue;

        const match = fieldMatcher ? fieldMatcher.matchElement(el) : { matched: false, key: null };
        if (match.matched && match.key) {
          // Value lookup happens at execution time in popup.js, same as
          // every other fill_from_local decision — this object never
          // carries or even sees the actual private value.
          return { action: 'fill_from_local', elementId: el.id, targetSelector: el.selector, value: null };
        }

        // No confident local match for a field that clearly needs a
        // value — ask the human rather than guess, and rather than
        // (as Hybrid/Cloud would) ask a model to infer it.
        return buildAskUserAction(el, el.id, el.selector);
      }

      return { action: 'wait', elementId: null, targetSelector: null, value: null };
    }

    /**
     * The on-device LLM reasoning path (Qwen2.5 via agent/webllmEngine.js,
     * run inside offscreen.js). Used two ways, per
     * claude/v25-master-implementation-guide.md:
     *
     *   1. Fully Local mode (Privacy Dial = 'local'): called from
     *      popup.js only AFTER decideNextActionLocalOnly() above already
     *      failed to find a deterministic field-matcher answer — this is
     *      the "ask the on-device model before giving up and asking the
     *      human" upgrade v25 calls for.
     *   2. Hybrid Debate mode (Privacy Dial = 'debate'): called by
     *      agent/debateManager.js in parallel with decideNextAction()
     *      (the cloud path) so the two can be compared.
     *
     * This makes ZERO network requests of its own. It sends one
     * chrome.runtime message to this extension's own offscreen document
     * (background/service-worker.js forwards RUN_WEBLLM_REASON exactly
     * like it already does for RUN_NER_INFERENCE / RUN_FACE_DETECTION /
     * RUN_ID_IMAGE_OCR) and reads back a plain JSON action object — that
     * message never leaves the browser, so it is safe to call in every
     * Privacy Dial position, including 'local', without touching the
     * hard network guard at the top of decideNextAction() above.
     *
     * The model's raw suggestion is passed through the exact same
     * translateAction() normalization decideNextAction() uses for the
     * cloud model's suggestions — so every existing safety behavior
     * (submit/payment detection -> notify_submit, sensitive-field guard ->
     * ask_user, already-filled-field skip) applies identically regardless
     * of which reasoner proposed the action.
     */
    async decideNextActionLocalLLM({ task, extraction, actionHistory, formSummary, mode = 'hitl' } = {}) {
      const elements = (extraction && Array.isArray(extraction.elements)) ? extraction.elements : [];
      const url = (extraction && extraction.url) || (typeof location !== 'undefined' ? location.href : 'unknown');

      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'RUN_WEBLLM_REASON',
          task,
          elements,
          history: Array.isArray(actionHistory) ? actionHistory.slice(-6) : [],
          url,
        });
      } catch (err) {
        throw new Error(`On-device reasoning message failed: ${err.message || err}`);
      }

      if (!response || response.ok === false) {
        throw new Error((response && response.error) || 'On-device reasoning (WebLLM) is unavailable.');
      }

      const rawAction = response.decision;
      if (!rawAction || typeof rawAction.action !== 'string') {
        throw new Error('On-device reasoning returned no usable action.');
      }

      const translated = translateAction(rawAction, elements, mode);
      return {
        ...translated,
        confidence: typeof rawAction.confidence === 'number' ? rawAction.confidence : 0.5,
        reasoning: rawAction.reasoning || '',
        source: 'local_llm',
        modelId: rawAction.modelId || null,
      };
    }

    buildAskUserAction(el, elementId, targetSelector) {
      return buildAskUserAction(el, elementId, targetSelector);
    }

    findElementByTarget(targetSelector, elementId, elements) {
      return findElementByTarget(targetSelector, elementId, elements);
    }

    isElementPopulated(el) {
      return isElementPopulated(el);
    }

    resolveElementId(targetSelector, elements) {
      return resolveElementId(targetSelector, elements);
    }

    resetSession() {
      this._sessionId = generateSessionId();
      this._lastTransmission = null;
    }
  }

  AgentBackend.findElementByTarget = findElementByTarget;
  AgentBackend.isElementPopulated = isElementPopulated;
  AgentBackend.resolveElementId = resolveElementId;

  root.__BA_AgentBackend = AgentBackend;

})(typeof window !== 'undefined' ? window : self);
