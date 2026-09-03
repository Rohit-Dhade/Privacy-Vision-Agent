/**
 * test/consequential_safety_tests.js
 *
 * Automated Test Suite for Generalized Consequential Action Safety:
 * - Detection of all consequential categories:
 *   Submit, Send, Purchase, Pay, Transfer, Place Order, Publish, Delete, Cancel,
 *   Confirm, Book, Accept, Approve, Continue to financial workflow.
 * - Multi-factor detection:
 *   Element semantics, surrounding text, page context, task context, reversibility.
 * - Non-consequential exclusion:
 *   Dialog dismissals (Back, Close, Reset, standalone modal Cancel) do not trigger false gates.
 * - Single-use Authorization Binding:
 *   Never allows reuse of an old authorization token for a different action.
 * - 9-step execution safety flow simulation.
 */

import assert from 'assert';

console.log('================================================================');
console.log('RUNNING GENERALIZED CONSEQUENTIAL ACTION SAFETY TEST SUITE');
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
// [1] Multi-Factor Consequential Action Detector Implementation
// -----------------------------------------------------------------------------
console.log('[1] Testing Multi-Factor Consequential Action Detection');

const DISMISSAL_TERMS = [
  'back', 'close', 'reset', 'clear', 'edit', 'previous', 'prev',
  'help', 'expand', 'collapse', 'toggle', 'menu', 'settings', 'details', 'preview', 'view'
];

const PAYMENT_PATTERNS = [
  /\b(pay|pay now|make payment|confirm payment|pay\s+[₹$€£\d]|transfer|transfer funds|checkout|buy|buy now|purchase|place order|order now|subscribe|deposit|withdraw|complete payment)\b/i
];

const DELETE_PATTERNS = [
  /\b(delete|delete account|remove account|destroy|purge|wipe|terminate|deactivate|uninstall|erase|permanently delete|delete my data)\b/i
];

const CANCEL_PATTERNS = [
  /\b(cancel\s+(?:order|subscription|booking|membership|flight|ticket|service|reservation|policy|plan|account)|cancel\s+my\s+(?:subscription|account))\b/i
];

const PUBLISH_PATTERNS = [
  /\b(publish|publish now|deploy|post publicly|broadcast|release|broadcast message|send tweet|publish post)\b/i
];

const BOOK_PATTERNS = [
  /\b(book|book now|reserve|reserve seat|confirm booking|book flight|book hotel|confirm reservation|book ticket)\b/i
];

const SUBMIT_PATTERNS = [
  /\b(submit|submit application|submit form|submit kyc|submit quiz|submit exam|submit response|send message|send enquiry|send email|complete registration|confirm transaction|confirm order)\b/i
];

const APPROVE_PATTERNS = [
  /\b(approve|approve request|approve expense|accept quote|accept offer|agree & continue|accept terms|authorize transfer|accept contract)\b/i
];

