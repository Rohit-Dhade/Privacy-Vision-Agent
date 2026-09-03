/**
 * test/task_memory_tests.js
 *
 * Automated Test Suite for Task State & Short-Term Memory:
 * - Tracking attempted, succeeded, and failed actions
 * - Tracking pages visited and navigation transitions
 * - User intervention tracking to prevent re-asking
 * - Confirmation decision tracking
 * - Bounded rolling window (max 6 items)
 * - Live DOM Authority (Live DOM = Truth, History = Context)
 * - PromptBuilder taskMemory serialization
 */

import assert from 'assert';
import buildPromptRequest from '../src/services/promptBuilder.js';

console.log('================================================================');
console.log('RUNNING TASK STATE & SHORT-TERM MEMORY TEST SUITE');
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
// [1] Testing TaskMemory Tracking & Bounded Windows
// -----------------------------------------------------------------------------
console.log('[1] Testing TaskMemory Tracking & Bounded Buffers');

class MockTaskMemory {
  constructor() {
    this.pagesVisited = new Set();
    this.attemptedCount = 0;
    this.succeededCount = 0;
    this.failedCount = 0;
    this.recentActions = [];
    this.userInterventions = new Map();
    this.confirmations = [];
    this.completedSubgoals = [];
    this.currentSubgoal = null;
    this.activeBlockers = [];
    this.staleSelectors = new Set();
  }

  recordPageVisit(url) {
    if (url) this.pagesVisited.add(url.split('#')[0]);
  }

  recordAttempt(decision) {
    this.attemptedCount++;
  }

  recordResult(decision, verification) {
    const isSuccess = verification?.outcome === 'SUCCEEDED';
    if (isSuccess) {
      this.succeededCount++;
    } else {
      this.failedCount++;
    }
    this.recentActions.push({
      action: decision.action,
      target: decision.targetSelector,
      outcome: verification?.outcome || 'UNKNOWN'
    });
    if (this.recentActions.length > 6) {
      this.recentActions.shift();
    }
  }

  recordUserIntervention(field, label) {
    this.userInterventions.set(field, label);
  }

  recordConfirmation(action, target, granted) {
    this.confirmations.push(`${action} on ${target}: ${granted ? 'GRANTED' : 'DENIED'}`);
  }

  reconcileWithLiveState(liveElements, currentUrl, pageContext) {
    this.recordPageVisit(currentUrl);
    const liveSelectors = new Set(liveElements.map(e => e.selector));

    for (const act of this.recentActions) {
      if (act.target && !liveSelectors.has(act.target)) {
        this.staleSelectors.add(act.target);
      }
    }

    if (pageContext?.activeModal?.isOpen) {
      this.activeBlockers.push('Modal Open');
    } else {
      this.activeBlockers = this.activeBlockers.filter(b => !b.includes('Modal'));
    }
  }
}

test('Tracks attempted, succeeded, and failed actions accurately', () => {
  const mem = new MockTaskMemory();
  mem.recordAttempt({ action: 'click', targetSelector: '#btn1' });
  mem.recordResult({ action: 'click', targetSelector: '#btn1' }, { outcome: 'SUCCEEDED' });

  mem.recordAttempt({ action: 'fill', targetSelector: '#input1' });
  mem.recordResult({ action: 'fill', targetSelector: '#input1' }, { outcome: 'FAILED' });

  assert.strictEqual(mem.attemptedCount, 2);
  assert.strictEqual(mem.succeededCount, 1);
  assert.strictEqual(mem.failedCount, 1);
});

test('Enforces bounded history window (max 6 entries in rolling buffer)', () => {
  const mem = new MockTaskMemory();
  for (let i = 1; i <= 10; i++) {
    mem.recordAttempt({ action: 'click', targetSelector: `#btn${i}` });
    mem.recordResult({ action: 'click', targetSelector: `#btn${i}` }, { outcome: 'SUCCEEDED' });
  }

  assert.strictEqual(mem.attemptedCount, 10);
  assert.strictEqual(mem.recentActions.length, 6, 'Rolling buffer must retain maximum 6 recent items');
  assert.strictEqual(mem.recentActions[0].target, '#btn5');
  assert.strictEqual(mem.recentActions[5].target, '#btn10');
});

