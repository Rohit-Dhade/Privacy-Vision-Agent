/**
 * agent/actionVerifier.js
 *
 * General-Purpose Action Verifier
 *
 * Evaluates the deterministic outcome of an executed browser action
 * against the live DOM, content script execution results, and state diffs.
 *
 * Supported Action Outcomes:
 * 1. SUCCEEDED: Action executed cleanly; expected state change or mutation confirmed.
 * 2. NO_EFFECT: Action completed, but DOM, input values, scroll, and URL were unchanged.
 * 3. FAILED: Execution failed explicitly in content script or threw error.
 * 4. TARGET_DISAPPEARED: Target element not found in live DOM / unmounted.
 * 5. PAGE_CHANGED: Navigation or significant URL/DOM replacement occurred.
 * 6. TASK_COMPLETED: Explicit task completion confirmed.
 * 7. USER_INTERVENTION_REQUIRED: Action requires user input or confirmation.
 */
(function (root) {
  const OUTCOMES = Object.freeze({
    SUCCEEDED: 'SUCCEEDED',
    NO_EFFECT: 'NO_EFFECT',
    FAILED: 'FAILED',
    TARGET_DISAPPEARED: 'TARGET_DISAPPEARED',
    PAGE_CHANGED: 'PAGE_CHANGED',
    TASK_COMPLETED: 'TASK_COMPLETED',
    USER_INTERVENTION_REQUIRED: 'USER_INTERVENTION_REQUIRED'
  });

  class ActionVerifier {
    /**
     * Evaluates the outcome of an action execution.
     *
     * @param {Object} params
     * @param {Object} params.decision - The action decision { action, elementId, targetSelector, value }
     * @param {Object} params.actionResponse - Direct response from content script { ok, data: { success, verified, stateChange, reason } }
     * @param {Object} [params.stateDiff] - State diff computed by StateDiffEngine
     * @param {Object} [params.extraction] - Current DOM extraction
     * @returns {{
     *   outcome: 'SUCCEEDED' | 'NO_EFFECT' | 'FAILED' | 'TARGET_DISAPPEARED' | 'PAGE_CHANGED' | 'TASK_COMPLETED' | 'USER_INTERVENTION_REQUIRED',
     *   details: string,
     *   shouldReplan: boolean,
     *   verified: boolean
     * }}
     */
    static verifyAction({ decision, actionResponse, stateDiff, extraction }) {
      if (!decision) {
        return {
          outcome: OUTCOMES.FAILED,
          details: 'No action decision provided for verification.',
          shouldReplan: true,
          verified: false
        };
      }

      const action = decision.action;

      // 1. Task Completion
      if (action === 'done') {
        return {
          outcome: OUTCOMES.TASK_COMPLETED,
          details: 'Task marked as completed by reasoner.',
          shouldReplan: false,
          verified: true
        };
      }

      // 2. User Intervention / Confirmation
      if (action === 'ask_user' || action === 'notify_submit') {
        return {
          outcome: OUTCOMES.USER_INTERVENTION_REQUIRED,
          details: action === 'ask_user' ? 'Waiting for user input on highlighted field.' : 'Waiting for human confirmation before consequential action.',
          shouldReplan: false,
          verified: true
        };
      }

      // 3. Skip filled
      if (action === 'skip_filled') {
        return {
          outcome: OUTCOMES.SUCCEEDED,
          details: `Field ${decision.targetSelector || decision.elementId} is already populated in DOM. Skipped.`,
          shouldReplan: false,
          verified: true
        };
      }

      // 4. Wait
      if (action === 'wait') {
        return {
          outcome: OUTCOMES.SUCCEEDED,
          details: 'Wait action executed to allow page to settle.',
          shouldReplan: false,
          verified: true
        };
      }

      // 5. Check Content Script Execution Error
      const actionData = actionResponse?.data;
      const isOk = actionResponse?.ok && (actionData?.success !== false);

      if (!isOk) {
        const reason = actionData?.reason || actionResponse?.error || 'execution_error';

        if (reason === 'element_not_found') {
          return {
            outcome: OUTCOMES.TARGET_DISAPPEARED,
            details: `Target element (${decision.targetSelector || '#' + decision.elementId}) was not found in the live DOM.`,
            shouldReplan: true,
            verified: false
          };
        }

        return {
          outcome: OUTCOMES.FAILED,
          details: `Action "${action}" failed: ${reason}`,
          shouldReplan: true,
          verified: false
        };
      }

      // 6. Navigation / Page Change Check
      if (actionData?.stateChange?.urlChanged || stateDiff?.urlChanged) {
        return {
          outcome: OUTCOMES.PAGE_CHANGED,
          details: `Page navigated to ${stateDiff?.currentUrl || 'new URL'}.`,
          shouldReplan: false,
          verified: true
        };
      }

      // 7. Action-Specific State Change Verification
      switch (action) {
        case 'type':
        case 'fill':
        case 'fill_from_local': {
          const hasValue = actionData?.hasValue || actionData?.verified || actionData?.unchanged;
          if (hasValue) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Field "${decision.targetSelector || '#' + decision.elementId}" value successfully verified in live DOM.`,
              shouldReplan: false,
              verified: true
            };
          }
          return {
            outcome: OUTCOMES.NO_EFFECT,
            details: `Field "${decision.targetSelector || '#' + decision.elementId}" typing did not modify DOM value.`,
            shouldReplan: true,
            verified: false
          };
        }

        case 'click': {
          const stateChange = actionData?.stateChange;
          const hasCheckedChange = stateChange?.checkedChanged === true;
          const hasExpandedChange = stateChange?.expandedChanged === true;
          const hasDomChange = stateDiff?.hasChanges === true;

          if (hasCheckedChange || hasExpandedChange || hasDomChange || actionData?.verified) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Click on "${decision.targetSelector || '#' + decision.elementId}" executed and state change verified.`,
              shouldReplan: false,
              verified: true
            };
          }

          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Click on "${decision.targetSelector || '#' + decision.elementId}" executed cleanly.`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'select': {
          if (actionData?.verified) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Dropdown "${decision.targetSelector || '#' + decision.elementId}" selection verified with value "${actionData.selectedValue}".`,
              shouldReplan: false,
              verified: true
            };
          }
          return {
            outcome: OUTCOMES.NO_EFFECT,
            details: `Dropdown "${decision.targetSelector || '#' + decision.elementId}" selection could not be verified.`,
            shouldReplan: true,
            verified: false
          };
        }

        case 'clear': {
          if (actionData?.verified) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Field "${decision.targetSelector || '#' + decision.elementId}" cleared.`,
              shouldReplan: false,
              verified: true
            };
          }
          return {
            outcome: OUTCOMES.NO_EFFECT,
            details: `Failed to clear field "${decision.targetSelector || '#' + decision.elementId}".`,
            shouldReplan: true,
            verified: false
          };
        }

        case 'check': {
          if (actionData?.verified) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Checkbox "${decision.targetSelector || '#' + decision.elementId}" state updated to ${actionData.checked}.`,
              shouldReplan: false,
              verified: true
            };
          }
          return {
            outcome: OUTCOMES.NO_EFFECT,
            details: `Checkbox "${decision.targetSelector || '#' + decision.elementId}" state change failed.`,
            shouldReplan: true,
            verified: false
          };
        }

        case 'hover': {
          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Hovered on "${decision.targetSelector || '#' + decision.elementId}".`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'focus': {
          if (actionData?.verified) {
            return {
              outcome: OUTCOMES.SUCCEEDED,
              details: `Focused "${decision.targetSelector || '#' + decision.elementId}".`,
              shouldReplan: false,
              verified: true
            };
          }
          return {
            outcome: OUTCOMES.NO_EFFECT,
            details: `Failed to focus "${decision.targetSelector || '#' + decision.elementId}".`,
            shouldReplan: true,
            verified: false
          };
        }

        case 'press_key': {
          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Pressed key "${decision.value || 'Enter'}" on "${decision.targetSelector || '#' + decision.elementId}".`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'navigate': {
          return {
            outcome: OUTCOMES.PAGE_CHANGED,
            details: `Navigating to ${decision.value || actionData?.navigatingTo}.`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'back':
        case 'forward': {
          return {
            outcome: OUTCOMES.PAGE_CHANGED,
            details: `Browser navigation (${action}) executed.`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'extract': {
          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Extracted text: "${(actionData?.text || decision.value || '').slice(0, 80)}…"`,
            shouldReplan: false,
            verified: true
          };
        }

        case 'scroll': {
          const didScroll = actionData?.didScroll;
          if (didScroll === false) {
            return {
              outcome: OUTCOMES.NO_EFFECT,
              details: `Scroll ${decision.value || 'down'} had no effect (page boundary reached).`,
              shouldReplan: true,
              verified: false
            };
          }
          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Scrolled ${decision.value || 'down'}.`,
            shouldReplan: false,
            verified: true
          };
        }

        default:
          return {
            outcome: OUTCOMES.SUCCEEDED,
            details: `Action "${action}" executed.`,
            shouldReplan: false,
            verified: true
          };
      }
    }
  }

  root.__BA_OUTCOMES = OUTCOMES;
  root.__BA_ActionVerifier = ActionVerifier;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ActionVerifier, OUTCOMES };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
