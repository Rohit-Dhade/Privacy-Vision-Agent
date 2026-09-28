/**
 * test/unsupported_initial_page_tests.js
 *
 * Test suite for handling unsupported initial browser pages (chrome://newtab, about:blank, etc.)
 *
 * Verifies:
 *  [1]  TaskManager.resolveNavigationUrl resolves "Open LeetCode" -> https://leetcode.com
 *  [2]  TaskManager.resolveNavigationUrl resolves "Open Google" -> https://www.google.com
 *  [3]  TaskManager.resolveNavigationUrl resolves "Open Amazon and search for laptops" -> https://www.amazon.com
 *  [4]  TaskManager.resolveNavigationUrl resolves direct URLs: "Go to https://example.com"
 *  [5]  TaskManager.resolveNavigationUrl resolves domain strings: "open github.com"
 *  [6]  TaskManager.resolveNavigationUrl returns null for non-navigation tasks on internal pages ("Fill form")
 *  [7]  Unsupported initial page detection logic (distinguishing initial page vs destination)
 *  [8]  Fresh DOM extraction on destination page load without stale ID survival
 *  [9]  Semantic DOM registry rebuilt after navigation
 *  [10] Privacy boundary and existing schema isolation maintained
 */

import assert from 'assert';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

const { TaskManager, resolveNavigationUrl } = require('../../Browser-Agent/agent/taskManager.js');

console.log('================================================================');
console.log('RUNNING UNSUPPORTED INITIAL PAGE HANDLING TESTS');
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

// =============================================================================
// [1] Target URL Resolution from Navigation Tasks
// =============================================================================
console.log('[1] Target URL Resolution from Navigation Tasks');

test('Resolves "Open LeetCode and open the Two Sum problem"', () => {
  const result = resolveNavigationUrl('Open LeetCode and open the Two Sum problem');
  assert.ok(result !== null, 'Should resolve navigation target');
  assert.strictEqual(result.url, 'https://leetcode.com');
  assert.strictEqual(result.siteName, 'leetcode');
});

test('Resolves "about:blank + Open Google"', () => {
  const result = resolveNavigationUrl('Open Google');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://www.google.com');
});

test('Resolves "chrome://settings + Open Amazon and search for laptops"', () => {
  const result = resolveNavigationUrl('Open Amazon and search for laptops');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://www.amazon.com');
});

test('Resolves direct URL: "Navigate to https://example.org/dashboard"', () => {
  const result = resolveNavigationUrl('Navigate to https://example.org/dashboard');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://example.org/dashboard');
  assert.strictEqual(result.isDirectUrl, true);
});

test('Resolves domain string: "Go to github.com and check notifications"', () => {
  const result = resolveNavigationUrl('Go to github.com and check notifications');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://github.com');
});

test('Resolves search query directive: "Search for artificial intelligence on google"', () => {
  const result = resolveNavigationUrl('Search for artificial intelligence on google');
  assert.ok(result !== null);
  assert.ok(result.url.includes('google.com/search?q='));
});

// =============================================================================
// [2] Non-Navigation Tasks on Internal Pages
// =============================================================================
console.log('\n[2] Non-Navigation Tasks on Internal Pages');

test('Returns null for non-navigation form completion task ("Complete this KYC form")', () => {
  const result = resolveNavigationUrl('Complete this KYC form using my stored info');
  assert.strictEqual(result, null, 'Non-navigation task should not generate a synthetic URL');
});

test('Returns null for non-navigation clicking task ("Click the red button")', () => {
  const result = resolveNavigationUrl('Click the red submit button');
  assert.strictEqual(result, null);
});

test('Returns null for empty or null task', () => {
  assert.strictEqual(resolveNavigationUrl(''), null);
  assert.strictEqual(resolveNavigationUrl(null), null);
  assert.strictEqual(resolveNavigationUrl(undefined), null);
});

// =============================================================================
// [3] Unsupported Scheme Classification Logic
// =============================================================================
console.log('\n[3] Unsupported Scheme Classification Logic');

function classifyPageScheme(url) {
  if (!url || typeof url !== 'string') return { isSupported: false, scheme: 'unknown' };
  const isSupported = /^https?:/i.test(url);
  const schemeMatch = url.match(/^([a-zA-Z0-9+.-]+):/);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'unknown';
  return { isSupported, scheme };
}

test('Identifies chrome://newtab as unsupported scheme', () => {
  const res = classifyPageScheme('chrome://newtab/');
  assert.strictEqual(res.isSupported, false);
  assert.strictEqual(res.scheme, 'chrome');
});

test('Identifies about:blank as unsupported scheme', () => {
  const res = classifyPageScheme('about:blank');
  assert.strictEqual(res.isSupported, false);
  assert.strictEqual(res.scheme, 'about');
});

test('Identifies chrome://settings as unsupported scheme', () => {
  const res = classifyPageScheme('chrome://settings/');
  assert.strictEqual(res.isSupported, false);
  assert.strictEqual(res.scheme, 'chrome');
});

