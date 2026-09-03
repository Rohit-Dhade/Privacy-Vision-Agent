/**
 * agent/visualDomGrounder.js
 *
 * Visual + DOM Fusion Grounding Engine
 *
 * Reconciles visual screenshot coordinates with structured semantic DOM:
 * 1. Converts screenshot coordinates to viewport CSS pixels with accurate scaling.
 * 2. Resolves coordinates against live DOM elements.
 * 3. Handles overlapping elements (prioritizes innermost/interactive element over backdrop/container).
 * 4. Handles buttons with icons (maps icon/span/svg clicks to interactive parent button).
 * 5. Handles tables and cards (selects specific interactive control rather than container).
 * 6. Handles modal dialogs (prioritizes elements inside active modal).
 * 7. Enforces the safety rule: NEVER allow vision to directly execute arbitrary coordinates.
 *    Only returns grounded, validated DOM element targets (with selector and elementId).
 */

(function (root) {
  const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a']);
  const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main', 'table', 'tbody', 'tr', 'td', 'ul', 'ol', 'li', 'span']);

  class VisualDomGrounder {
    /**
     * Grounds a coordinate point (from screenshot or viewport) to a validated DOM element.
     *
     * @param {{x:number, y:number}} point - coordinates
     * @param {Array<object>} elements - DOM elements with bounding boxes
     * @param {object} [options]
     * @param {{width:number, height:number}} [options.viewport]
     * @param {{width:number, height:number}} [options.imageDimensions]
     * @param {boolean} [options.isViewportSpace=false]
     * @param {string} [options.activeModalSelector]
     * @param {number} [options.maxDistancePx=45]
     * @returns {object} Grounding result
     */
    static groundPoint(point, elements, options = {}) {
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
        return { grounded: false, reason: 'Invalid or missing coordinate point' };
      }

      if (!Array.isArray(elements) || elements.length === 0) {
        return { grounded: false, reason: 'No DOM elements available for visual grounding' };
      }

      const viewport = options.viewport || { width: 1280, height: 800 };
      const imageDims = options.imageDimensions || { width: 1280, height: 800 };
      const isViewportSpace = options.isViewportSpace || false;
      const maxDist = options.maxDistancePx !== undefined ? options.maxDistancePx : 45;

      // Convert screenshot coordinates to viewport CSS pixels if needed
      let vx = point.x;
      let vy = point.y;
      if (!isViewportSpace && imageDims.width > 0 && imageDims.height > 0) {
        const scaleX = viewport.width / imageDims.width;
        const scaleY = viewport.height / imageDims.height;
        vx = point.x * scaleX;
        vy = point.y * scaleY;
      }

      // Filter to visible, enabled elements with valid box
      const validElements = elements.filter(el => {
        if (!el || !el.box) return false;
        if (el.enabled === false) return false;
        if (el.visible === false) return false;
        if (el.box.width <= 0 || el.box.height <= 0) return false;
        return true;
      });

      // 1. Direct Containment Check
      const containingElements = validElements.filter(el => {
        const { x, y, width, height } = el.box;
        return vx >= x && vx <= (x + width) && vy >= y && vy <= (y + height);
      });

      if (containingElements.length > 0) {
        // Resolve overlapping elements (e.g. Card vs Button inside card, Modal vs Close button, Icon inside button)
        const sorted = containingElements.sort((a, b) => {
          const scoreA = this._calculateSpecificityScore(a, options);
          const scoreB = this._calculateSpecificityScore(b, options);
          if (scoreB !== scoreA) return scoreB - scoreA;

          // If scores are equal, prefer smaller area (innermost child)
          const areaA = a.box.width * a.box.height;
          const areaB = b.box.width * b.box.height;
          return areaA - areaB;
        });

        const best = sorted[0];
        return {
          grounded: true,
          element: best,
          targetSelector: best.selector,
          elementId: best.id,
          method: 'EXACT_CONTAINMENT',
          distance: 0,
          viewportPoint: { x: vx, y: vy },
          confidence: 1.0
        };
      }

      // 2. Approximate Visual Proximity Check (Nearest interactive element)
      let closestElement = null;
      let minDistance = Infinity;

      for (const el of validElements) {
        const cx = el.box.x + (el.box.width / 2);
        const cy = el.box.y + (el.box.height / 2);
        const dist = Math.hypot(vx - cx, vy - cy);

        // Interactive elements get a distance advantage
        const isInteractive = INTERACTIVE_TAGS.has((el.tag || '').toLowerCase()) || el.type === 'button';
        const effectiveDist = isInteractive ? dist * 0.8 : dist;

        if (effectiveDist < minDistance) {
          minDistance = effectiveDist;
          closestElement = el;
        }
      }

      if (closestElement && minDistance <= maxDist) {
        return {
          grounded: true,
          element: closestElement,
          targetSelector: closestElement.selector,
          elementId: closestElement.id,
          method: 'APPROXIMATE_PROXIMITY',
          distance: Math.round(minDistance),
          viewportPoint: { x: vx, y: vy },
          confidence: Math.max(0.2, (maxDist - minDistance) / maxDist)
        };
      }

      return {
        grounded: false,
        reason: 'Visual coordinates do not map to any validated interactive DOM element',
        viewportPoint: { x: vx, y: vy }
      };
    }

    /**
     * Fuses visual reasoning with structured DOM action execution.
     * Enforces the rule: NEVER allow arbitrary ungrounded coordinate clicks.
     *
     * @param {object} action - Action proposed by reasoner
     * @param {Array<object>} elements - DOM elements
     * @param {object} [options]
     * @returns {object} { action: object, ok: boolean, reason?: string }
     */
    static fuseVisualWithDom(action, elements, options = {}) {
      if (!action || typeof action !== 'object') {
        return { ok: false, action, reason: 'Invalid action object' };
      }

      // If selector is already valid in DOM, accept it directly
      if (action.targetSelector && elements.some(el => el.selector === action.targetSelector)) {
        return { ok: true, action };
      }

      // If action has visual grounding point, attempt to ground it to a DOM element
      const visualPoint = action.visualGrounding?.approximatePoint || action.coordinates;
      if (visualPoint && typeof visualPoint.x === 'number' && typeof visualPoint.y === 'number') {
        const grounding = this.groundPoint(visualPoint, elements, options);
        if (grounding.grounded && grounding.targetSelector) {
          const updatedAction = {
            ...action,
            targetSelector: grounding.targetSelector,
            elementId: grounding.elementId,
            groundedByVision: true,
            groundingMethod: grounding.method
          };
          return { ok: true, action: updatedAction };
        } else {
          // Reject arbitrary coordinate click
          return {
            ok: false,
            action,
            reason: `Visual coordinate (${visualPoint.x}, ${visualPoint.y}) could not be mapped to any validated DOM target. Arbitrary coordinate execution is disallowed.`
          };
        }
      }

      return { ok: true, action };
    }

    /**
     * Helper to compute specificity score for overlapping elements.
     */
    static _calculateSpecificityScore(element, options = {}) {
      let score = 0;
      const tag = (element.tag || '').toLowerCase();

      // Interactive elements receive highest priority
      if (INTERACTIVE_TAGS.has(tag)) score += 500;
      if (element.type === 'button' || element.type === 'submit') score += 200;
      if (element.text && element.text.trim().length > 0) score += 50;
      if (element.ariaLabel) score += 50;

      // Active modal priority
      if (element.inModal || (options.activeModalSelector && element.selector?.includes(options.activeModalSelector))) {
        score += 300;
      }

      // Demote pure structural containers if overlapping with interactive elements
      if (CONTAINER_TAGS.has(tag) && !element.text && !element.ariaLabel) {
        score -= 200;
      }

      return score;
    }
  }

  root.__BA_VisualDomGrounder = VisualDomGrounder;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VisualDomGrounder };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
