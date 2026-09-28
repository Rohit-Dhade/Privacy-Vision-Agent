/**
 * test/agent_recovery_replanning_tests.js
 *
 * Automated Test Suite for Agent Recovery, Replanning, and Loop Prevention:
 * - Stale elements & target disappearance
 * - Modal overlays & popups
 * - Cookie consent banners
 * - Login / authentication barriers
 * - Disabled buttons & form validation errors
 * - Action loops (A->A->A, stagnant scroll, navigation loops, oscillations)
 * - Intended state change already satisfied (no-op skip)
 * - Bounded failure limits & safe user intervention handoff
 */

import assert from 'assert';

console.log('================================================================');
console.log('RUNNING AGENT RECOVERY, REPLANNING & LOOP PREVENTION TEST SUITE');
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
// [1] Loop Detection Suite
// -----------------------------------------------------------------------------
console.log('[1] Loop Detection (Action loops, stagnant scroll, navigation loops, oscillations)');

class MockRecoveryEngine {
  constructor() {
    this.consecutiveFailures = 0;
    this.recentActions = [];
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
  }

  detectLoop(candidateAction, stateDiff, currentUrl) {
    if (!candidateAction || candidateAction.action === 'done' || candidateAction.action === 'wait') {
      return { isLoop: false };
    }

    const sig = `${candidateAction.action}:${candidateAction.targetSelector || candidateAction.elementId || ''}:${candidateAction.value || ''}`;
    this.recentActions.push({ sig, action: candidateAction.action, target: candidateAction.targetSelector, value: candidateAction.value });
    if (this.recentActions.length > 8) this.recentActions.shift();

    // 1. Navigation loop
    if (candidateAction.action === 'navigate' && candidateAction.value) {
      if (candidateAction.value === currentUrl || currentUrl.startsWith(candidateAction.value)) {
        return {
          isLoop: true,
          type: 'NAVIGATION_LOOP',
          description: `Navigation to "${candidateAction.value}" is already the current URL.`
        };
      }
    }

    // 2. Stagnant Scroll Loop
    const lastTwo = this.recentActions.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every(a => a.action === 'scroll') && stateDiff && !stateDiff.hasChanges) {
      return {
        isLoop: true,
        type: 'STAGNANT_SCROLL',
        description: 'Repeated scrolling without viewport movement.'
      };
    }

    // 3. Identical Action Loop (A -> A -> A)
    const lastThree = this.recentActions.slice(-3);
    if (lastThree.length === 3 && lastThree.every(a => a.sig === sig) && stateDiff && !stateDiff.hasChanges) {
      return {
        isLoop: true,
        type: 'ACTION_LOOP',
        description: `Identical action "${candidateAction.action}" repeated 3 times without page changes.`
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
        type: 'OSCILLATING_LOOP',
        description: `Oscillating loop detected between "${lastFour[0].sig}" and "${lastFour[1].sig}".`
      };
    }

