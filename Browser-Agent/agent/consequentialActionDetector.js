/**
 * agent/consequentialActionDetector.js
 *
 * Consequential Action & Human Authorization Gate
 *
 * Deterministically inspects extracted DOM elements to detect whether a
 * consequential, workflow-advancing, or irreversible action is being targeted
 * (e.g. Submit, Pay, Send, Place Order, Delete, Remove, Publish, Confirm).
 *
 * PRIVACY & SAFETY GUARANTEES:
 * 1. Operates entirely locally on DOM metadata — no remote API calls.
 * 2. Enforces Human-in-the-Loop authorization before executing any consequential action.
 * 3. Never auto-clicks submit, payment, delete, or external side-effect buttons.
 */
(function (root) {
  // UI dialog / navigation dismissal controls that do NOT cause external consequences
  const DISMISSAL_TERMS = [
    'back', 'close', 'reset', 'clear', 'edit', 'previous', 'prev',
    'help', 'expand', 'collapse', 'toggle', 'menu', 'settings', 'details', 'preview', 'view'
  ];

  // 1. Financial / Payment Transaction Patterns
  const PAYMENT_PATTERNS = [
    /\b(pay|pay now|make payment|confirm payment|pay\s+[₹$€£\d]|transfer|transfer funds|checkout|buy|buy now|purchase|place order|order now|subscribe|deposit|withdraw|complete payment)\b/i
  ];

  // 2. Destructive / Irreversible Deletion Patterns
  const DELETE_PATTERNS = [
    /\b(delete|delete account|remove account|destroy|purge|wipe|terminate|deactivate|uninstall|erase|permanently delete|delete my data)\b/i
  ];

  // 3. Consequential Cancellation Patterns (cancelling orders, bookings, subscriptions)
  const CANCEL_PATTERNS = [
    /\b(cancel\s+(?:order|subscription|booking|membership|flight|ticket|service|reservation|policy|plan|account)|cancel\s+my\s+(?:subscription|account))\b/i
  ];

  // 4. Public / External Communication Patterns
  const PUBLISH_PATTERNS = [
    /\b(publish|publish now|deploy|post publicly|broadcast|release|broadcast message|send tweet|publish post)\b/i
  ];

  // 5. Booking & Reservation Patterns
  const BOOK_PATTERNS = [
    /\b(book|book now|reserve|reserve seat|confirm booking|book flight|book hotel|confirm reservation|book ticket)\b/i
  ];

  // 6. Form Submission & External Send Patterns
  const SUBMIT_PATTERNS = [
    /\b(submit|submit application|submit form|submit kyc|submit quiz|submit exam|submit response|send message|send enquiry|send email|complete registration|confirm transaction|confirm order)\b/i
  ];

  // 7. Approval & Agreement Patterns
  const APPROVE_PATTERNS = [
    /\b(approve|approve request|approve expense|accept quote|accept offer|agree & continue|accept terms|authorize transfer|accept contract)\b/i
  ];

  // 8. Workflow Progression & Multi-Step Continuation
  const CONTINUE_PATTERNS = [
    /\b(continue to payment|proceed to checkout|proceed to payment|next step|finish|place request)\b/i
  ];

  class ConsequentialActionDetector {
    /**
     * Checks whether a single specific element or target selector is consequential
     * using element semantics, surrounding text, page context, task context, and reversibility.
     *
     * @param {Object|null} el
     * @param {string|null} targetSelector
     * @param {Object} [context] - { pageUrl, taskInstruction, pageContext, surroundingText }
     * @returns {{
     *   isConsequential: boolean,
     *   actionType: 'PAYMENT' | 'DELETE' | 'CANCEL' | 'PUBLISH' | 'BOOK' | 'SUBMIT' | 'APPROVE' | 'WORKFLOW_CONTINUE' | null,
     *   label: string,
     *   promptMessage: string,
     *   isReversible: boolean,
     *   riskLevel: 'HIGH' | 'MEDIUM' | 'LOW'
     * }}
     */
    static isConsequentialElement(el, targetSelector, context = {}) {
      if (!el && !targetSelector) {
        return { isConsequential: false, actionType: null, label: '', promptMessage: '', isReversible: true, riskLevel: 'LOW' };
      }

      const text = (el?.text || '').trim();
      const aria = (el?.ariaLabel || '').trim();
      const selector = (el?.selector || targetSelector || '').trim();
      const tagOrType = (el?.type || '').toLowerCase();
      const cleanLabel = text || aria || selector || 'Execute Action';
      const surrounding = (context.surroundingText || el?.surroundingText || '').toLowerCase();
      const pageUrl = (context.pageUrl || '').toLowerCase();
      const task = (context.taskInstruction || '').toLowerCase();
      const rawCombined = `${text} ${aria} ${selector} ${tagOrType}`.toLowerCase();

      // Check simple modal/dialog dismissals (e.g. "Close", "Back", or standalone "Cancel" on a modal)
      const isSimpleDismissal = DISMISSAL_TERMS.some(term => {
        const regex = new RegExp(`\\b${term}\\b`, 'i');
        return regex.test(text) || regex.test(aria);
      });
      // Standalone "cancel" without order/subscription is treated as dialog dismiss
      const isStandaloneCancel = /^cancel$/i.test(text) || /^cancel$/i.test(aria);
      if (isSimpleDismissal || (isStandaloneCancel && !rawCombined.includes('subscription') && !rawCombined.includes('order'))) {
        return { isConsequential: false, actionType: null, label: cleanLabel, promptMessage: '', isReversible: true, riskLevel: 'LOW' };
      }

      // 1. Delete / Destructive Actions
      for (const pat of DELETE_PATTERNS) {
        if (pat.test(rawCombined) || (pat.test(task) && (text.includes('confirm') || text.includes('yes')))) {
          return {
            isConsequential: true,
            actionType: 'DELETE',
            label: cleanLabel,
            promptMessage: `Irreversible destructive action detected: "${cleanLabel}". Are you sure you want to delete this permanently?`,
            isReversible: false,
            riskLevel: 'HIGH'
          };
        }
      }

      // 2. Cancellation of Services / Orders / Subscriptions
      for (const pat of CANCEL_PATTERNS) {
        if (pat.test(rawCombined) || (pat.test(task) && text.includes('confirm'))) {
          return {
            isConsequential: true,
            actionType: 'CANCEL',
            label: cleanLabel,
            promptMessage: `Cancellation action detected: "${cleanLabel}". Should I cancel this service/order?`,
            isReversible: false,
            riskLevel: 'HIGH'
          };
        }
      }

      // 3. Critical Financial / Payment Transactions
      for (const pat of PAYMENT_PATTERNS) {
        if (pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'PAYMENT',
            label: cleanLabel,
            promptMessage: `Financial transaction detected: "${cleanLabel}". Authorize payment/order?`,
            isReversible: false,
            riskLevel: 'HIGH'
          };
        }
      }

      // 3B. Contextual Payment Detection (Checkout URL + Price presence)
      const isFinancialPage = /checkout|payment|billing|subscribe|cart/i.test(pageUrl);
      const hasFinancialTerms = /[₹$€£]\s*\d+|total|subtotal|amount due/i.test(surrounding);
      if (isFinancialPage && (hasFinancialTerms || /pay|place|confirm|complete/i.test(text))) {
        return {
          isConsequential: true,
          actionType: 'PAYMENT',
          label: cleanLabel,
          promptMessage: `Payment checkout action detected: "${cleanLabel}". Authorize order placement?`,
          isReversible: false,
          riskLevel: 'HIGH'
        };
      }

      // 4. Booking Actions
      for (const pat of BOOK_PATTERNS) {
        if (pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'BOOK',
            label: cleanLabel,
            promptMessage: `Reservation/booking action detected: "${cleanLabel}". Confirm booking?`,
            isReversible: false,
            riskLevel: 'MEDIUM'
          };
        }
      }

      // 5. Public / External Communication Actions
      for (const pat of PUBLISH_PATTERNS) {
        if (pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'PUBLISH',
            label: cleanLabel,
            promptMessage: `Public post/deploy action detected: "${cleanLabel}". Authorize publishing?`,
            isReversible: false,
            riskLevel: 'MEDIUM'
          };
        }
      }

      // 6. Approval & Agreement Actions
      for (const pat of APPROVE_PATTERNS) {
        if (pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'APPROVE',
            label: cleanLabel,
            promptMessage: `Approval / binding agreement detected: "${cleanLabel}". Authorize acceptance?`,
            isReversible: false,
            riskLevel: 'HIGH'
          };
        }
      }

      // 7. Form Submission Actions (HTML submit or keywords)
      const isHtmlSubmit = tagOrType.includes('submit') || selector.includes('type="submit"');
      for (const pat of SUBMIT_PATTERNS) {
        if (isHtmlSubmit || pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'SUBMIT',
            label: cleanLabel,
            promptMessage: `Submission action detected: "${cleanLabel}". Confirm submission?`,
            isReversible: false,
            riskLevel: 'MEDIUM'
          };
        }
      }

      // 8. Workflow Progression into External / Financial Gates
      for (const pat of CONTINUE_PATTERNS) {
        if (pat.test(rawCombined)) {
          return {
            isConsequential: true,
            actionType: 'WORKFLOW_CONTINUE',
            label: cleanLabel,
            promptMessage: `Advancing to consequential step: "${cleanLabel}". Continue?`,
            isReversible: true,
            riskLevel: 'MEDIUM'
          };
        }
      }

      return { isConsequential: false, actionType: null, label: cleanLabel, promptMessage: '', isReversible: true, riskLevel: 'LOW' };
    }

    /**
     * Inspects extracted DOM elements to detect any consequential button on the page.
     * @param {Array<Object>} elements
     * @returns {{
     *   found: boolean,
     *   element: Object | null,
     *   elementId: number | string | null,
     *   targetSelector: string | null,
     *   label: string,
     *   actionType: string | null,
     *   promptMessage: string
     * }}
     */
    static detect(elements) {
      if (!Array.isArray(elements) || elements.length === 0) {
        return {
          found: false,
          element: null,
          elementId: null,
          targetSelector: null,
          label: '',
          actionType: null,
          promptMessage: 'All required fields are complete. What would you like me to do next?'
        };
      }

      for (const el of elements) {
        if (!el || el.visible === false || el.enabled === false) continue;
        const check = this.isConsequentialElement(el, el.selector);
        if (check.isConsequential) {
          return {
            found: true,
            element: el,
            elementId: el.id,
            targetSelector: el.selector,
            label: check.label,
            actionType: check.actionType,
            promptMessage: check.promptMessage
          };
        }
      }

      return {
        found: false,
        element: null,
        elementId: null,
        targetSelector: null,
        label: '',
        actionType: null,
        promptMessage: 'All required fields are complete. What would you like me to do next?'
      };
    }
  }

  root.__BA_ConsequentialActionDetector = ConsequentialActionDetector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ConsequentialActionDetector };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));

