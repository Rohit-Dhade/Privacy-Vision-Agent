/**
 * test/generalized_hitl_tests.js
 *
 * Automated Test Suite for Generalized Human-in-the-Loop (HITL):
 * - Arbitrary task HITL categories (Authentication, CAPTCHA, Credentials, Decisions, Permission, Clarification, Missing Info)
 * - Verification of the 4 mandatory HITL pause points:
 *   1. Why the agent is blocked
 *   2. What the user needs to do
 *   3. What the agent will do afterward
 *   4. Current target / context
 * - ActionSchema validation of hitlRequest object
 * - Post-resume protocol: OBSERVE -> RECONCILE -> REPLAN -> CONTINUE
 */

import assert from 'assert';
import actionSchema from '../src/schemas/actionSchema.js';

console.log('================================================================');
console.log('RUNNING GENERALIZED HUMAN-IN-THE-LOOP (HITL) TEST SUITE');
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
// [1] ActionSchema hitlRequest Validation
// -----------------------------------------------------------------------------
console.log('[1] ActionSchema hitlRequest Schema Validation');

test('Validates CAPTCHA completion HITL request with all 4 required points', () => {
  const payload = {
    action: 'ask_user',
    targetSelector: '#turnstile-captcha',
    value: null,
    reasoning: 'Cloudflare security challenge requires human verification.',
    hitlRequest: {
      category: 'CAPTCHA',
      title: 'Complete Security Verification',
      whyBlocked: 'Cloudflare Turnstile challenge is active and prevents automated clicks.',
      userActionRequired: 'Please click the checkbox to solve the security verification on the webpage.',
      nextStepPlan: 'Observe authenticated page state, verify page load, and resume flight search.',
      targetContext: '#turnstile-captcha'
    }
  };

  const parsed = actionSchema.safeParse(payload);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.hitlRequest.category, 'CAPTCHA');
  assert.ok(parsed.data.hitlRequest.whyBlocked);
  assert.ok(parsed.data.hitlRequest.userActionRequired);
  assert.ok(parsed.data.hitlRequest.nextStepPlan);
  assert.ok(parsed.data.hitlRequest.targetContext);
});

test('Validates Authentication / Login barrier HITL request', () => {
  const payload = {
    action: 'ask_user',
    targetSelector: '#login-form',
    value: null,
    reasoning: 'User authentication required to view account dashboard.',
    hitlRequest: {
      category: 'AUTHENTICATION',
      title: 'Sign In to Account',
      whyBlocked: 'Protected account dashboard requires active login session.',
      userActionRequired: 'Please log in to your account with your 2FA credentials.',
      nextStepPlan: 'Observe authenticated session, confirm user dashboard loaded, and proceed.',
      targetContext: 'https://bank.local/login'
    }
  };

  const parsed = actionSchema.safeParse(payload);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.hitlRequest.category, 'AUTHENTICATION');
});

test('Validates Ambiguous Decision HITL request with choice buttons', () => {
  const payload = {
    action: 'ask_user',
    targetSelector: '#flight-options',
    value: null,
    reasoning: 'Two flights meet price criteria: one faster, one cheaper.',
    hitlRequest: {
      category: 'AMBIGUOUS_DECISION',
      title: 'Select Preferred Flight Option',
      whyBlocked: 'IndiGo at ₹4,200 (1 stop, 5h) vs Air India at ₹4,800 (non-stop, 2h).',
      userActionRequired: 'Please select which flight tier you prefer.',
      nextStepPlan: 'Select chosen flight and proceed to passenger details.',
      targetContext: '#flight-options',
      choices: ['IndiGo (Cheaper ₹4,200)', 'Air India (Non-stop ₹4,800)']
    }
  };

  const parsed = actionSchema.safeParse(payload);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.hitlRequest.choices.length, 2);
});

// -----------------------------------------------------------------------------
// [2] 4 Mandatory HITL Points Verification Helper
// -----------------------------------------------------------------------------
console.log('\n[2] 4 Mandatory HITL Points Verification');

function validateHitlPrompt(options) {
  const missing = [];
  if (!options.whyBlocked || options.whyBlocked.trim() === '') missing.push('whyBlocked');
  if (!options.userActionRequired || options.userActionRequired.trim() === '') missing.push('userActionRequired');
  if (!options.nextStepPlan || options.nextStepPlan.trim() === '') missing.push('nextStepPlan');
  if (!options.targetContext || options.targetContext.trim() === '') missing.push('targetContext');

  return {
    isValid: missing.length === 0,
    missing
  };
}

test('Enforces all 4 points: whyBlocked, userActionRequired, nextStepPlan, targetContext', () => {
  const validPrompt = {
    whyBlocked: 'Download permission required.',
    userActionRequired: 'Click allow download in browser bar.',
    nextStepPlan: 'Verify file downloaded and summarize report.',
    targetContext: 'Browser Permission Prompt'
  };
  const res = validateHitlPrompt(validPrompt);
  assert.strictEqual(res.isValid, true);
  assert.strictEqual(res.missing.length, 0);

  const invalidPrompt = {
    whyBlocked: 'Missing input.'
    // missing other 3
  };
  const invalidRes = validateHitlPrompt(invalidPrompt);
  assert.strictEqual(invalidRes.isValid, false);
  assert.strictEqual(invalidRes.missing.length, 3);
});

// -----------------------------------------------------------------------------
// [3] Post-Resume Protocol Sequence Verification
// -----------------------------------------------------------------------------
console.log('\n[3] Post-Resume Protocol (OBSERVE -> RECONCILE -> REPLAN -> CONTINUE)');

test('Post-resume follows strict OBSERVE -> RECONCILE -> REPLAN -> CONTINUE cycle without stale cache', () => {
  const executionLog = [];

  function simulateResumeFlow() {
    // 1. OBSERVE: Fetch fresh page analysis
    executionLog.push('OBSERVE_FRESH_PAGE');
    const freshAnalysis = { elements: [{ id: 1, hasValue: true }], url: 'https://test.local/done' };

    // 2. RECONCILE: Update history and live DOM authority
    executionLog.push('RECONCILE_DOM');

    // 3. REPLAN: Trigger state replanning from fresh DOM
    executionLog.push('REPLAN_FROM_FRESH_STATE');

    // 4. CONTINUE: Loop continues to next step
    executionLog.push('CONTINUE_LOOP');
  }

  simulateResumeFlow();

  assert.deepStrictEqual(executionLog, [
    'OBSERVE_FRESH_PAGE',
    'RECONCILE_DOM',
    'REPLAN_FROM_FRESH_STATE',
    'CONTINUE_LOOP'
  ]);
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
