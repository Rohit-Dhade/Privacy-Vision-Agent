/**
 * agent/privacyBoundary.js
 *
 * Structurally Enforceable Privacy Boundary & Allowlist Sanitizer
 *
 * Enforces the strict privacy boundary between local browser perception/state
 * and remote AI reasoners:
 *
 * 1. Explicit allowlists for all data crossing the boundary.
 * 2. Complete stripping of forbidden fields (e.g. values, passwords, credentials).
 * 3. History value neutralization (only placeholder tokens allowed).
 * 4. Adversarial pre-flight scanning to abort any accidental PII transmission.
 */

(function (root) {
  const ALLOWED_ELEMENT_KEYS = new Set([
    'id', 'tag', 'type', 'selector', 'box', 'sensitive', 'redactionTag',
    'hasValue', 'text', 'ariaLabel', 'placeholder', 'enabled', 'visible',
    'isSearch', 'isPagination', 'inModal', 'inNav', 'isSticky', 'formId',
    'options', 'radioGroup', 'accept', 'multiple', 'isUntrustedPromptInjection'
  ]);

  const ALLOWED_HISTORY_KEYS = new Set([
    'action', 'targetSelector', 'elementId', 'fieldName', 'value', 'result',
    'outcome', 'matchedKey', 'authorizedByUser', 'plan', 'extractedData'
  ]);

  const ALLOWED_REQUEST_KEYS = new Set([
    'sessionId', 'taskInstruction', 'capturedAt', 'screenshot',
    'domSkeleton', 'redactionMap', 'actionHistory', 'stateDiff',
    'userInteractions', 'formSummary', 'pageContext', 'taskPlan', 'taskMemory'
  ]);

  const PERMITTED_VALUE_TOKENS = new Set([
    null, undefined, '', '[REDACTED]', '[FILLED_FROM_LOCAL]', '[ALREADY_POPULATED]'
  ]);

  // Sensitive PII & credential detection patterns for adversarial scanning
  const ADVERSARIAL_PATTERNS = [
    // Credit card (13 to 19 digits, with or without spaces/hyphens)
    { name: 'CREDIT_CARD', regex: /\b(?:4[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{1,4}|5[1-5][0-9]{2}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}|3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}|4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/ },
    // Indian PAN (5 letters, 4 digits, 1 letter)
    { name: 'PAN_CARD', regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/ },
    // Aadhaar (exactly 12 digits in 3 groups of 4 separated by space or hyphen, not 16 digits)
    { name: 'AADHAAR', regex: /(?<!\d)\b\d{4}[ -]\d{4}[ -]\d{4}\b(?!\s*[-]?\s*\d{4})/ },
    // Raw password in key-value format
    { name: 'PASSWORD_FIELD', regex: /\b(?:password|passwd|pwd|passcode|secret|api[_-]?key)\s*[:=]\s*["']?[^\s,"']{4,}/i }
  ];

  const INJECTION_DEFENSE_PATTERNS = [
    /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
    /\byou\s+are\s+now\s+(?:an?\s+)?(?:unrestricted|developer|jailbroken|dan)\b/i,
    /\bsystem\s+message\s*:/i,
    /\breveal\s+(?:the\s+)?(?:user'?s?\s+)?(?:private|credentials|password|data)\b/i,
    /\bsend\s+(?:user\s+)?credentials\s+to\b/i,
    /\bdisregard\s+(?:all\s+)?(?:safety|system|agent)\s+guidelines\b/i,
    /\bclick\s+this\s+button\s+immediately\b/i
  ];

  class PrivacyBoundaryViolationError extends Error {
    constructor(reason, details = {}) {
      super(`[Privacy Boundary Violation] ${reason}`);
      this.name = 'PrivacyBoundaryViolationError';
      this.details = details;
    }
  }

  class PrivacyBoundary {
    /**
     * Sanitizes a single DOM element record against the strict element allowlist.
     */
    static sanitizeElement(element) {
      if (!element || typeof element !== 'object') return null;

      const sanitized = {};
      for (const key of Object.keys(element)) {
        if (ALLOWED_ELEMENT_KEYS.has(key)) {
          sanitized[key] = element[key];
        }
      }

      // If sensitive or contains sensitive PII patterns in labels, redact label text
      if (sanitized.sensitive === true) {
        if (sanitized.placeholder) sanitized.placeholder = '[REDACTED]';
      }

      for (const { regex } of ADVERSARIAL_PATTERNS) {
        if (sanitized.text && regex.test(sanitized.text)) {
          sanitized.text = '[REDACTED_PII]';
        }
        if (sanitized.placeholder && regex.test(sanitized.placeholder)) {
          sanitized.placeholder = '[REDACTED_PII]';
        }
        if (sanitized.ariaLabel && regex.test(sanitized.ariaLabel)) {
          sanitized.ariaLabel = '[REDACTED_PII]';
        }
      }

      // Prompt Injection Defanging
      for (const injRegex of INJECTION_DEFENSE_PATTERNS) {
        if (sanitized.text && injRegex.test(sanitized.text)) {
          sanitized.text = '[UNTRUSTED_CONTENT_DEFANGED: Prompt Injection Blocked]';
          sanitized.isUntrustedPromptInjection = true;
        }
        if (sanitized.placeholder && injRegex.test(sanitized.placeholder)) {
          sanitized.placeholder = '[UNTRUSTED_CONTENT_DEFANGED: Prompt Injection Blocked]';
          sanitized.isUntrustedPromptInjection = true;
        }
        if (sanitized.ariaLabel && injRegex.test(sanitized.ariaLabel)) {
          sanitized.ariaLabel = '[UNTRUSTED_CONTENT_DEFANGED: Prompt Injection Blocked]';
          sanitized.isUntrustedPromptInjection = true;
        }
      }

      return sanitized;
    }

    /**
     * Sanitizes an action history entry, ensuring no raw entered values ever cross.
     */
    static sanitizeHistoryItem(item) {
      if (!item || typeof item !== 'object') return null;

      const sanitized = {};
      for (const key of Object.keys(item)) {
        if (ALLOWED_HISTORY_KEYS.has(key)) {
          sanitized[key] = item[key];
        }
      }

      // Strictly neutralize the value property
      if (sanitized.value !== undefined && sanitized.value !== null) {
        if (!PERMITTED_VALUE_TOKENS.has(sanitized.value)) {
          sanitized.value = '[REDACTED]';
        }
      }

      return sanitized;
    }

    /**
     * Sanitizes the complete outbound request payload before network transmission.
     */
    static sanitizeOutboundPayload(payload) {
      if (!payload || typeof payload !== 'object') return payload;

      const sanitized = {};
      for (const key of Object.keys(payload)) {
        if (ALLOWED_REQUEST_KEYS.has(key)) {
          sanitized[key] = payload[key];
        }
      }

      // 1. Sanitize domSkeleton elements
      if (sanitized.domSkeleton && Array.isArray(sanitized.domSkeleton.elements)) {
        sanitized.domSkeleton = {
          ...sanitized.domSkeleton,
          elements: sanitized.domSkeleton.elements.map(el => this.sanitizeElement(el)).filter(Boolean)
        };
      }

      // 2. Sanitize actionHistory
      if (Array.isArray(sanitized.actionHistory)) {
        sanitized.actionHistory = sanitized.actionHistory.map(item => this.sanitizeHistoryItem(item)).filter(Boolean);
      }

      return sanitized;
    }

    /**
     * Adversarial scan of the serialized JSON payload.
     * Throws PrivacyBoundaryViolationError if any raw credential or unredacted secret is detected.
     */
    static assertSafeForTransmission(payload) {
      const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);

      for (const { name, regex } of ADVERSARIAL_PATTERNS) {
        if (regex.test(serialized)) {
          throw new PrivacyBoundaryViolationError(
            `Attempted transmission of unredacted ${name} across the network boundary. Blocked locally.`,
            { pattern: name }
          );
        }
      }

      return true;
    }
  }

  root.__BA_PrivacyBoundary = PrivacyBoundary;
  root.__BA_PrivacyBoundaryViolationError = PrivacyBoundaryViolationError;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PrivacyBoundary, PrivacyBoundaryViolationError };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
