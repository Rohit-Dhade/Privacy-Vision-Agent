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
    // 1. Direct exact match
    let match = elements.find((el) => el.selector === targetSelector);
    if (match != null) return match.id;

    // 2. ID-based matching (e.g. #fullName, input#fullName, or [id='fullName'])
    if (targetSelector.startsWith('#')) {
      const cleanId = targetSelector.slice(1);
      match = elements.find((el) => el.selector === targetSelector || (el.selector && el.selector.includes(`#${cleanId}`)));
      if (match != null) return match.id;
    }

    // 3. Name or substring selector matching
    const normalizedTarget = targetSelector.trim().toLowerCase();
    match = elements.find((el) => {
      if (!el.selector) return false;
      const s = el.selector.trim().toLowerCase();
      return s === normalizedTarget || s.endsWith(normalizedTarget) || normalizedTarget.endsWith(s);
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

        // ── Element state ─────────────────────────────────────────
        enabled: el.enabled != null ? el.enabled : true,
        visible: el.visible != null ? el.visible : true,

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
    let finalRecords;
    if (scoredElements.length > 60) {
      scoredElements.sort((a, b) => b.score - a.score);
      const topSelected = scoredElements.slice(0, 60);
      finalRecords = topSelected.map(s => s.record);
    } else {
      finalRecords = scoredElements.map(s => s.record);
    }

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

        // In Complete Mode, route fill to fill_from_local so local store can fulfill it
        if (mode === 'complete') {
          return {
            action: 'fill_from_local',
            elementId: el?.id ?? elementId,
            targetSelector: el?.selector || targetSelector,
            value: value || null
          };
        }

        // In Assist Me (HITL) Mode, always use ask_user for visual guide
        return buildAskUserAction(el, el?.id ?? elementId, el?.selector || targetSelector);
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

  class AgentBackend {

    constructor() {
      this._sessionId = generateSessionId();
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
      } = payload;

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
      };

      // Enforce strict structural privacy boundary
      const boundaryEngine = (typeof root !== 'undefined' && root.__BA_PrivacyBoundary) ? root.__BA_PrivacyBoundary : null;
      const sanitizedBody = boundaryEngine ? boundaryEngine.sanitizeOutboundPayload(requestBody) : requestBody;

      // Pre-flight adversarial scan: ensure no unredacted secret or raw PII crosses the wire
      if (boundaryEngine) {
        boundaryEngine.assertSafeForTransmission(sanitizedBody);
      }

      const endpoint = await this.getEndpoint();
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
    }
  }

  AgentBackend.findElementByTarget = findElementByTarget;
  AgentBackend.isElementPopulated = isElementPopulated;
  AgentBackend.resolveElementId = resolveElementId;

  root.__BA_AgentBackend = AgentBackend;

})(typeof window !== 'undefined' ? window : self);
