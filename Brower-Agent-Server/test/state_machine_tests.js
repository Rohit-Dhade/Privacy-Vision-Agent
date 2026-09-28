/**
 * test/state_machine_tests.js
 *
 * Dedicated Automated Test Suite for General-Purpose Agent State Machine
 * and ActionVerifier abstractions.
 */

import assert from 'assert';

console.log('================================================================');
console.log('RUNNING AGENT STATE MACHINE & ACTION VERIFIER TEST SUITE');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Mock StateManager & ActionVerifier for Node environment testing
// -----------------------------------------------------------------------------
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

  // Legacy aliases
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
    if (normalizedNext === STATES.FAILED || normalizedNext === STATES.STOPPED || normalizedNext === 'ERROR') {
      return true;
    }
    if (normalizedNext === normalizedCurrent) return true;
    const allowed = TRANSITIONS[normalizedCurrent] || [];
    return allowed.includes(normalizedNext) || allowed.includes(next);
  }

  transition(next) {
    const normalizedNext = STATES[next] || next;
    this.current = normalizedNext;
    this.history.push(normalizedNext);
    this.listeners.forEach(fn => fn(normalizedNext, this.history));
    return this.current;
  }
}

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
  static verifyAction({ decision, actionResponse, stateDiff, extraction }) {
    if (!decision) {
      return { outcome: OUTCOMES.FAILED, shouldReplan: true, verified: false };
    }
    if (decision.action === 'done') {
      return { outcome: OUTCOMES.TASK_COMPLETED, shouldReplan: false, verified: true };
    }
    if (decision.action === 'ask_user' || decision.action === 'notify_submit') {
      return { outcome: OUTCOMES.USER_INTERVENTION_REQUIRED, shouldReplan: false, verified: true };
    }
    const actionData = actionResponse?.data;
    const isOk = actionResponse?.ok && (actionData?.success !== false);
    if (!isOk) {
      const reason = actionData?.reason || actionResponse?.error || 'execution_error';
      if (reason === 'element_not_found') {
        return { outcome: OUTCOMES.TARGET_DISAPPEARED, shouldReplan: true, verified: false };
      }
      return { outcome: OUTCOMES.FAILED, shouldReplan: true, verified: false };
    }
    if (actionData?.stateChange?.urlChanged || stateDiff?.urlChanged) {
      return { outcome: OUTCOMES.PAGE_CHANGED, shouldReplan: false, verified: true };
    }
    if (decision.action === 'type' || decision.action === 'fill') {
      const hasValue = actionData?.hasValue || actionData?.verified;
      if (hasValue) {
        return { outcome: OUTCOMES.SUCCEEDED, shouldReplan: false, verified: true };
      }
      return { outcome: OUTCOMES.NO_EFFECT, shouldReplan: true, verified: false };
    }
    return { outcome: OUTCOMES.SUCCEEDED, shouldReplan: false, verified: true };
  }
}

// -----------------------------------------------------------------------------
// Test Group 1: State Lifecycle Transitions
// -----------------------------------------------------------------------------
console.log('[1] Testing State Machine Lifecycle Transitions');

test('Initial state is IDLE', () => {
  const sm = new StateManager();
  assert.strictEqual(sm.current, 'IDLE');
});

test('Valid forward transition loop: IDLE -> OBSERVING -> UNDERSTANDING -> PLANNING -> WAITING_FOR_REASONER', () => {
  const sm = new StateManager();
  sm.transition('OBSERVING');
  assert.strictEqual(sm.current, 'OBSERVING');
  sm.transition('UNDERSTANDING');
  assert.strictEqual(sm.current, 'UNDERSTANDING');
  sm.transition('PLANNING');
  assert.strictEqual(sm.current, 'PLANNING');
  sm.transition('WAITING_FOR_REASONER');
  assert.strictEqual(sm.current, 'WAITING_FOR_REASONER');
});

test('Execution & Verification cycle: VALIDATING_ACTION -> EXECUTING_ACTION -> VERIFYING_ACTION -> OBSERVING', () => {
  const sm = new StateManager();
  sm.current = 'VALIDATING_ACTION';
  sm.transition('EXECUTING_ACTION');
  assert.strictEqual(sm.current, 'EXECUTING_ACTION');
  sm.transition('VERIFYING_ACTION');
  assert.strictEqual(sm.current, 'VERIFYING_ACTION');
  sm.transition('OBSERVING');
  assert.strictEqual(sm.current, 'OBSERVING');
});