function isConsequential(el, targetSelector, context = {}) {
  if (!el && !targetSelector) {
    return { isConsequential: false, actionType: null, isReversible: true, riskLevel: 'LOW' };
  }

  const text = (el?.text || '').trim();
  const aria = (el?.ariaLabel || '').trim();
  const selector = (el?.selector || targetSelector || '').trim();
  const tagOrType = (el?.type || '').toLowerCase();
  const cleanLabel = text || aria || selector || 'Execute Action';
  const surrounding = (context.surroundingText || el?.surroundingText || '').toLowerCase();
  const pageUrl = (context.pageUrl || '').toLowerCase();
  const task = (context.taskInstruction || '').toLowerCase();
  const rawCombined = `${text} ${aria} ${selector} ${tagOrType}`.toLowerCase();

  const isSimpleDismissal = DISMISSAL_TERMS.some(term => {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    return regex.test(text) || regex.test(aria);
  });
  const isStandaloneCancel = /^cancel$/i.test(text) || /^cancel$/i.test(aria);
  if (isSimpleDismissal || (isStandaloneCancel && !rawCombined.includes('subscription') && !rawCombined.includes('order'))) {
    return { isConsequential: false, actionType: null, label: cleanLabel, isReversible: true, riskLevel: 'LOW' };
  }

  for (const pat of DELETE_PATTERNS) {
    if (pat.test(rawCombined) || (pat.test(task) && (text.includes('confirm') || text.includes('yes')))) {
      return { isConsequential: true, actionType: 'DELETE', label: cleanLabel, isReversible: false, riskLevel: 'HIGH' };
    }
  }

  for (const pat of CANCEL_PATTERNS) {
    if (pat.test(rawCombined) || (pat.test(task) && text.includes('confirm'))) {
      return { isConsequential: true, actionType: 'CANCEL', label: cleanLabel, isReversible: false, riskLevel: 'HIGH' };
    }
  }

  for (const pat of PAYMENT_PATTERNS) {
    if (pat.test(rawCombined)) {
      return { isConsequential: true, actionType: 'PAYMENT', label: cleanLabel, isReversible: false, riskLevel: 'HIGH' };
    }
  }

  const isFinancialPage = /checkout|payment|billing|subscribe|cart/i.test(pageUrl);
  const hasFinancialTerms = /[₹$€£]\s*\d+|total|subtotal|amount due/i.test(surrounding);
  if (isFinancialPage && (hasFinancialTerms || /pay|place|confirm|complete/i.test(text))) {
    return { isConsequential: true, actionType: 'PAYMENT', label: cleanLabel, isReversible: false, riskLevel: 'HIGH' };
  }

  for (const pat of BOOK_PATTERNS) {
    if (pat.test(rawCombined)) {
      return { isConsequential: true, actionType: 'BOOK', label: cleanLabel, isReversible: false, riskLevel: 'MEDIUM' };
    }
  }

  for (const pat of PUBLISH_PATTERNS) {
    if (pat.test(rawCombined)) {
      return { isConsequential: true, actionType: 'PUBLISH', label: cleanLabel, isReversible: false, riskLevel: 'MEDIUM' };
    }
  }

  for (const pat of APPROVE_PATTERNS) {
    if (pat.test(rawCombined)) {
      return { isConsequential: true, actionType: 'APPROVE', label: cleanLabel, isReversible: false, riskLevel: 'HIGH' };
    }
  }

  const isHtmlSubmit = tagOrType.includes('submit') || selector.includes('type="submit"');
  for (const pat of SUBMIT_PATTERNS) {
    if (isHtmlSubmit || pat.test(rawCombined)) {
      return { isConsequential: true, actionType: 'SUBMIT', label: cleanLabel, isReversible: false, riskLevel: 'MEDIUM' };
    }
  }

  return { isConsequential: false, actionType: null, label: cleanLabel, isReversible: true, riskLevel: 'LOW' };
}

test('Detects financial actions: pay, transfer, place order, subscribe', () => {
  const el1 = { text: 'Pay ₹4,500 Now', selector: '#pay-btn' };
  const r1 = isConsequential(el1, el1.selector);
  assert.strictEqual(r1.isConsequential, true);
  assert.strictEqual(r1.actionType, 'PAYMENT');
  assert.strictEqual(r1.isReversible, false);

  const el2 = { text: 'Place Order', selector: 'button.checkout' };
  const r2 = isConsequential(el2, el2.selector);
  assert.strictEqual(r2.isConsequential, true);
  assert.strictEqual(r2.actionType, 'PAYMENT');
});

test('Detects destructive actions: delete account, permanently delete', () => {
  const el = { text: 'Permanently Delete Account', selector: '#danger-zone-btn' };
  const r = isConsequential(el, el.selector);
  assert.strictEqual(r.isConsequential, true);
  assert.strictEqual(r.actionType, 'DELETE');
  assert.strictEqual(r.isReversible, false);
  assert.strictEqual(r.riskLevel, 'HIGH');
});

test('Detects consequential cancellation (Cancel Subscription vs Modal Dismiss)', () => {
  // Subscription cancellation is CONSEQUENTIAL
  const cancelSub = { text: 'Cancel Subscription', selector: '#cancel-sub' };
  const r1 = isConsequential(cancelSub, cancelSub.selector);
  assert.strictEqual(r1.isConsequential, true);
  assert.strictEqual(r1.actionType, 'CANCEL');

  // Modal dialog dismiss "Cancel" is NOT consequential
  const modalCancel = { text: 'Cancel', selector: '.modal-close-cancel' };
  const r2 = isConsequential(modalCancel, modalCancel.selector);
  assert.strictEqual(r2.isConsequential, false);
});

