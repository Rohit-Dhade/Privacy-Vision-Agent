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
    const match = elements.find((el) => el.selector === targetSelector);
    return match != null ? match.id : null;
  }

  function isSubmitElement(el, selector) {
    if (!el && !selector) return false;
    const combined = `${el?.text || ''} ${el?.ariaLabel || ''} ${el?.placeholder || ''} ${el?.type || ''} ${selector || ''}`.toLowerCase();
    const keywords = ['submit', 'confirm', 'place order', 'finish', 'checkout', 'pay now', 'register', 'apply now'];
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

  function buildDomSkeleton(url, elements) {
    return {
      url,
      elements: elements.map((el) => {
        const tagFromType = (el.type || '').split(':')[0];
        const isFilled = el.hasValue === true || (el.value != null && el.value !== '');

        return {
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
          sensitive:    el.sensitive    != null ? el.sensitive : false,
          redactionTag: el.redactionTag || undefined,
          hasValue:     isFilled,
        };
      }),
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

  function translateAction(backendAction, elements) {
    const { action, targetSelector, value } = backendAction;

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
            message: 'All form fields have been completed and verified. For your security, auto-submit is disabled — please review the page and click Submit when ready.'
          };
        }

        if (elementId == null) {
          console.warn('[AgentBackend] Target element selector not found for click:', targetSelector);
          return { action: 'wait', elementId: null, value: null };
        }
        return { action: 'click', elementId, value: null };
      }
      case 'fill': {
        const elementId = resolveElementId(targetSelector, elements);
        const el = Array.isArray(elements) ? elements.find((e) => e.selector === targetSelector || e.id === elementId) : null;

        const isFilled = el && (el.hasValue === true || (el.value != null && el.value !== ''));

        // If the field is ALREADY filled on the webpage, do not ask the user to fill it again!
        if (isFilled) {
          console.log(`[AgentBackend] Field ${targetSelector} is already filled on the page. Skipping.`);
          return { action: 'wait', elementId: null, value: null };
        }

        const isPasswordField = (el?.type === 'password') || 
                                (el?.type && String(el.type).includes('password')) ||
                                (targetSelector && targetSelector.toLowerCase().includes('password')) ||
                                (el?.text && el.text.toLowerCase().includes('password')) ||
                                (el?.placeholder && el.placeholder.toLowerCase().includes('password')) ||
                                (el?.ariaLabel && el.ariaLabel.toLowerCase().includes('password'));

        const isSensitive = el?.sensitive || isPasswordField;

        // Password & Sensitive fields MUST NEVER be auto-filled by backend dummy values!
        // Always require explicit user input via ask_user.
        if (value === null || value === undefined || value === 'null' || isSensitive) {
          const fieldLabel = el ? (el.text || el.placeholder || el.ariaLabel || targetSelector || 'Required Field') : (targetSelector || 'Required Field');
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

        if (elementId == null) {
          console.warn('[AgentBackend] Target element selector not found for fill:', targetSelector);
          return { action: 'wait', elementId: null, value: null };
        }

        return { action: 'type', elementId, value: value || '' };
      }
      case 'scroll':
        return { action: 'scroll', elementId: null, value: value || 'down' };
      case 'wait':
        return { action: 'wait', elementId: null, value: null };
      case 'done':
        return { action: 'done', elementId: null, value: null };
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
      } = payload;

      const meta    = await screenshotMeta(redactedScreenshotDataUrl);
      const base64  = dataUrlToBase64(redactedScreenshotDataUrl);

      const url           = pageUrl || (typeof location !== 'undefined' ? location.href : 'unknown');
      const domSkeleton   = buildDomSkeleton(url, elements);
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
      };

      const endpoint = await this.getEndpoint();
      let response;
      try {
        response = await fetch(endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(requestBody),
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

      const translated = translateAction(backendAction, elements);
      return translated;
    }

    resetSession() {
      this._sessionId = generateSessionId();
    }
  }

  root.__BA_AgentBackend = AgentBackend;

})(typeof window !== 'undefined' ? window : self);
