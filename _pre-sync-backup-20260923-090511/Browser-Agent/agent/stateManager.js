/**
 * agent/stateManager.js
 *
 * General-Purpose Finite State Machine
 *
 * Implements explicit task lifecycle states for arbitrary web tasks.
 *
 * Supported Canonical States:
 * - IDLE: Agent is waiting for task instruction
 * - OBSERVING: Capturing screenshot, extracting DOM, scanning PII/faces, redacting
 * - UNDERSTANDING: Computing state diffs, live DOM reconciliation, form analysis
 * - PLANNING: Assessing goal progress, determining next milestone
 * - WAITING_FOR_REASONER: Dispatching sanitized payload to VLM backend
 * - VALIDATING_ACTION: Checking action schemas, selector existence, safety rules
 * - EXECUTING_ACTION: Executing native browser action or local store fill
 * - VERIFYING_ACTION: Verifying state-change semantics and action outcome
 * - WAITING_FOR_USER: HITL visual spotlight guide or manual input request
 * - WAITING_FOR_CONFIRMATION: Human authorization gate for consequential actions
 * - REPLANNING: Recovery after failed action, loop detection, or stale target
 * - COMPLETED: Task goal successfully accomplished
 * - BLOCKED: Agent cannot proceed due to missing critical capability/permission
 * - FAILED: Unrecoverable execution error
 * - STOPPED: User pause or step cap reached
 */
(function (root) {
  const STATES = Object.freeze({
    IDLE: 'IDLE',
    OBSERVING: 'OBSERVING',
    UNDERSTANDING: 'UNDERSTANDING',
    PLANNING: 'PLANNING',
    WAITING_FOR_REASONER: 'WAITING_FOR_REASONER',
    VALIDATING_ACTION: 'VALIDATING_ACTION',
    EXECUTING_ACTION: 'EXECUTING_ACTION',
    VERIFYING_ACTION: 'VERIFYING_ACTION',
    WAITING_FOR_USER: 'WAITING_FOR_USER',
    WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
    REPLANNING: 'REPLANNING',
    COMPLETED: 'COMPLETED',
    BLOCKED: 'BLOCKED',
    FAILED: 'FAILED',
    STOPPED: 'STOPPED',

    // Legacy Sub-State Aliases (Maintained for full backward compatibility)
    TASK_RECEIVED: 'PLANNING',
    PAGE_ANALYSIS: 'OBSERVING',
    DOM_EXTRACTED: 'OBSERVING',
    PII_DETECTED: 'OBSERVING',
    SCREENSHOT_CAPTURED: 'OBSERVING',
    SCREENSHOT_REDACTED: 'OBSERVING',
    READY_FOR_AGENT: 'UNDERSTANDING',
    EXECUTING: 'EXECUTING_ACTION',
    ERROR: 'FAILED'
  });

  // Valid forward transitions in the agent lifecycle loop
  const TRANSITIONS = {
    IDLE: ['OBSERVING', 'PLANNING', 'TASK_RECEIVED', 'FAILED'],
    OBSERVING: ['UNDERSTANDING', 'PLANNING', 'REPLANNING', 'FAILED', 'BLOCKED', 'STOPPED'],
    UNDERSTANDING: ['PLANNING', 'WAITING_FOR_USER', 'WAITING_FOR_CONFIRMATION', 'COMPLETED', 'OBSERVING', 'REPLANNING', 'FAILED', 'STOPPED'],
    PLANNING: ['WAITING_FOR_REASONER', 'VALIDATING_ACTION', 'EXECUTING_ACTION', 'WAITING_FOR_USER', 'WAITING_FOR_CONFIRMATION', 'COMPLETED', 'REPLANNING', 'OBSERVING', 'FAILED', 'STOPPED'],
    WAITING_FOR_REASONER: ['VALIDATING_ACTION', 'REPLANNING', 'OBSERVING', 'FAILED', 'STOPPED'],
    VALIDATING_ACTION: ['EXECUTING_ACTION', 'WAITING_FOR_USER', 'WAITING_FOR_CONFIRMATION', 'REPLANNING', 'COMPLETED', 'OBSERVING', 'FAILED', 'STOPPED'],
    EXECUTING_ACTION: ['VERIFYING_ACTION', 'OBSERVING', 'REPLANNING', 'FAILED', 'STOPPED'],
    VERIFYING_ACTION: ['OBSERVING', 'UNDERSTANDING', 'PLANNING', 'REPLANNING', 'COMPLETED', 'FAILED', 'STOPPED'],
    WAITING_FOR_USER: ['OBSERVING', 'UNDERSTANDING', 'PLANNING', 'EXECUTING_ACTION', 'STOPPED', 'FAILED'],
    WAITING_FOR_CONFIRMATION: ['EXECUTING_ACTION', 'STOPPED', 'COMPLETED', 'OBSERVING', 'FAILED'],
    REPLANNING: ['OBSERVING', 'PLANNING', 'WAITING_FOR_REASONER', 'WAITING_FOR_USER', 'FAILED', 'BLOCKED', 'STOPPED'],
    COMPLETED: ['IDLE', 'OBSERVING', 'PLANNING', 'TASK_RECEIVED'],
    BLOCKED: ['IDLE', 'OBSERVING', 'PLANNING', 'REPLANNING', 'FAILED'],
    FAILED: ['IDLE', 'OBSERVING', 'PLANNING', 'TASK_RECEIVED'],
    STOPPED: ['IDLE', 'OBSERVING', 'PLANNING', 'TASK_RECEIVED']
  };

  class StateManager {
    constructor() {
      this.current = STATES.IDLE;
      this.history = [STATES.IDLE];
      this.listeners = [];
    }

    canTransition(next) {
      const normalizedNext = STATES[next] || next;
      const normalizedCurrent = STATES[this.current] || this.current;
      
      // FAILED and STOPPED are reachable from any state
      if (normalizedNext === STATES.FAILED || normalizedNext === STATES.STOPPED || normalizedNext === 'ERROR') {
        return true;
      }

      // Self-transitions allowed for continuous updates in same phase
      if (normalizedNext === normalizedCurrent) {
        return true;
      }

      const allowed = TRANSITIONS[normalizedCurrent] || [];
      return allowed.includes(normalizedNext) || allowed.includes(next);
    }

    transition(next) {
      const normalizedNext = STATES[next] || next;
      if (!this.canTransition(normalizedNext)) {
        console.warn(`[StateManager] Warning: Transitioning from ${this.current} to ${normalizedNext}`);
      }
      this.current = normalizedNext;
      this.history.push(normalizedNext);
      this.listeners.forEach((fn) => {
        try { fn(normalizedNext, this.history); } catch (_) {}
      });
      return this.current;
    }

    reset() {
      this.current = STATES.IDLE;
      this.history = [STATES.IDLE];
    }

    onChange(fn) {
      if (typeof fn === 'function') {
        this.listeners.push(fn);
      }
    }
  }

  root.__BA_STATES = STATES;
  root.__BA_StateManager = StateManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STATES, StateManager };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));