/**
 * test/privacy_security_hardening_tests.js
 *
 * Adversarial and Structural Privacy & Security Boundary Test Suite:
 * - Proves raw passwords, OTPs, PAN, Aadhaar, Credit Cards CANNOT cross the boundary.
 * - Proves element allowlists strictly strip forbidden value/credential fields.
 * - Proves action history values are neutralized to safe tokens.
 * - Proves server requestSchema rejects raw sensitive data in actionHistory.
 * - Proves adversarial scanner throws PrivacyBoundaryViolationError on malicious/leaked payload.
 */

import assert from 'assert';
import requestSchema from '../src/schemas/requestSchema.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrivacyBoundary, PrivacyBoundaryViolationError } = require('../../Browser-Agent/agent/privacyBoundary.js');

console.log('================================================================');
console.log('RUNNING PRIVACY AND SECURITY HARDENING TEST SUITE');
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
// [1] Element Allowlist & Forbidden Field Stripping
// -----------------------------------------------------------------------------
console.log('[1] Testing Element Record Allowlist & Forbidden Field Stripping');

test('Strictly strips forbidden value, password, and credential fields from elements', () => {
  const dirtyElement = {
    id: 'el_1',
    tag: 'input',
    type: 'password',
    selector: '#user-password',
    box: { x: 10, y: 20, width: 100, height: 30 },
    value: 'SuperSecret123!', // FORBIDDEN
    inputValue: 'SuperSecret123!', // FORBIDDEN
    defaultValue: 'oldSecret', // FORBIDDEN
    localVal: 'SuperSecret123!', // FORBIDDEN
    hasValue: true,
    placeholder: 'Enter password',
    sensitive: true
  };

  const cleanElement = PrivacyBoundary.sanitizeElement(dirtyElement);

  assert.strictEqual(cleanElement.value, undefined, 'Raw value must be stripped');
  assert.strictEqual(cleanElement.inputValue, undefined, 'inputValue must be stripped');
  assert.strictEqual(cleanElement.defaultValue, undefined, 'defaultValue must be stripped');
  assert.strictEqual(cleanElement.localVal, undefined, 'localVal must be stripped');
  assert.strictEqual(cleanElement.hasValue, true, 'hasValue boolean indicator is permitted');
  assert.strictEqual(cleanElement.sensitive, true);
  assert.strictEqual(cleanElement.placeholder, '[REDACTED]', 'Sensitive placeholder must be redacted');
});

test('Redacts accidental raw PII embedded in text/placeholder attributes', () => {
  const dirtyElement = {
    id: 'el_2',
    tag: 'span',
    selector: '.account-pan',
    box: { x: 0, y: 0, width: 50, height: 20 },
    text: 'Your PAN: ABCDE1234F verified',
    placeholder: 'Card 4532012345678910',
    sensitive: false
  };

  const clean = PrivacyBoundary.sanitizeElement(dirtyElement);
  assert.strictEqual(clean.text, '[REDACTED_PII]', 'PAN in text must be redacted');
  assert.strictEqual(clean.placeholder, '[REDACTED_PII]', 'Credit card in placeholder must be redacted');
});

// -----------------------------------------------------------------------------
// [2] Action History Value Neutralization
// -----------------------------------------------------------------------------
console.log('\n[2] Testing Action History Value Neutralization');

test('Neutralizes raw user-entered values in action history to safe tokens', () => {
  const rawHistoryItem = {
    action: 'type',
    targetSelector: '#cvv-input',
    elementId: 'el_cvv',
    value: '889', // Raw CVV
    result: { success: true }
  };

  const sanitized = PrivacyBoundary.sanitizeHistoryItem(rawHistoryItem);
  assert.strictEqual(sanitized.value, '[REDACTED]', 'Raw CVV must be neutralized to [REDACTED]');
  assert.strictEqual(sanitized.action, 'type');
});