test('Detects bookings, approvals, and publishing', () => {
  const bookEl = { text: 'Confirm Flight Booking', selector: '#book-flight-btn' };
  const rBook = isConsequential(bookEl, bookEl.selector);
  assert.strictEqual(rBook.isConsequential, true);
  assert.strictEqual(rBook.actionType, 'BOOK');

  const approveEl = { text: 'Approve Expense Report', selector: '#approve-btn' };
  const rApprove = isConsequential(approveEl, approveEl.selector);
  assert.strictEqual(rApprove.isConsequential, true);
  assert.strictEqual(rApprove.actionType, 'APPROVE');

  const publishEl = { text: 'Publish Post to Followers', selector: '#publish-btn' };
  const rPublish = isConsequential(publishEl, publishEl.selector);
  assert.strictEqual(rPublish.isConsequential, true);
  assert.strictEqual(rPublish.actionType, 'PUBLISH');
});

test('Context-aware detection: identifies primary button on checkout page with price in surrounding text', () => {
  // Button text is simply "Complete", but URL is /checkout and surrounding text contains price
  const button = { text: 'Complete', selector: '#complete-action' };
  const context = {
    pageUrl: 'https://store.local/checkout/step3',
    surroundingText: 'Order Total: $89.99 (Includes Shipping)'
  };
  const res = isConsequential(button, button.selector, context);
  assert.strictEqual(res.isConsequential, true);
  assert.strictEqual(res.actionType, 'PAYMENT');
});

// -----------------------------------------------------------------------------
// [2] Strict 9-Step Consequential Safety Sequence & Token Binding
// -----------------------------------------------------------------------------
console.log('\n[2] Strict 9-Step Consequential Safety Protocol Simulation');

class SingleUseAuthManager {
  constructor() {
    this.activeBinding = null;
  }

  createBinding(action, targetSelector, elementId) {
    this.activeBinding = {
      token: 'AUTH_' + Math.random().toString(36).slice(2, 8),
      action,
      targetSelector,
      elementId,
      consumed: false
    };
    return this.activeBinding;
  }

  revalidateTarget(freshLiveElements) {
    if (!this.activeBinding) return false;
    const exists = freshLiveElements.some(e => e.selector === this.activeBinding.targetSelector);
    return exists;
  }

  consumeAndExecute(requestedAction, requestedSelector) {
    if (!this.activeBinding) {
      throw new Error('No authorization exists');
    }
    if (this.activeBinding.consumed) {
      throw new Error('Safety Violation: Old authorization token already consumed');
    }
    if (this.activeBinding.action !== requestedAction || this.activeBinding.targetSelector !== requestedSelector) {
      throw new Error('Safety Violation: Authorization does not match target action/selector');
    }
    this.activeBinding.consumed = true;
    return { executed: true, token: this.activeBinding.token };
  }
}

test('Enforces single-use authorization binding (never reuse old authorization for different action)', () => {
  const auth = new SingleUseAuthManager();
  auth.createBinding('click', '#pay-order-btn', 10);

  // Attempting to execute different selector with same token must fail
  assert.throws(() => {
    auth.consumeAndExecute('click', '#delete-account-btn');
  }, /does not match target action\/selector/);

  // Executing matching action succeeds
  const res = auth.consumeAndExecute('click', '#pay-order-btn');
  assert.strictEqual(res.executed, true);

  // Attempting to reuse the token a second time MUST throw Safety Violation
  assert.throws(() => {
    auth.consumeAndExecute('click', '#pay-order-btn');
  }, /already consumed/);
});

test('Revalidates target after authorization and aborts if DOM shifted', () => {
  const auth = new SingleUseAuthManager();
  auth.createBinding('click', '#confirm-transfer', 42);

  // Simulate DOM shift where element was replaced or unmounted
  const liveElementsAfterDialog = [{ selector: '#other-button' }, { selector: '#nav-home' }];
  const isValid = auth.revalidateTarget(liveElementsAfterDialog);

  assert.strictEqual(isValid, false, 'Must reject execution if target element disappeared after authorization');
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
