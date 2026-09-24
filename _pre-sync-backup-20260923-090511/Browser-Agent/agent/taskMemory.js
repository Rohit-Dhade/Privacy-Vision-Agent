/**
 * agent/taskMemory.js
 *
 * Task State & Short-Term Memory Engine
 *
 * Tracks task-relevant metadata during the current workflow:
 * - actions attempted, succeeded, and failed
 * - pages visited (URL progression)
 * - important state transitions
 * - user interventions (HITL fields provided)
 * - confirmation decisions (consequential actions authorized)
 * - completed subgoals & current subgoal
 * - active blocked conditions
 *
 * CORE AUTHORITY RULE:
 * History = context
 * Live DOM = truth
 *
 * When history conflicts with the current page, CURRENT PAGE WINS.
 * Bounded history window (max 6 recent entries) prevents context drift.
 */
(function (root) {
  const MAX_HISTORY_WINDOW = 6;

  class TaskMemory {
    constructor() {
      this.reset();
    }

    reset() {
      this.pagesVisited = new Set();
      this.attemptedCount = 0;
      this.succeededCount = 0;
      this.failedCount = 0;
      this.recentActions = []; // bounded array of { action, target, value, outcome, verified, timestamp }
      this.stateTransitions = []; // e.g. [{ fromUrl, toUrl, timestamp }]
      this.userInterventions = new Map(); // fieldSelectorOrId -> { timestamp, label }
      this.confirmations = []; // [{ action, target, decision: 'GRANTED' | 'DENIED', timestamp }]
      this.completedSubgoals = [];
      this.currentSubgoal = null;
      this.activeBlockers = [];
      this.staleSelectors = new Set();
    }

    recordPageVisit(url) {
      if (url && url !== 'unknown') {
        const cleanUrl = url.split('#')[0];
        if (!this.pagesVisited.has(cleanUrl)) {
          this.pagesVisited.add(cleanUrl);
          if (this.pagesVisited.size > 1) {
            this.stateTransitions.push({
              type: 'NAVIGATION',
              toUrl: cleanUrl,
              timestamp: Date.now()
            });
          }
        }
      }
    }

    recordAttempt(decision) {
      this.attemptedCount++;
      // Track candidate action
      return this.attemptedCount;
    }

    recordResult(decision, verification) {
      const outcome = verification?.outcome || 'UNKNOWN';
      const isSuccess = outcome === 'SUCCEEDED' || outcome === 'PAGE_CHANGED' || outcome === 'TASK_COMPLETED';

      if (isSuccess) {
        this.succeededCount++;
        // Clear blocker if this action resolved it
        this.activeBlockers = [];
      } else {
        this.failedCount++;
        if (verification?.details) {
          this.activeBlockers.push({
            reason: verification.details,
            action: decision.action,
            target: decision.targetSelector,
            timestamp: Date.now()
          });
          if (this.activeBlockers.length > 3) this.activeBlockers.shift();
        }
      }

      const entry = {
        action: decision.action,
        target: decision.targetSelector || (decision.elementId ? `#${decision.elementId}` : null),
        outcome,
        verified: Boolean(verification?.verified),
        details: verification?.details || '',
        timestamp: Date.now()
      };

      this.recentActions.push(entry);
      if (this.recentActions.length > MAX_HISTORY_WINDOW) {
        this.recentActions.shift();
      }
    }

    recordUserIntervention(fieldIdOrSelector, label = '') {
      this.userInterventions.set(fieldIdOrSelector, {
        timestamp: Date.now(),
        label: label || fieldIdOrSelector
      });
    }

    recordConfirmation(action, target, granted) {
      this.confirmations.push({
        action,
        target,
        decision: granted ? 'GRANTED' : 'DENIED',
        timestamp: Date.now()
      });
      if (this.confirmations.length > 5) this.confirmations.shift();
    }

    updateSubgoal(subgoalDescription, isCompleted = false) {
      if (isCompleted && subgoalDescription) {
        if (!this.completedSubgoals.includes(subgoalDescription)) {
          this.completedSubgoals.push(subgoalDescription);
        }
      }
      this.currentSubgoal = subgoalDescription;
    }

    /**
     * CORE PRINCIPLE: Live DOM = Truth, History = Context.
     * Reconciles memory against live elements to detect stale state and ensure
     * current page state always takes precedence over historical assumptions.
     *
     * @param {Array} liveElements
     * @param {string} currentUrl
     * @param {Object} pageContext
     */
    reconcileWithLiveState(liveElements = [], currentUrl, pageContext) {
      this.recordPageVisit(currentUrl);

      // Build live lookup maps
      const liveSelectors = new Set();
      const populatedSelectors = new Set();
      const emptySelectors = new Set();

      for (const el of liveElements) {
        if (el.selector) {
          liveSelectors.add(el.selector);
          if (el.hasValue === true) {
            populatedSelectors.add(el.selector);
          } else {
            emptySelectors.add(el.selector);
          }
        }
      }

      // 1. Detect stale selectors from past actions that are no longer in DOM
      for (const act of this.recentActions) {
        if (act.target && !liveSelectors.has(act.target)) {
          this.staleSelectors.add(act.target);
        }
      }

      // 2. Clear any stale assumptions about populated fields if live DOM says they are empty
      for (const emptySel of emptySelectors) {
        // If live DOM is empty, it wins over any historical fill success
        const wasRecordedFilled = this.recentActions.some(
          a => a.target === emptySel && a.outcome === 'SUCCEEDED' && (a.action === 'fill' || a.action === 'type' || a.action === 'fill_from_local')
        );
        if (wasRecordedFilled) {
          // Log reconciliation note
          this.staleSelectors.delete(emptySel); // target is live, but value cleared
        }
      }

      // 3. Sync modal blocker state with live page context
      if (pageContext?.activeModal?.isOpen) {
        const modalBlocker = `Active modal open: "${pageContext.activeModal.title || 'Dialog'}"`;
        if (!this.activeBlockers.some(b => b.reason === modalBlocker)) {
          this.activeBlockers.push({ reason: modalBlocker, timestamp: Date.now() });
        }
      } else {
        // Modal is closed: remove any modal blockers
        this.activeBlockers = this.activeBlockers.filter(b => !b.reason?.includes('modal'));
      }
    }

    /**
     * Returns structured, bounded memory summary for reasoning prompts.
     */
    getSummary() {
      return {
        pagesVisited: Array.from(this.pagesVisited),
        counts: {
          attempted: this.attemptedCount,
          succeeded: this.succeededCount,
          failed: this.failedCount,
        },
        recentActions: this.recentActions.map(a => ({
          action: a.action,
          target: a.target,
          outcome: a.outcome,
          verified: a.verified
        })),
        userInterventions: Array.from(this.userInterventions.entries()).map(([k, v]) => ({
          field: k,
          label: v.label
        })),
        confirmations: this.confirmations.map(c => `${c.action} on ${c.target || 'target'}: ${c.decision}`),
        completedSubgoals: [...this.completedSubgoals],
        currentSubgoal: this.currentSubgoal,
        activeBlockers: this.activeBlockers.map(b => b.reason),
        staleSelectors: Array.from(this.staleSelectors)
      };
    }

    /**
     * Returns clean text formatting of task memory for context prompt.
     */
    formatContext() {
      const s = this.getSummary();
      const lines = [
        `Task Short-Term Memory (Context only; Live DOM is authoritative):`,
        `- Stats: ${s.counts.attempted} actions attempted (${s.counts.succeeded} succeeded, ${s.counts.failed} failed)`,
        `- Pages Visited: ${s.pagesVisited.length > 0 ? s.pagesVisited.join(' → ') : 'Current Page'}`,
      ];

      if (s.completedSubgoals.length > 0) {
        lines.push(`- Completed Subgoals: ${s.completedSubgoals.join('; ')}`);
      }
      if (s.currentSubgoal) {
        lines.push(`- Active Subgoal: ${s.currentSubgoal}`);
      }
      if (s.userInterventions.length > 0) {
        lines.push(`- User Manually Provided: ${s.userInterventions.map(u => u.label || u.field).join(', ')} (do not re-ask)`);
      }
      if (s.confirmations.length > 0) {
        lines.push(`- Confirmations: ${s.confirmations.join('; ')}`);
      }
      if (s.activeBlockers.length > 0) {
        lines.push(`- Current Blockers: ${s.activeBlockers.join('; ')}`);
      }
      if (s.recentActions.length > 0) {
        const recentStr = s.recentActions.map(a => `${a.action}(${a.target || 'page'}) → ${a.outcome}`).join('; ');
        lines.push(`- Recent Action History: ${recentStr}`);
      }

      return lines.join('\n');
    }
  }

  root.__BA_TaskMemory = TaskMemory;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TaskMemory };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