test('Tracks unique pages visited during multi-step navigation', () => {
  const mem = new MockTaskMemory();
  mem.recordPageVisit('https://store.local/home#top');
  mem.recordPageVisit('https://store.local/cart');
  mem.recordPageVisit('https://store.local/checkout');
  mem.recordPageVisit('https://store.local/cart#summary');

  assert.strictEqual(mem.pagesVisited.size, 3);
  assert.ok(mem.pagesVisited.has('https://store.local/home'));
  assert.ok(mem.pagesVisited.has('https://store.local/cart'));
  assert.ok(mem.pagesVisited.has('https://store.local/checkout'));
});

// -----------------------------------------------------------------------------
// [2] Live DOM Authority & Conflict Resolution
// -----------------------------------------------------------------------------
console.log('\n[2] Live DOM Authority (History = Context, Live DOM = Truth)');

test('Live DOM overrides history: detects stale selector when element unmounts', () => {
  const mem = new MockTaskMemory();
  mem.recordAttempt({ action: 'click', targetSelector: '#modal-dismiss-btn' });
  mem.recordResult({ action: 'click', targetSelector: '#modal-dismiss-btn' }, { outcome: 'SUCCEEDED' });

  // On next observation, #modal-dismiss-btn is gone
  const liveElements = [{ selector: '#main-content' }, { selector: '#checkout-btn' }];
  mem.reconcileWithLiveState(liveElements, 'https://test.local', { activeModal: { isOpen: false } });

  assert.ok(mem.staleSelectors.has('#modal-dismiss-btn'), 'Element not present in live DOM must be flagged as stale');
});

test('Modal blocker clears automatically when live page context indicates modal is closed', () => {
  const mem = new MockTaskMemory();
  // Step 1: modal open
  mem.reconcileWithLiveState([], 'https://test.local', { activeModal: { isOpen: true } });
  assert.ok(mem.activeBlockers.includes('Modal Open'));

  // Step 2: modal closed in live DOM
  mem.reconcileWithLiveState([], 'https://test.local', { activeModal: { isOpen: false } });
  assert.strictEqual(mem.activeBlockers.length, 0, 'Modal blocker must be cleared once modal is closed in live DOM');
});

test('Records user interventions to prevent re-asking for provided fields', () => {
  const mem = new MockTaskMemory();
  mem.recordUserIntervention('field_password', 'Password Input');

  assert.strictEqual(mem.userInterventions.get('field_password'), 'Password Input');
});

// -----------------------------------------------------------------------------
// [3] PromptBuilder Integration
// -----------------------------------------------------------------------------
console.log('\n[3] PromptBuilder TaskMemory Formatting');

test('PromptBuilder embeds task memory summary cleanly in prompt context', () => {
  const payload = {
    taskInstruction: 'Complete checkout',
    domSkeleton: { elements: [] },
    redactionMap: [],
    actionHistory: [],
    screenshot: { format: 'png', dataBase64: 'xyz' },
    taskMemory: {
      pagesVisited: ['https://store.local/cart', 'https://store.local/checkout'],
      counts: { attempted: 4, succeeded: 3, failed: 1 },
      completedSubgoals: ['Review Cart Items'],
      currentSubgoal: 'Enter Shipping Address',
      userInterventions: [{ field: '#user-phone', label: 'Phone Number' }],
      confirmations: ['click on #pay-button: GRANTED'],
      activeBlockers: [],
      staleSelectors: ['#coupon-input']
    }
  };

  const req = buildPromptRequest(payload);
  const promptText = req.messages[1].content.find(c => c.type === 'text').text;

  assert.ok(promptText.includes('Task Memory (History is context; Live DOM is truth):'));
  assert.ok(promptText.includes('Pages Visited: https://store.local/cart → https://store.local/checkout'));
  assert.ok(promptText.includes('Progress: 4 actions attempted (3 succeeded, 1 failed)'));
  assert.ok(promptText.includes('Completed Subgoals: Review Cart Items'));
  assert.ok(promptText.includes('Active Subgoal: Enter Shipping Address'));
  assert.ok(promptText.includes('User Interventions (Already Completed): Phone Number (do not re-ask)'));
  assert.ok(promptText.includes('Confirmations: click on #pay-button: GRANTED'));
  assert.ok(promptText.includes('Stale Elements (No longer in live DOM): #coupon-input (never target these)'));
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