    return { isLoop: false };
  }

  diagnose({ decision, targetEl, liveElements = [], pageContext, currentUrl }) {
    // 1. Intended state change already done
    if (targetEl && decision) {
      if (decision.action === 'check' && targetEl.checked === true) {
        return { cause: 'INTENDED_CHANGE_ALREADY_DONE', strategy: 'SKIP', canRetryAutonomously: true };
      }
      if ((decision.action === 'fill' || decision.action === 'type') && decision.value && targetEl.value === decision.value) {
        return { cause: 'INTENDED_CHANGE_ALREADY_DONE', strategy: 'SKIP', canRetryAutonomously: true };
      }
    }

    // 2. Active modal dialog
    if (pageContext?.activeModal?.isOpen) {
      return { cause: 'MODAL_OVERLAY', strategy: 'RESOLVE_MODAL', canRetryAutonomously: true };
    }

    // 3. Cookie consent banner
    const cookieBanner = liveElements.find(el => {
      const text = (el.text || el.ariaLabel || '').toLowerCase();
      return (text.includes('cookie') || text.includes('consent')) &&
             (text.includes('accept') || text.includes('agree') || text.includes('got it'));
    });
    if (cookieBanner) {
      return { cause: 'COOKIE_BANNER', strategy: 'ACCEPT_COOKIES', canRetryAutonomously: true };
    }

    // 4. Login wall
    const passwordField = liveElements.find(el => (el.type || '').includes('password') || el.sensitive);
    const isLoginSubmit = liveElements.some(el => {
      const text = (el.text || '').toLowerCase();
      return text === 'sign in' || text === 'log in' || text === 'login';
    });
    if (passwordField && isLoginSubmit) {
      return { cause: 'LOGIN_REQUIRED', strategy: 'WAIT_FOR_USER', canRetryAutonomously: false };
    }

    // 5. Validation error
    const errorAlert = pageContext?.alerts?.find(a => a.type === 'error');
    if (errorAlert) {
      return { cause: 'VALIDATION_ERROR', strategy: 'REPLAN_DIFFERENT_ACTION', canRetryAutonomously: true };
    }

    // 6. Loading state
    if (pageContext?.loadingState?.isLoading) {
      return { cause: 'PAGE_LOADING', strategy: 'WAIT_ONCE', canRetryAutonomously: true };
    }

    // 7. Target disappeared
    if (!targetEl && decision?.targetSelector) {
      return { cause: 'TARGET_DISAPPEARED', strategy: 'REPLAN_FRESH_DOM', canRetryAutonomously: true };
    }

    // 8. Disabled
    if (targetEl && targetEl.enabled === false) {
      return { cause: 'DISABLED_ELEMENT', strategy: 'REPLAN_DIFFERENT_ACTION', canRetryAutonomously: true };
    }

    return { cause: 'NO_EFFECT', strategy: 'REPLAN_DIFFERENT_ACTION', canRetryAutonomously: true };
  }

  evaluateNextStep(diagnosis) {
    this.consecutiveFailures++;
    if (!diagnosis.canRetryAutonomously || this.consecutiveFailures >= 3) {
      return { shouldHalt: true, userMessage: `Safety pause: ${diagnosis.cause}` };
    }
    return { shouldHalt: false, userMessage: `Retrying with: ${diagnosis.strategy}` };
  }
}

test('Detects identical action loop (A -> A -> A)', () => {
  const engine = new MockRecoveryEngine();
  const noDiff = { hasChanges: false };
  const action = { action: 'click', targetSelector: '#btn-submit', value: null };

  assert.strictEqual(engine.detectLoop(action, noDiff, 'http://test.local').isLoop, false);
  assert.strictEqual(engine.detectLoop(action, noDiff, 'http://test.local').isLoop, false);
  const result = engine.detectLoop(action, noDiff, 'http://test.local');
  assert.strictEqual(result.isLoop, true);
  assert.strictEqual(result.type, 'ACTION_LOOP');
});

test('Detects stagnant scroll loop (scroll -> scroll without movement)', () => {
  const engine = new MockRecoveryEngine();
  const noDiff = { hasChanges: false };
  const scrollAction = { action: 'scroll', value: 'down' };

  assert.strictEqual(engine.detectLoop(scrollAction, noDiff, 'http://test.local').isLoop, false);
  const result = engine.detectLoop(scrollAction, noDiff, 'http://test.local');
  assert.strictEqual(result.isLoop, true);
  assert.strictEqual(result.type, 'STAGNANT_SCROLL');
});

test('Detects navigation loop to current URL', () => {
  const engine = new MockRecoveryEngine();
  const noDiff = { hasChanges: false };
  const navAction = { action: 'navigate', value: 'http://test.local/dashboard' };

  const result = engine.detectLoop(navAction, noDiff, 'http://test.local/dashboard');
  assert.strictEqual(result.isLoop, true);
  assert.strictEqual(result.type, 'NAVIGATION_LOOP');
});

test('Detects oscillating loop (A -> B -> A -> B)', () => {
  const engine = new MockRecoveryEngine();
  const noDiff = { hasChanges: false };
  const actionA = { action: 'click', targetSelector: '#tab-a' };
  const actionB = { action: 'click', targetSelector: '#tab-b' };

  engine.detectLoop(actionA, noDiff, 'http://test.local');
  engine.detectLoop(actionB, noDiff, 'http://test.local');
  engine.detectLoop(actionA, noDiff, 'http://test.local');
  const result = engine.detectLoop(actionB, noDiff, 'http://test.local');

  assert.strictEqual(result.isLoop, true);
  assert.strictEqual(result.type, 'OSCILLATING_LOOP');
});