test('Preserves legitimate non-sensitive metadata tokens in action history', () => {
  const tokens = ['[REDACTED]', '[FILLED_FROM_LOCAL]', '[ALREADY_POPULATED]', null];
  for (const token of tokens) {
    const item = { action: 'fill', value: token };
    const sanitized = PrivacyBoundary.sanitizeHistoryItem(item);
    assert.strictEqual(sanitized.value, token);
  }
});

// -----------------------------------------------------------------------------
// [3] Pre-flight Adversarial Transmission Scanning
// -----------------------------------------------------------------------------
console.log('\n[3] Testing Adversarial Pre-flight Scanner');

test('Blocks transmission and throws on raw Credit Card number', () => {
  const adversarialPayload = {
    taskInstruction: 'Pay with Visa',
    actionHistory: [{ action: 'type', note: 'card 4532 8234 8923 1298' }]
  };

  assert.throws(() => {
    PrivacyBoundary.assertSafeForTransmission(adversarialPayload);
  }, /Privacy Boundary Violation.*CREDIT_CARD/);
});

test('Blocks transmission and throws on raw Indian PAN card number', () => {
  const adversarialPayload = {
    taskInstruction: 'Verify KYC with ABCDE1234F',
    actionHistory: []
  };

  assert.throws(() => {
    PrivacyBoundary.assertSafeForTransmission(adversarialPayload);
  }, /Privacy Boundary Violation.*PAN_CARD/);
});

test('Blocks transmission and throws on raw Aadhaar number', () => {
  const adversarialPayload = {
    taskInstruction: 'Enter 1234 5678 9012',
    actionHistory: []
  };

  assert.throws(() => {
    PrivacyBoundary.assertSafeForTransmission(adversarialPayload);
  }, /Privacy Boundary Violation.*AADHAAR/);
});

test('Passes pre-flight scan for clean, sanitized payload', () => {
  const safePayload = {
    sessionId: 'session_123',
    taskInstruction: 'Complete the KYC form using stored information',
    domSkeleton: { elements: [{ id: '1', tag: 'input', selector: '#name', hasValue: false }] },
    actionHistory: [{ action: 'fill', targetSelector: '#name', value: '[FILLED_FROM_LOCAL]' }]
  };

  const isSafe = PrivacyBoundary.assertSafeForTransmission(safePayload);
  assert.strictEqual(isSafe, true);
});

// -----------------------------------------------------------------------------
// [4] Server-Side Boundary Schema Enforcement
// -----------------------------------------------------------------------------
console.log('\n[4] Testing Server-Side RequestSchema Boundary Enforcement');

test('Server requestSchema rejects payload if actionHistory contains raw plaintext password in value', () => {
  const payloadWithRawSecret = {
    sessionId: 'test_session',
    taskInstruction: 'Sign in',
    capturedAt: Date.now(),
    screenshot: { format: 'png', dataBase64: 'abc', width: 100, height: 100 },
    domSkeleton: { url: 'https://test.local', elements: [] },
    redactionMap: [],
    actionHistory: [
      { action: 'type', targetSelector: '#pwd', value: 'MyPlaintextPassword123' } // REJECT
    ]
  };

  const res = requestSchema.safeParse(payloadWithRawSecret);
  assert.strictEqual(res.success, false, 'Server must reject un-neutralized raw value in actionHistory');
});

test('Server requestSchema accepts payload with properly neutralized value tokens', () => {
  const validPayload = {
    sessionId: 'test_session',
    taskInstruction: 'Sign in',
    capturedAt: Date.now(),
    screenshot: { format: 'png', dataBase64: 'abc', width: 100, height: 100 },
    domSkeleton: { url: 'https://test.local', elements: [] },
    redactionMap: [],
    actionHistory: [
      { action: 'type', targetSelector: '#pwd', value: '[REDACTED]' } // ACCEPT
    ]
  };

  const res = requestSchema.safeParse(validPayload);
  assert.strictEqual(res.success, true);
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
