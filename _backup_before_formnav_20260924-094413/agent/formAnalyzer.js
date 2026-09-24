/**
 * agent/formAnalyzer.js
 *
 * Local Form Analysis & Contextual Suggestion Engine
 *
 * Provides high-level understanding of on-page forms, completion status,
 * local store coverage, and derives non-intrusive contextual suggestions.
 *
 * PRIVACY GUARANTEES:
 * 1. ZERO private values are ever extracted, stored, or transmitted.
 * 2. Only aggregates counts (integers) and metadata flags.
 * 3. Operates entirely client-side using FieldMatcher and PrivateDataStore.has(key).
 */
(function (root) {
  class FormAnalyzer {
    /**
     * Determines whether an element is an interactive form input.
     * @param {Object} el
     * @returns {boolean}
     */
    static isFormInputElement(el) {
      if (!el || typeof el !== 'object') return false;
      const tag = (el.tag || '').toLowerCase();
      const type = (el.type || '').toLowerCase();

      // Exclude non-input interactive elements
      if (tag === 'button' || type === 'submit' || type === 'button' || type === 'reset' || type === 'hidden') {
        return false;
      }

      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return true;
      }

      if (type.startsWith('input:') && !type.includes('submit') && !type.includes('button')) {
        return true;
      }

      return false;
    }

    /**
     * Analyzes form fields in the current DOM extraction against the local PrivateDataStore.
     * Returns safe metadata counts only — NO values.
     * @param {Array<Object>} elements
     * @param {Object} privateDataStore
     * @returns {Promise<{
     *   formDetected: boolean,
     *   totalFields: number,
     *   alreadyCompleted: number,
     *   emptyFields: number,
     *   locallyMatchable: number,
     *   requiresUserInput: number
     * }>}
     */
    static async analyzeForm(elements, privateDataStore) {
      if (!Array.isArray(elements) || elements.length === 0) {
        return {
          formDetected: false,
          totalFields: 0,
          alreadyCompleted: 0,
          emptyFields: 0,
          locallyMatchable: 0,
          requiresUserInput: 0
        };
      }

      const formElements = elements.filter(this.isFormInputElement);
      const totalFields = formElements.length;

      if (totalFields === 0) {
        return {
          formDetected: false,
          totalFields: 0,
          alreadyCompleted: 0,
          emptyFields: 0,
          locallyMatchable: 0,
          requiresUserInput: 0
        };
      }

      let alreadyCompleted = 0;
      let locallyMatchable = 0;

      for (const el of formElements) {
        const hasVal = el.hasValue === true || (el.value != null && el.value !== '' && el.value !== '[REDACTED]');
        if (hasVal) {
          alreadyCompleted++;
          continue;
        }

        // Check if this empty field can be satisfied by local store
        if (root.__BA_FieldMatcher && privateDataStore) {
          try {
            const match = root.__BA_FieldMatcher.matchElement(el);
            if (match.matched && match.key) {
              const hasKey = await privateDataStore.has(match.key);
              if (hasKey) {
                locallyMatchable++;
              }
            }
          } catch (_) {}
        }
      }

      const emptyFields = totalFields - alreadyCompleted;
      const requiresUserInput = Math.max(0, emptyFields - locallyMatchable);

      return {
        formDetected: totalFields >= 1,
        totalFields,
        alreadyCompleted,
        emptyFields,
        locallyMatchable,
        requiresUserInput
      };
    }

    /**
     * Derives a high-level contextual suggestion based on page progression,
     * state diff, user interactions, and form analysis.
     * @param {Object} options
     * @returns {{ type: string, message: string } | null}
     */
    static deriveSuggestion(options = {}) {
      const {
        formSummary,
        stateDiff,
        userInteractions = [],
        mode = 'hitl',
        step = 0
      } = options;

      // 1. Navigation Progress
      if (stateDiff && stateDiff.urlChanged && stateDiff.currentUrl) {
        return {
          type: 'NAVIGATION_PROGRESS',
          message: `You've navigated to a new page (${stateDiff.currentUrl.split('?')[0]}).`
        };
      }

      // 2. User Attention / Resumed Input
      const hasRecentUserInput = userInteractions.some(i => i.action === 'field_change');
      const hasPopulatedField = stateDiff?.changedElements?.some(c => c.changes?.hasValue?.to === true);
      if (hasRecentUserInput || (step > 0 && hasPopulatedField && mode === 'complete')) {
        return {
          type: 'USER_ATTENTION',
          message: 'The previously requested information has been provided. Continuing form completion.'
        };
      }

      // 3. Form Completion
      if (formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0) {
        return {
          type: 'COMPLETION',
          message: 'All detected form fields are now filled and ready for your review.'
        };
      }

      // 4. Initial Form Analysis & Automation Available
      if (formSummary && formSummary.formDetected && step === 0) {
        if (mode === 'complete' && formSummary.locallyMatchable > 0) {
          if (formSummary.requiresUserInput === 0) {
            return {
              type: 'AUTOMATION_AVAILABLE',
              message: `All ${formSummary.totalFields} form fields can be completed automatically from your local private store.`
            };
          } else {
            return {
              type: 'AUTOMATION_AVAILABLE',
              message: `${formSummary.locallyMatchable} of ${formSummary.totalFields} form fields can be auto-filled from your local store (${formSummary.requiresUserInput} field requires your manual input).`
            };
          }
        }

        if (formSummary.emptyFields > 0) {
          return {
            type: 'FORM_PROGRESS',
            message: `Detected form with ${formSummary.totalFields} fields (${formSummary.alreadyCompleted} already filled, ${formSummary.emptyFields} remaining).`
          };
        }
      }

      // 5. Mid-progress Form Summary
      if (formSummary && formSummary.formDetected && formSummary.emptyFields > 0 && step > 0 && hasPopulatedField) {
        return {
          type: 'FORM_PROGRESS',
          message: `Form progress: ${formSummary.alreadyCompleted} of ${formSummary.totalFields} fields completed (${formSummary.emptyFields} remaining).`
        };
      }

      return null;
    }
  }

  root.__BA_FormAnalyzer = FormAnalyzer;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FormAnalyzer };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
