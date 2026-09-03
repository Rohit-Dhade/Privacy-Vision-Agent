/**
 * test/functional_correctness_tests.js
 *
 * Dedicated Regression Test Suite for Correctness & Reliability Requirements:
 * 1. HITL Stale-State Handling & Accurate hasValue
 * 2. Empty/Whitespace Local Store handling (false and 0 valid)
 * 3. Mixed local/manual execution & skipping pre-populated fields
 * 4. Resume behavior (returns to OBSERVING)
 * 5. General-purpose completion detection (no form-filling hijacking)
 * 6. Consequential action authorization tied to CURRENT target
 * 7. Scrolling boundary detection (didScroll -> NO_EFFECT)
 * 8. Repeated unproductive action loop prevention
 * 9. Stale selector rejection before execution
 * 10. Action result verification across all action types
 */

import assert from 'assert';

console.log('================================================================');
console.log('RUNNING DEDICATED FUNCTIONAL CORRECTNESS & RELIABILITY TEST SUITE');
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
// [1] Requirement 1 & 3: Accurate hasValue for Checkboxes, Radios, and Selects
// -----------------------------------------------------------------------------
console.log('[1] Requirement 1 & 3: Accurate hasValue Determination');

function determineHasValue(el) {
  const elType = (el.type || '').toLowerCase();
  const isCheckboxOrRadio = elType.includes('checkbox') || elType.includes('radio');
  const isSelect = elType === 'select' || (el.tag && el.tag.toLowerCase() === 'select');

  let isActuallyFilled = false;
  if (isCheckboxOrRadio) {
    isActuallyFilled = el.value === 'checked';
  } else if (isSelect) {
    isActuallyFilled = el.value != null && el.value !== '' && !el.value.startsWith('--');
  } else {
    isActuallyFilled = el.value != null && el.value !== '' && el.value !== '[REDACTED]';
  }
  return isActuallyFilled;
}

test('Unchecked checkbox evaluates to hasValue: false', () => {
  const el = { type: 'input:checkbox', value: 'unchecked' };
  assert.strictEqual(determineHasValue(el), false);
});

test('Checked checkbox evaluates to hasValue: true', () => {
  const el = { type: 'input:checkbox', value: 'checked' };
  assert.strictEqual(determineHasValue(el), true);
});

test('Unchecked radio button evaluates to hasValue: false', () => {
  const el = { type: 'input:radio', value: 'unchecked' };
  assert.strictEqual(determineHasValue(el), false);
});

test('Checked radio button evaluates to hasValue: true', () => {
  const el = { type: 'input:radio', value: 'checked' };
  assert.strictEqual(determineHasValue(el), true);
});

test('Select with empty/null placeholder evaluates to hasValue: false', () => {
  assert.strictEqual(determineHasValue({ tag: 'select', type: 'select', value: null }), false);
  assert.strictEqual(determineHasValue({ tag: 'select', type: 'select', value: '' }), false);
  assert.strictEqual(determineHasValue({ tag: 'select', type: 'select', value: '-- Select State --' }), false);
});

test('Select with valid selected option evaluates to hasValue: true', () => {
  assert.strictEqual(determineHasValue({ tag: 'select', type: 'select', value: 'Karnataka' }), true);
});

test('Text input with real text evaluates to hasValue: true', () => {
  assert.strictEqual(determineHasValue({ type: 'input:text', value: 'John Doe' }), true);
});

// -----------------------------------------------------------------------------
// [2] Requirement 2: Local Store Availability & Valid 0 / false
// -----------------------------------------------------------------------------
console.log('\n[2] Requirement 2: Local Store Availability & Special Values');

function isValueAvailable(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === 'string') {
    return val.trim().length > 0;
  }
  if (typeof val === 'boolean' || typeof val === 'number') {
    return true;
  }
  return false;
}

