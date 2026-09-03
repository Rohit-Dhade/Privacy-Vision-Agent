/**
 * agent/stateDiffEngine.js
 *
 * Lightweight Page State & Semantic Diff Engine
 *
 * Tracks page progression across agent steps by comparing structured
 * metadata between consecutive observations (URL changes, field population,
 * element addition/removal, visibility/enabled state changes).
 *
 * PRIVACY GUARANTEES:
 * 1. Operates on metadata only (e.g. `hasValue: false -> true`) — NEVER stores or compares actual values.
 * 2. Sanitizes URLs to remove sensitive query parameters (tokens, keys, personal data).
 * 3. Compact in-memory representation with bounded history.
 */
(function (root) {
  // Sensitive query parameter patterns to strip from URLs
  const SENSITIVE_QUERY_PATTERNS = [
    /token/i, /auth/i, /key/i, /secret/i, /password/i, /session/i,
    /email/i, /phone/i, /name/i, /code/i, /jwt/i, /access/i, /id_token/i
  ];

  class StateDiffEngine {
    /**
     * Sanitizes a URL string by stripping sensitive query parameters.
     * @param {string} urlString
     * @returns {string}
     */
    static sanitizeUrl(urlString) {
      if (!urlString || typeof urlString !== 'string') return 'unknown';
      try {
        const parsed = new URL(urlString);
        const searchParams = new URLSearchParams(parsed.search);
        const sanitizedParams = new URLSearchParams();

        for (const [key, val] of searchParams.entries()) {
          const isSensitive = SENSITIVE_QUERY_PATTERNS.some(p => p.test(key));
          if (!isSensitive) {
            sanitizedParams.set(key, val.slice(0, 50)); // cap param length
          } else {
            sanitizedParams.set(key, '[REDACTED]');
          }
        }

        const queryStr = sanitizedParams.toString();
        return `${parsed.origin}${parsed.pathname}${queryStr ? '?' + queryStr : ''}${parsed.hash || ''}`;
      } catch (_) {
        return urlString.split('?')[0]; // fallback: strip all query parameters
      }
    }

    /**
     * Captures a compact snapshot of the current page state.
     * @param {Object} extraction - DOM extraction result
     * @returns {Object}
     */
    static captureState(extraction) {
      if (!extraction || typeof extraction !== 'object') {
        return null;
      }

      const elements = Array.isArray(extraction.elements) ? extraction.elements : [];
      const elementMap = new Map();

      for (const el of elements) {
        const label = el.text || el.placeholder || el.ariaLabel || '';
        elementMap.set(String(el.id), {
          id: String(el.id),
          selector: el.selector || '',
          type: el.type || 'unknown',
          label: label.slice(0, 60),
          hasValue: el.hasValue === true || (el.value != null && el.value !== '' && el.value !== '[REDACTED]'),
          enabled: el.enabled !== false,
          visible: el.visible !== false,
          sensitive: Boolean(el.sensitive)
        });
      }

      return {
        timestamp: extraction.timestamp || Date.now(),
        url: this.sanitizeUrl(extraction.url || (typeof location !== 'undefined' ? location.href : 'unknown')),
        elementCount: elements.length,
        elementMap
      };
    }

    /**
     * Computes the semantic diff between previous and current page states.
     * @param {Object|null} previousState
     * @param {Object} currentState
     * @returns {{
     *   urlChanged: boolean,
     *   navigationOccurred: boolean,
     *   previousUrl: string | null,
     *   currentUrl: string,
     *   addedElements: Array<{ id: string, type: string, label: string }>,
     *   removedElements: Array<{ id: string, type: string, label: string }>,
     *   changedElements: Array<{ id: string, selector: string, label: string, changes: Object }>
     * }}
     */
    static computeDiff(previousState, currentState) {
      if (!currentState) {
        return {
          urlChanged: false,
          navigationOccurred: false,
          previousUrl: null,
          currentUrl: 'unknown',
          addedElements: [],
          removedElements: [],
          changedElements: []
        };
      }

      if (!previousState) {
        return {
          urlChanged: false,
          navigationOccurred: false,
          previousUrl: null,
          currentUrl: currentState.url,
          addedElements: [],
          removedElements: [],
          changedElements: []
        };
      }

      const urlChanged = previousState.url !== currentState.url;
      const prevMap = previousState.elementMap || new Map();
      const currMap = currentState.elementMap || new Map();

      const addedElements = [];
      const removedElements = [];
      const changedElements = [];

      // Check for added or modified elements
      for (const [id, currEl] of currMap.entries()) {
        const prevEl = prevMap.get(id);

        if (!prevEl) {
          addedElements.push({
            id: currEl.id,
            type: currEl.type,
            label: currEl.label
          });
        } else {
          const changes = {};

          if (prevEl.hasValue !== currEl.hasValue) {
            changes.hasValue = { from: prevEl.hasValue, to: currEl.hasValue };
          }
          if (prevEl.enabled !== currEl.enabled) {
            changes.enabled = { from: prevEl.enabled, to: currEl.enabled };
          }
          if (prevEl.visible !== currEl.visible) {
            changes.visible = { from: prevEl.visible, to: currEl.visible };
          }

          if (Object.keys(changes).length > 0) {
            changedElements.push({
              id: currEl.id,
              selector: currEl.selector,
              label: currEl.label,
              changes
            });
          }
        }
      }

      // Check for removed elements
      for (const [id, prevEl] of prevMap.entries()) {
        if (!currMap.has(id)) {
          removedElements.push({
            id: prevEl.id,
            type: prevEl.type,
            label: prevEl.label
          });
        }
      }

      return {
        urlChanged,
        navigationOccurred: urlChanged,
        previousUrl: previousState.url,
        currentUrl: currentState.url,
        addedElements: addedElements.slice(0, 10), // bounded
        removedElements: removedElements.slice(0, 10), // bounded
        changedElements: changedElements.slice(0, 15) // bounded
      };
    }

    /**
     * Formats a diff object into human-readable summary bullets for agent context.
     * @param {Object} diff
     * @returns {string[]}
     */
    static formatDiffSummary(diff) {
      if (!diff) return [];
      const lines = [];

      if (diff.urlChanged) {
        lines.push(`Navigation occurred: URL changed from "${diff.previousUrl}" to "${diff.currentUrl}"`);
      }

      if (diff.addedElements && diff.addedElements.length > 0) {
        const names = diff.addedElements.map(e => `"${e.label || e.type}"`).join(', ');
        lines.push(`New elements appeared: ${names}`);
      }

      if (diff.removedElements && diff.removedElements.length > 0) {
        const names = diff.removedElements.map(e => `"${e.label || e.type}"`).join(', ');
        lines.push(`Elements disappeared: ${names}`);
      }

      if (diff.changedElements && diff.changedElements.length > 0) {
        for (const ch of diff.changedElements) {
          const fieldDesc = ch.label ? `"${ch.label}" (#${ch.id})` : `Field #${ch.id}`;
          if (ch.changes.hasValue) {
            const status = ch.changes.hasValue.to ? 'populated' : 'emptied';
            lines.push(`${fieldDesc} became ${status}`);
          }
          if (ch.changes.enabled) {
            const status = ch.changes.enabled.to ? 'enabled' : 'disabled';
            lines.push(`${fieldDesc} became ${status}`);
          }
          if (ch.changes.visible) {
            const status = ch.changes.visible.to ? 'visible' : 'hidden';
            lines.push(`${fieldDesc} became ${status}`);
          }
        }
      }

      return lines;
    }
  }

  root.__BA_StateDiffEngine = StateDiffEngine;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StateDiffEngine };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