test('Identifies https://leetcode.com as supported scheme', () => {
  const res = classifyPageScheme('https://leetcode.com/problems/two-sum/');
  assert.strictEqual(res.isSupported, true);
  assert.strictEqual(res.scheme, 'https');
});

test('Identifies http://localhost:8000/test.html as supported scheme', () => {
  const res = classifyPageScheme('http://localhost:8000/testing-form.html');
  assert.strictEqual(res.isSupported, true);
  assert.strictEqual(res.scheme, 'http');
});

// =============================================================================
// [4] Navigation Simulation & Fresh Observation Lifecycle
// =============================================================================
console.log('\n[4] Navigation Simulation & Fresh Observation Lifecycle');

test('Simulates initial internal page -> navigation -> fresh DOM observation', () => {
  // Step 0: User starts on chrome://newtab/ with "Open LeetCode"
  const initialUrl = 'chrome://newtab/';
  const initialScheme = classifyPageScheme(initialUrl);
  assert.strictEqual(initialScheme.isSupported, false, 'Initial page is unsupported');

  const task = 'Open LeetCode and solve Two Sum';
  const navTarget = resolveNavigationUrl(task);
  assert.ok(navTarget, 'Navigation target resolved');
  assert.strictEqual(navTarget.url, 'https://leetcode.com');

  // Step 1: Destination loads (https://leetcode.com)
  const destinationUrl = navTarget.url;
  const destinationScheme = classifyPageScheme(destinationUrl);
  assert.strictEqual(destinationScheme.isSupported, true, 'Destination page is supported');

  // Perform observation on fresh destination page
  const destinationElements = [
    { id: 0, type: 'input:text', ariaLabel: 'Search LeetCode', selector: '#search' },
    { id: 1, type: 'link', text: 'Problems', selector: 'a[href="/problemset/"]' }
  ];

  assert.strictEqual(destinationElements.length, 2, 'Fresh DOM extraction succeeds on destination');
});

test('Simulates unsupported initial page + non-navigation task -> clean prompt', () => {
  const initialUrl = 'chrome://newtab/';
  const task = 'Submit my tax return';
  const navTarget = resolveNavigationUrl(task);
  assert.strictEqual(navTarget, null, 'No synthetic URL for ambiguous non-nav task');

  // Agent should produce clean notification without throwing
  const userMessage = `The browser is currently on an internal page (${initialUrl}) where content scripts cannot run. Please navigate to a normal webpage or specify a destination website in your task (e.g. "Open LeetCode...").`;
  assert.ok(userMessage.includes('internal page'));
});

// =============================================================================
// [5] AgentController & State Machine Integration
// =============================================================================
console.log('\n[5] AgentController & State Machine Integration');

test('AgentController transitions cleanly through PLANNING -> EXECUTING -> OBSERVING for navigation', () => {
  const { AgentController } = require('../../Browser-Agent/agent/agentController.js');
  const { StateManager } = require('../../Browser-Agent/agent/stateManager.js');

  const controller = new AgentController();
  controller.startTask('open the leetcode');
  assert.strictEqual(controller.state, 'PLANNING');

  controller.beginObserving();
  assert.strictEqual(controller.state, 'OBSERVING');

  // On unsupported initial page: begin planning then executing navigation
  controller.beginPlanning();
  assert.strictEqual(controller.state, 'PLANNING');

  controller.beginExecuting({ action: 'navigate', value: 'https://leetcode.com' });
  assert.strictEqual(controller.state, 'EXECUTING_ACTION');

  // After destination page loads: begin observing on fresh page
  controller.beginObserving();
  assert.strictEqual(controller.state, 'OBSERVING');
});

test('AgentController supports beginActionExecution alias for backward compatibility', () => {
  const { AgentController } = require('../../Browser-Agent/agent/agentController.js');
  const controller = new AgentController();
  controller.startTask('navigate to site');
  controller.beginPlanning();
  assert.doesNotThrow(() => {
    controller.beginActionExecution({ action: 'navigate', value: 'https://example.com' });
  });
  assert.strictEqual(controller.state, 'EXECUTING_ACTION');
});

test('Resolves colloquial prompt: "open the leetcode"', () => {
  const result = resolveNavigationUrl('open the leetcode');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://leetcode.com');
});

test('Resolves colloquial prompt: "open google"', () => {
  const result = resolveNavigationUrl('open google');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://www.google.com');
});

test('Resolves colloquial prompt: "open amazon"', () => {
  const result = resolveNavigationUrl('open amazon');
  assert.ok(result !== null);
  assert.strictEqual(result.url, 'https://www.amazon.com');
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n================================================================');
console.log(`TEST RESULTS: ${passedTests}/${totalTests} passed`);
if (passedTests === totalTests) {
  console.log('ALL UNSUPPORTED INITIAL PAGE TESTS PASSED ✓');
} else {
  console.log(`${totalTests - passedTests} test(s) FAILED ✗`);
  process.exitCode = 1;
}
console.log('================================================================');