// -----------------------------------------------------------------------------
// [2] Failure Diagnosis & Recovery Strategy Suite
// -----------------------------------------------------------------------------
console.log('\n[2] Failure Diagnosis & Recovery Strategies');

test('Identifies when intended state change has already completed (skips unnecessary retry)', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'check', targetSelector: '#terms' },
    targetEl: { checked: true }
  });
  assert.strictEqual(diagnosis.cause, 'INTENDED_CHANGE_ALREADY_DONE');
  assert.strictEqual(diagnosis.strategy, 'SKIP');
});

test('Diagnoses open modal overlay and directs modal resolution', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#bg-button' },
    targetEl: { enabled: true },
    pageContext: { activeModal: { isOpen: true, title: 'Subscribe to newsletter' } }
  });
  assert.strictEqual(diagnosis.cause, 'MODAL_OVERLAY');
  assert.strictEqual(diagnosis.strategy, 'RESOLVE_MODAL');
});

test('Detects cookie banner and recommends consent acceptance', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#main-content' },
    targetEl: { enabled: true },
    liveElements: [{ text: 'Accept all cookies', selector: '#cookie-accept' }]
  });
  assert.strictEqual(diagnosis.cause, 'COOKIE_BANNER');
  assert.strictEqual(diagnosis.strategy, 'ACCEPT_COOKIES');
});

test('Diagnoses login wall and halts to human user for secure authentication', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#private-area' },
    targetEl: { enabled: true },
    liveElements: [
      { type: 'input:password', sensitive: true },
      { text: 'Log In', selector: '#login-btn' }
    ]
  });
  assert.strictEqual(diagnosis.cause, 'LOGIN_REQUIRED');
  assert.strictEqual(diagnosis.strategy, 'WAIT_FOR_USER');
  assert.strictEqual(diagnosis.canRetryAutonomously, false);

  const evalResult = engine.evaluateNextStep(diagnosis);
  assert.strictEqual(evalResult.shouldHalt, true, 'Login requirement must halt to user immediately');
});

test('Diagnoses live form validation error', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#submit' },
    targetEl: { enabled: true },
    pageContext: { alerts: [{ type: 'error', text: 'Postal code must be 6 digits' }] }
  });
  assert.strictEqual(diagnosis.cause, 'VALIDATION_ERROR');
  assert.strictEqual(diagnosis.strategy, 'REPLAN_DIFFERENT_ACTION');
});

test('Diagnoses disabled element and requests prerequisite replan', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#checkout' },
    targetEl: { enabled: false }
  });
  assert.strictEqual(diagnosis.cause, 'DISABLED_ELEMENT');
  assert.strictEqual(diagnosis.strategy, 'REPLAN_DIFFERENT_ACTION');
});

test('Diagnoses target disappearance and requests fresh DOM replanning', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = engine.diagnose({
    decision: { action: 'click', targetSelector: '#ghost-button' },
    targetEl: null
  });
  assert.strictEqual(diagnosis.cause, 'TARGET_DISAPPEARED');
  assert.strictEqual(diagnosis.strategy, 'REPLAN_FRESH_DOM');
});

// -----------------------------------------------------------------------------
// [3] Bounded Retry Limit Suite
// -----------------------------------------------------------------------------
console.log('\n[3] Bounded Retry Limits');

test('Stops after bounded failure threshold (3 failures) and yields to user', () => {
  const engine = new MockRecoveryEngine();
  const diagnosis = { cause: 'TARGET_DISAPPEARED', strategy: 'REPLAN_FRESH_DOM', canRetryAutonomously: true };

  assert.strictEqual(engine.evaluateNextStep(diagnosis).shouldHalt, false);
  assert.strictEqual(engine.evaluateNextStep(diagnosis).shouldHalt, false);
  const thirdEval = engine.evaluateNextStep(diagnosis);
  assert.strictEqual(thirdEval.shouldHalt, true, 'Must halt after 3 consecutive failures');
  assert.ok(thirdEval.userMessage.includes('Safety pause'));
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
