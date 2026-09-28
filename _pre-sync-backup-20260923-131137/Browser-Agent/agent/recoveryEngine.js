/**
 * agent/recoveryEngine.js
 *
 * Autonomous Agent Recovery & Loop Prevention Engine
 *
 * Gracefully detects and recovers from:
 * - stale elements & target disappearance
 * - unchanged DOM / failed clicks / failed typing
 * - modal dialogs, cookie banners & unexpected popups
 * - login / authentication requirements
 * - loading delays & network spinners
 * - disabled buttons & form validation errors
 * - infinite loops (identical actions, stagnant scroll, repeated typing, navigation loops)
 *
 * Follows the 9-step recovery protocol:
 * 1. Detect failure.
 * 2. Capture fresh page state.
 * 3. Determine whether the target still exists.
 * 4. Determine whether the intended state change already occurred.
 * 5. Determine why the action failed.
 * 6. Re-plan from the new state.
 * 7. Retry only if justified.
 * 8. Stop after bounded repeated failures.
 * 9. Ask user if progress cannot safely continue.
 */
(function (root) {
  const MAX_CONSECUTIVE_FAILURES = 3;

  const FAILURE_CAUSES = Object.freeze({
    INTENDED_CHANGE_ALREADY_DONE: 'INTENDED_CHANGE_ALREADY_DONE',
    TARGET_DISAPPEARED: 'TARGET_DISAPPEARED',
    DISABLED_ELEMENT: 'DISABLED_ELEMENT',
    MODAL_OVERLAY: 'MODAL_OVERLAY',
    COOKIE_BANNER: 'COOKIE_BANNER',
    LOGIN_REQUIRED: 'LOGIN_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    PAGE_LOADING: 'PAGE_LOADING',
    NO_EFFECT: 'NO_EFFECT',
    NAVIGATION_LOOP: 'NAVIGATION_LOOP',
    ACTION_LOOP: 'ACTION_LOOP',
    UNKNOWN_FAILURE: 'UNKNOWN_FAILURE'
  });

  const RECOVERY_STRATEGIES = Object.freeze({
    SKIP: 'SKIP',
    REPLAN_FRESH_DOM: 'REPLAN_FRESH_DOM',
    RESOLVE_MODAL: 'RESOLVE_MODAL',
    ACCEPT_COOKIES: 'ACCEPT_COOKIES',
    WAIT_FOR_USER: 'WAIT_FOR_USER',
    WAIT_ONCE: 'WAIT_ONCE',
    REPLAN_DIFFERENT_ACTION: 'REPLAN_DIFFERENT_ACTION',
    ABORT_TO_USER: 'ABORT_TO_USER'
  });

  class RecoveryEngine {
    constructor() {
      this.consecutiveFailures = 0;
      this.recentActions = [];
      this.lastScrollPosition = null;
    }

    reset() {
      this.consecutiveFailures = 0;
      this.recentActions = [];
      this.lastScrollPosition = null;
    }

    recordSuccess() {
      this.consecutiveFailures = 0;
    }

    /**
     * Detects action loops, stagnant scrolling, navigation loops, or oscillations.
     *
     * @param {Object} candidateAction - The proposed action
     * @param {Object} stateDiff - Diff since last step
     * @param {string} currentUrl - Current page URL
     * @returns {{ isLoop: boolean, type: string, description: string }}
     */
    detectLoop(candidateAction, stateDiff, currentUrl) {
      if (!candidateAction || candidateAction.action === 'done' || candidateAction.action === 'wait') {
        return { isLoop: false };
      }

      const sig = `${candidateAction.action}:${candidateAction.targetSelector || candidateAction.elementId || ''}:${candidateAction.value || ''}`;
      this.recentActions.push({ sig, action: candidateAction.action, target: candidateAction.targetSelector, value: candidateAction.value });
      if (this.recentActions.length > 8) this.recentActions.shift();

      // 1. Navigation loop: navigating to the page we are already on
      if (candidateAction.action === 'navigate' && candidateAction.value) {
        try {
          const targetUrl = new URL(candidateAction.value, currentUrl).href;
          if (targetUrl === currentUrl || currentUrl.startsWith(targetUrl)) {
            return {
              isLoop: true,
              type: FAILURE_CAUSES.NAVIGATION_LOOP,
              description: `Proposed navigation to "${candidateAction.value}" is already the current URL.`
            };
          }
        } catch (_) {}
      }

      // 2. Stagnant Scroll Loop: scroll -> scroll with no viewport change
      const lastTwo = this.recentActions.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every(a => a.action === 'scroll') && stateDiff && !stateDiff.hasChanges) {
        return {
          isLoop: true,
          type: FAILURE_CAUSES.NO_EFFECT,
          description: 'Repeated scrolling without page movement (hit boundary or stagnant viewport).'
        };
      }

      // 3. Identical Action Loop (A -> A -> A)
      const lastThree = this.recentActions.slice(-3);
      if (lastThree.length === 3 && lastThree.every(a => a.sig === sig) && stateDiff && !stateDiff.hasChanges) {
        return {
          isLoop: true,
          type: FAILURE_CAUSES.ACTION_LOOP,
          description: `Identical action "${candidateAction.action}" executed 3 times without page change.`
        };
      }

      // 4. Oscillating Loop (A -> B -> A -> B)
      const lastFour = this.recentActions.slice(-4);
      if (lastFour.length === 4 &&
          lastFour[0].sig === lastFour[2].sig &&
          lastFour[1].sig === lastFour[3].sig &&
          lastFour[0].sig !== lastFour[1].sig &&
          stateDiff && !stateDiff.hasChanges) {
        return {
          isLoop: true,
          type: FAILURE_CAUSES.ACTION_LOOP,
          description: `Oscillating action loop detected between "${lastFour[0].sig}" and "${lastFour[1].sig}".`
        };
      }

      return { isLoop: false };
    }

    /**
     * Diagnoses why an action failed and specifies the recovery strategy.
     *
     * @param {Object} params
     * @param {Object} params.decision
     * @param {Object} [params.targetEl]
     * @param {Array} [params.liveElements]
     * @param {Object} [params.pageContext]
     * @param {Object} [params.actionResult]
     * @param {string} [params.currentUrl]
     * @returns {{
     *   cause: string,
     *   strategy: string,
     *   message: string,
     *   canRetryAutonomously: boolean
     * }}
     */
    diagnose({ decision, targetEl, liveElements = [], pageContext, actionResult, currentUrl }) {
      // Check 1: Did the intended change already occur?
      if (targetEl && decision) {
        if (decision.action === 'check' && targetEl.checked === true) {
          return {
            cause: FAILURE_CAUSES.INTENDED_CHANGE_ALREADY_DONE,
            strategy: RECOVERY_STRATEGIES.SKIP,
            message: `Checkbox "${decision.targetSelector}" is already checked. No retry needed.`,
            canRetryAutonomously: true
          };
        }
        if (decision.action === 'uncheck' && targetEl.checked === false) {
          return {
            cause: FAILURE_CAUSES.INTENDED_CHANGE_ALREADY_DONE,
            strategy: RECOVERY_STRATEGIES.SKIP,
            message: `Checkbox "${decision.targetSelector}" is already unchecked. No retry needed.`,
            canRetryAutonomously: true
          };
        }
        if ((decision.action === 'fill' || decision.action === 'type') && decision.value && targetEl.value === decision.value) {
          return {
            cause: FAILURE_CAUSES.INTENDED_CHANGE_ALREADY_DONE,
            strategy: RECOVERY_STRATEGIES.SKIP,
            message: `Input "${decision.targetSelector}" already contains the desired value. No retry needed.`,
            canRetryAutonomously: true
          };
        }
      }

      // Check 2: Active Modal Overlay or Popup blocking
      if (pageContext?.activeModal?.isOpen) {
        return {
          cause: FAILURE_CAUSES.MODAL_OVERLAY,
          strategy: RECOVERY_STRATEGIES.RESOLVE_MODAL,
          message: `Modal dialog "${pageContext.activeModal.title || 'Dialog'}" is open and must be handled.`,
          canRetryAutonomously: true
        };
      }

      // Check 3: Cookie Banner detected
      const cookieBanner = liveElements.find(el => {
        const text = (el.text || el.ariaLabel || '').toLowerCase();
        return (text.includes('cookie') || text.includes('consent')) &&
               (text.includes('accept') || text.includes('agree') || text.includes('got it'));
      });
      if (cookieBanner) {
        return {
          cause: FAILURE_CAUSES.COOKIE_BANNER,
          strategy: RECOVERY_STRATEGIES.ACCEPT_COOKIES,
          message: `Cookie consent banner detected ("${cookieBanner.text}"). Proposing dismissal.`,
          canRetryAutonomously: true
        };
      }

      // Check 4: Login or Authentication wall
      const passwordField = liveElements.find(el => (el.type || '').includes('password') || el.sensitive);
      const isLoginSubmit = liveElements.some(el => {
        const text = (el.text || '').toLowerCase();
        return text === 'sign in' || text === 'log in' || text === 'login';
      });
      if (passwordField && isLoginSubmit) {
        return {
          cause: FAILURE_CAUSES.LOGIN_REQUIRED,
          strategy: RECOVERY_STRATEGIES.WAIT_FOR_USER,
          message: 'Page requires user authentication/login. Pausing for human sign-in.',
          canRetryAutonomously: false
        };
      }

      // Check 5: Live Validation Error
      const errorAlert = pageContext?.alerts?.find(a => a.type === 'error');
      if (errorAlert) {
        return {
          cause: FAILURE_CAUSES.VALIDATION_ERROR,
          strategy: RECOVERY_STRATEGIES.REPLAN_DIFFERENT_ACTION,
          message: `Form validation error: "${errorAlert.text}". Re-evaluating inputs.`,
          canRetryAutonomously: true
        };
      }

      // Check 6: Page Loading / Spinner
      if (pageContext?.loadingState?.isLoading) {
        return {
          cause: FAILURE_CAUSES.PAGE_LOADING,
          strategy: RECOVERY_STRATEGIES.WAIT_ONCE,
          message: `Page is loading (${pageContext.loadingState.indicator}). Proposing wait.`,
          canRetryAutonomously: true
        };
      }

      // Check 7: Target Disappeared / Stale Element
      if (!targetEl && decision?.targetSelector) {
        return {
          cause: FAILURE_CAUSES.TARGET_DISAPPEARED,
          strategy: RECOVERY_STRATEGIES.REPLAN_FRESH_DOM,
          message: `Target element "${decision.targetSelector}" is not present in live DOM.`,
          canRetryAutonomously: true
        };
      }

      // Check 8: Disabled Element
      if (targetEl && targetEl.enabled === false) {
        return {
          cause: FAILURE_CAUSES.DISABLED_ELEMENT,
          strategy: RECOVERY_STRATEGIES.REPLAN_DIFFERENT_ACTION,
          message: `Target element "${decision.targetSelector}" is disabled. Prior inputs may be required.`,
          canRetryAutonomously: true
        };
      }

      // Default: No effect or unknown execution failure
      return {
        cause: FAILURE_CAUSES.NO_EFFECT,
        strategy: RECOVERY_STRATEGIES.REPLAN_DIFFERENT_ACTION,
        message: actionResult?.details || 'Action completed without detectable progress.',
        canRetryAutonomously: true
      };
    }

    /**
     * Determines whether to attempt autonomous recovery or halt to HITL.
     *
     * @param {Object} diagnosis
     * @returns {{ shouldHalt: boolean, userMessage: string }}
     */
    evaluateNextStep(diagnosis) {
      this.consecutiveFailures++;

      if (!diagnosis.canRetryAutonomously || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return {
          shouldHalt: true,
          userMessage: `I paused automation after repeated obstacles: ${diagnosis.message}. Please review the page or guide me.`
        };
      }

      return {
        shouldHalt: false,
        userMessage: `Re-evaluating page state: ${diagnosis.message}`
      };
    }
  }

  root.__BA_RecoveryEngine = RecoveryEngine;
  root.__BA_FAILURE_CAUSES = FAILURE_CAUSES;
  root.__BA_RECOVERY_STRATEGIES = RECOVERY_STRATEGIES;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RecoveryEngine, FAILURE_CAUSES, RECOVERY_STRATEGIES };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