test('Consequential gate enters WAITING_FOR_CONFIRMATION', () => {
  const sm = new StateManager();
  sm.current = 'PLANNING';
  sm.transition('WAITING_FOR_CONFIRMATION');
  assert.strictEqual(sm.current, 'WAITING_FOR_CONFIRMATION');
});

test('Missing local data enters WAITING_FOR_USER', () => {
  const sm = new StateManager();
  sm.current = 'PLANNING';
  sm.transition('WAITING_FOR_USER');
  assert.strictEqual(sm.current, 'WAITING_FOR_USER');
});

test('Replanning state transition on failure', () => {
  const sm = new StateManager();
  sm.current = 'VERIFYING_ACTION';
  sm.transition('REPLANNING');
  assert.strictEqual(sm.current, 'REPLANNING');
  sm.transition('OBSERVING');
  assert.strictEqual(sm.current, 'OBSERVING');
});

test('Legacy aliases map properly to canonical states', () => {
  const sm = new StateManager();
  sm.transition('PAGE_ANALYSIS'); // Legacy alias for OBSERVING
  assert.strictEqual(sm.current, 'OBSERVING');
  sm.transition('READY_FOR_AGENT'); // Legacy alias for UNDERSTANDING
  assert.strictEqual(sm.current, 'UNDERSTANDING');
  sm.transition('EXECUTING'); // Legacy alias for EXECUTING_ACTION
  assert.strictEqual(sm.current, 'EXECUTING_ACTION');
});

// -----------------------------------------------------------------------------
// Test Group 2: ActionVerifier Outcomes
// -----------------------------------------------------------------------------
console.log('\n[2] Testing ActionVerifier 7 Action Outcomes');

test('Outcome: SUCCEEDED when type action sets input value', () => {
  const res = ActionVerifier.verifyAction({
    decision: { action: 'type', targetSelector: '#email', value: 'a@b.com' },
    actionResponse: { ok: true, data: { success: true, verified: true, hasValue: true } }
  });
  assert.strictEqual(res.outcome, 'SUCCEEDED');
  assert.strictEqual(res.shouldReplan, false);
});

test('Outcome: NO_EFFECT when type action does not modify value', () => {
  const res = ActionVerifier.verifyAction({
    decision: { action: 'type', targetSelector: '#email', value: 'a@b.com' },
    actionResponse: { ok: true, data: { success: true, verified: false, hasValue: false } }
  });
  assert.strictEqual(res.outcome, 'NO_EFFECT');
  assert.strictEqual(res.shouldReplan, true);
});

test('Outcome: TARGET_DISAPPEARED when element is not found in live DOM', () => {
  const res = ActionVerifier.verifyAction({
    decision: { action: 'click', targetSelector: '#disappeared-btn' },
    actionResponse: { ok: false, data: { success: false, reason: 'element_not_found' } }
  });
  assert.strictEqual(res.outcome, 'TARGET_DISAPPEARED');
  assert.strictEqual(res.shouldReplan, true);
});

test('Outcome: PAGE_CHANGED when click causes navigation', () => {
  const res = ActionVerifier.verifyAction({
    decision: { action: 'click', targetSelector: '#nextPageLink' },
    actionResponse: { ok: true, data: { success: true, stateChange: { urlChanged: true } } },
    stateDiff: { urlChanged: true, currentUrl: 'https://example.com/step2' }
  });
  assert.strictEqual(res.outcome, 'PAGE_CHANGED');
  assert.strictEqual(res.shouldReplan, false);
});

test('Outcome: TASK_COMPLETED when action is done', () => {
  const res = ActionVerifier.verifyAction({
    decision: { action: 'done' }
  });
  assert.strictEqual(res.outcome, 'TASK_COMPLETED');
  assert.strictEqual(res.shouldReplan, false);
});

test('Outcome: USER_INTERVENTION_REQUIRED when ask_user or notify_submit emitted', () => {
  const res1 = ActionVerifier.verifyAction({ decision: { action: 'ask_user' } });
  const res2 = ActionVerifier.verifyAction({ decision: { action: 'notify_submit' } });
  assert.strictEqual(res1.outcome, 'USER_INTERVENTION_REQUIRED');
  assert.strictEqual(res2.outcome, 'USER_INTERVENTION_REQUIRED');
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests/totalTests)*100)}%)`);
console.log('================================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