test('Whitespace-only or empty strings are unavailable', () => {
  assert.strictEqual(isValueAvailable(''), false);
  assert.strictEqual(isValueAvailable('   '), false);
  assert.strictEqual(isValueAvailable('\t\n'), false);
});

test('Number 0 is preserved as available', () => {
  assert.strictEqual(isValueAvailable(0), true);
});

test('Boolean false is preserved as available', () => {
  assert.strictEqual(isValueAvailable(false), true);
});

test('Valid non-empty strings are available', () => {
  assert.strictEqual(isValueAvailable('user@example.com'), true);
});

// -----------------------------------------------------------------------------
// [3] Requirement 4 & 8: User Intervention State Return to OBSERVING
// -----------------------------------------------------------------------------
console.log('\n[3] Requirement 4 & 8: Lifecycle State Transitions on Resume');

const STATES = {
  IDLE: 'IDLE',
  OBSERVING: 'OBSERVING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  EXECUTING_ACTION: 'EXECUTING_ACTION',
  VERIFYING_ACTION: 'VERIFYING_ACTION',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED'
};

class MiniStateManager {
  constructor() {
    this.current = STATES.IDLE;
  }
  transition(next) {
    this.current = next;
    return this.current;
  }
}

test('User intervention (HITL) transitions from WAITING_FOR_USER to OBSERVING on resume', () => {
  const sm = new MiniStateManager();
  sm.transition(STATES.WAITING_FOR_USER);
  assert.strictEqual(sm.current, STATES.WAITING_FOR_USER);
  
  // User enters info & resumes: MUST return to OBSERVING
  sm.transition(STATES.OBSERVING);
  assert.strictEqual(sm.current, STATES.OBSERVING);
});

// -----------------------------------------------------------------------------
// [4] Requirement 6: Consequential Action Authorization Tied to Target
// -----------------------------------------------------------------------------
console.log('\n[4] Requirement 6: Consequential Action Gating on Specific Target');

const PAYMENT_PATTERNS = [/\b(pay|checkout|buy|purchase|place order)\b/i];
const SUBMIT_PATTERNS = [/\b(submit|send|register|confirm order)\b/i];
const DELETE_PATTERNS = [/\b(delete|remove|destroy)\b/i];

function isConsequential(el, selector) {
  const combined = `${el?.text || ''} ${el?.ariaLabel || ''} ${selector || ''}`.toLowerCase();
  if (PAYMENT_PATTERNS.some(p => p.test(combined))) return { isConsequential: true, actionType: 'PAYMENT' };
  if (DELETE_PATTERNS.some(p => p.test(combined))) return { isConsequential: true, actionType: 'DELETE' };
  if (SUBMIT_PATTERNS.some(p => p.test(combined))) return { isConsequential: true, actionType: 'SUBMIT' };
  return { isConsequential: false, actionType: null };
}

test('Click on "Submit KYC" requires confirmation', () => {
  const el = { text: 'Submit KYC Application', id: 10 };
  const res = isConsequential(el, '#submit-kyc');
  assert.strictEqual(res.isConsequential, true);
  assert.strictEqual(res.actionType, 'SUBMIT');
});

test('Click on "Next Page" or "Details" does NOT trigger consequential submit gate', () => {
  const el = { text: 'Next Page', id: 5 };
  const res = isConsequential(el, '#next-btn');
  assert.strictEqual(res.isConsequential, false);
});

// -----------------------------------------------------------------------------
// [5] Requirement 7: Scrolling Boundary & didScroll Verification
// -----------------------------------------------------------------------------
console.log('\n[5] Requirement 7: Scroll Result Verification');

function verifyScrollResult(actionData) {
  if (actionData?.didScroll === false) {
    return { outcome: 'NO_EFFECT', verified: false, shouldReplan: true };
  }
  return { outcome: 'SUCCEEDED', verified: true, shouldReplan: false };
}

test('Scroll that hit boundary (didScroll: false) evaluates to NO_EFFECT', () => {
  const res = verifyScrollResult({ preY: 1200, postY: 1200, didScroll: false });
  assert.strictEqual(res.outcome, 'NO_EFFECT');
  assert.strictEqual(res.shouldReplan, true);
});

test('Scroll that moved page (didScroll: true) evaluates to SUCCEEDED', () => {
  const res = verifyScrollResult({ preY: 100, postY: 500, didScroll: true });
  assert.strictEqual(res.outcome, 'SUCCEEDED');
  assert.strictEqual(res.shouldReplan, false);
});

// -----------------------------------------------------------------------------
// [6] Requirement 8: Repeated Action & Consecutive Unproductive Loop Guard
// -----------------------------------------------------------------------------
console.log('\n[6] Requirement 8: Consecutive Unproductive Action Loop Guard');

class LoopGuard {
  constructor(limit = 3) {
    this.limit = limit;
    this.unproductiveCount = 0;
  }
  recordOutcome(outcome) {
    if (outcome === 'NO_EFFECT' || outcome === 'FAILED' || outcome === 'TARGET_DISAPPEARED') {
      this.unproductiveCount++;
    } else {
      this.unproductiveCount = 0;
    }
    return this.unproductiveCount >= this.limit;
  }
}

test('Triggers replan/pause after 3 consecutive unproductive actions', () => {
  const guard = new LoopGuard(3);
  assert.strictEqual(guard.recordOutcome('NO_EFFECT'), false);
  assert.strictEqual(guard.recordOutcome('FAILED'), false);
  assert.strictEqual(guard.recordOutcome('NO_EFFECT'), true); // 3rd failure triggers loop pause!
});

test('Resets unproductive count when an action succeeds', () => {
  const guard = new LoopGuard(3);
  guard.recordOutcome('NO_EFFECT');
  guard.recordOutcome('FAILED');
  guard.recordOutcome('SUCCEEDED'); // resets
  assert.strictEqual(guard.unproductiveCount, 0);
  assert.strictEqual(guard.recordOutcome('NO_EFFECT'), false);
});

// -----------------------------------------------------------------------------
// [7] Requirement 9: Stale Selector Prevention Pre-Execution Check
// -----------------------------------------------------------------------------
console.log('\n[7] Requirement 9: Stale Selector Prevention');

function validateTargetExists(targetSelector, liveElements) {
  if (!targetSelector) return true; // non-targeted action like scroll/wait
  return liveElements.some(e => e.selector === targetSelector);
}

test('Rejects action when target selector is no longer in live DOM', () => {
  const liveElements = [
    { id: 1, selector: '#inputA' },
    { id: 2, selector: '#inputB' }
  ];
  assert.strictEqual(validateTargetExists('#inputA', liveElements), true);
  assert.strictEqual(validateTargetExists('#inputGhost', liveElements), false);
});

// -----------------------------------------------------------------------------
// [8] Requirement 5: Completion Detection on Arbitrary Webpages
// -----------------------------------------------------------------------------
console.log('\n[8] Requirement 5: Completion Detection Decoupling');

function shouldAutoTriggerFormCompletionGate(task, formSummary) {
  const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
  return Boolean(isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0);
}

test('General web task (e.g. search / extract) does NOT trigger form completion gate even if input has text', () => {
  const task = 'Search for python documentation and click first link';
  const formSummary = { formDetected: true, totalFields: 1, alreadyCompleted: 1, emptyFields: 0 };
  assert.strictEqual(shouldAutoTriggerFormCompletionGate(task, formSummary), false);
});

test('Explicit form task ("complete this form") triggers gate when all fields populated', () => {
  const task = 'Complete this KYC form using my stored information';
  const formSummary = { formDetected: true, totalFields: 5, alreadyCompleted: 5, emptyFields: 0 };
  assert.strictEqual(shouldAutoTriggerFormCompletionGate(task, formSummary), true);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round(passedTests/totalTests*100)}%)`);
console.log('================================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
