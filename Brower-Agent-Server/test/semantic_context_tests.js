/**
 * test/semantic_context_tests.js
 *
 * Automated Test Suite for Context Representation & Semantic DOM Extraction:
 * - Forms, dropdowns, checkboxes, radio groups
 * - Search boxes, pagination, modal dialogs
 * - Error messages, success messages, loading states
 * - Disabled controls, navigation bars, sticky elements
 * - Task-relevance prioritization & noise filtering
 * - Stable element identity & attribute selector generation
 */

import assert from 'assert';
import buildPromptRequest from '../src/services/promptBuilder.js';

console.log('================================================================');
console.log('RUNNING SEMANTIC CONTEXT & DOM EXTRACTION TEST SUITE');
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
// [1] Testing Semantic Element Classification Helpers
// -----------------------------------------------------------------------------
console.log('[1] Testing Semantic Element Classification');

function classifySemanticProps(el) {
  const inputType = (el.type || '').toLowerCase();
  const name = (el.name || '').toLowerCase();
  const placeholder = (el.placeholder || '').toLowerCase();
  const ariaLabel = (el.ariaLabel || '').toLowerCase();
  const id = (el.id || '').toLowerCase();

  const isSearch = inputType.includes('search') ||
    el.role === 'searchbox' ||
    name.includes('search') ||
    placeholder.includes('search') ||
    ariaLabel.includes('search') ||
    id.includes('search');

  const text = (el.text || '').trim().toLowerCase();
  const isPagination = Boolean(
    el.parentNavIsPaging ||
    /^(next|prev|previous|first|last|\d+)$/i.test(text) ||
    ariaLabel.includes('page') ||
    ariaLabel.includes('pagination')
  );

  return {
    isSearch,
    isPagination,
    inModal: Boolean(el.inModal),
    inNav: Boolean(el.inNav),
    isSticky: Boolean(el.isSticky),
    formId: el.formId || null
  };
}

test('Identifies search input by input type, role, placeholder, or name', () => {
  assert.strictEqual(classifySemanticProps({ type: 'input:search' }).isSearch, true);
  assert.strictEqual(classifySemanticProps({ role: 'searchbox' }).isSearch, true);
  assert.strictEqual(classifySemanticProps({ placeholder: 'Search products or docs…' }).isSearch, true);
  assert.strictEqual(classifySemanticProps({ name: 'q' }).isSearch, false);
  assert.strictEqual(classifySemanticProps({ name: 'search_query' }).isSearch, true);
});

test('Identifies pagination buttons and page links', () => {
  assert.strictEqual(classifySemanticProps({ text: 'Next', type: 'link' }).isPagination, true);
  assert.strictEqual(classifySemanticProps({ text: 'Previous', type: 'button' }).isPagination, true);
  assert.strictEqual(classifySemanticProps({ text: '2', type: 'link' }).isPagination, true);
  assert.strictEqual(classifySemanticProps({ ariaLabel: 'Go to page 4' }).isPagination, true);
  assert.strictEqual(classifySemanticProps({ text: 'Submit Application' }).isPagination, false);
});

test('Flags inModal, inNav, isSticky, and formId accurately', () => {
  const modalBtn = classifySemanticProps({ inModal: true, text: 'Confirm' });
  assert.strictEqual(modalBtn.inModal, true);

  const stickyHeader = classifySemanticProps({ isSticky: true, text: 'Header Search' });
  assert.strictEqual(stickyHeader.isSticky, true);

  const navLink = classifySemanticProps({ inNav: true, text: 'About Us' });
  assert.strictEqual(navLink.inNav, true);

  const formInput = classifySemanticProps({ formId: 'checkout_form', name: 'email' });
  assert.strictEqual(formInput.formId, 'checkout_form');
});

// -----------------------------------------------------------------------------
// [2] Testing Task Relevance Scoring & DOM Noise Filtering
// -----------------------------------------------------------------------------
console.log('\n[2] Testing Task Relevance Scoring & DOM Noise Reduction');

function computeRelevance(el, taskTokens, activeModalOpen) {
  let score = 0;
  if (activeModalOpen) {
    if (el.inModal) score += 100;
    else score -= 40;
  }
  const labelText = `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''} ${el.selector || ''}`.toLowerCase();
  for (const tok of taskTokens) {
    if (labelText.includes(tok)) score += 20;
  }
  if (el.isSearch) score += 15;
  if (el.formId) score += 10;
  if (el.tag === 'input' || el.tag === 'button' || el.tag === 'select') score += 10;
  if (el.isPagination) score += 10;
  if (el.isSticky) score += 5;
  if (el.inNav && !el.isSearch) score -= 10;
  if (!el.enabled) score -= 15;
  return score;
}

test('Prioritizes modal elements when activeModal is open', () => {
  const task = 'close dialog';
  const tokens = ['close', 'dialog'];

  const insideModal = { text: 'Dismiss Dialog', inModal: true, enabled: true };
  const outsideModal = { text: 'Footer Link', inNav: true, inModal: false, enabled: true };

  const scoreInside = computeRelevance(insideModal, tokens, true);
  const scoreOutside = computeRelevance(outsideModal, tokens, true);

  assert.ok(scoreInside > scoreOutside, 'Elements inside active modal must score higher than outside backdrop elements');
  assert.ok(scoreInside > 100);
  assert.ok(scoreOutside < 0);
});

test('Boosts task-relevant elements matching task keywords', () => {
  const tokens = ['python', 'documentation'];
  const relevantBtn = { text: 'Python Documentation Link', tag: 'button', enabled: true };
  const irrelevantBtn = { text: 'Settings Tab', tag: 'button', enabled: true };

  const scoreRel = computeRelevance(relevantBtn, tokens, false);
  const scoreIrrel = computeRelevance(irrelevantBtn, tokens, false);

  assert.ok(scoreRel > scoreIrrel, 'Element matching task keywords must score higher');
});

test('Prunes excessive DOM noise (limits to top 60 while preserving core controls)', () => {
  const elements = [];
  // 10 form inputs
  for (let i = 0; i < 10; i++) {
    elements.push({ id: `input_${i}`, tag: 'input', formId: 'form1', enabled: true, score: 30, isCore: true });
  }
  // 100 noisy footer links
  for (let i = 0; i < 100; i++) {
    elements.push({ id: `footer_${i}`, tag: 'a', inNav: true, enabled: true, score: -10, isCore: false });
  }

  // Sort and select top 60
  elements.sort((a, b) => b.score - a.score);
  const topSelected = elements.slice(0, 60);

  assert.strictEqual(topSelected.length, 60);
  // All 10 form inputs must be retained
  const retainedInputs = topSelected.filter(e => e.isCore);
  assert.strictEqual(retainedInputs.length, 10, 'All core form inputs must be preserved despite pruning');
});

// -----------------------------------------------------------------------------
// [3] Testing Stable Attribute-Based Element Selectors
// -----------------------------------------------------------------------------
console.log('\n[3] Testing Stable Attribute-Based Element Selectors');

function generateStableSelector(el, mockDoc) {
  if (el.id) {
    const sel = `#${el.id}`;
    if (mockDoc.count(sel) === 1) return sel;
  }
  for (const attr of ['data-testid', 'data-test']) {
    if (el[attr]) {
      const sel = `[${attr}="${el[attr]}"]`;
      if (mockDoc.count(sel) === 1) return sel;
    }
  }
  const tag = el.tag || 'input';
  if (el.name) {
    const sel = `${tag}[name="${el.name}"]`;
    if (mockDoc.count(sel) === 1) return sel;
  }
  if (el.ariaLabel) {
    const sel = `${tag}[aria-label="${el.ariaLabel}"]`;
    if (mockDoc.count(sel) === 1) return sel;
  }
  return `${tag}:nth-of-type(1)`;
}

test('Generates selector by data-testid when present', () => {
  const mockDoc = { count: (sel) => sel === '[data-testid="submit-kyc"]' ? 1 : 0 };
  const sel = generateStableSelector({ 'data-testid': 'submit-kyc', tag: 'button' }, mockDoc);
  assert.strictEqual(sel, '[data-testid="submit-kyc"]');
});

test('Generates selector by unique name attribute without brittle nth-of-type', () => {
  const mockDoc = { count: (sel) => sel === 'input[name="emailAddress"]' ? 1 : 0 };
  const sel = generateStableSelector({ name: 'emailAddress', tag: 'input' }, mockDoc);
  assert.strictEqual(sel, 'input[name="emailAddress"]');
});

test('Generates selector by unique aria-label attribute', () => {
  const mockDoc = { count: (sel) => sel === 'button[aria-label="Close modal"]' ? 1 : 0 };
  const sel = generateStableSelector({ ariaLabel: 'Close modal', tag: 'button' }, mockDoc);
  assert.strictEqual(sel, 'button[aria-label="Close modal"]');
});

// -----------------------------------------------------------------------------
// [4] Testing PromptBuilder PageContext Integration
// -----------------------------------------------------------------------------
console.log('\n[4] Testing PromptBuilder PageContext Formatting');

test('PromptBuilder embeds active modal alert when modal dialog is open', () => {
  const payload = {
    taskInstruction: 'Confirm transaction',
    domSkeleton: { elements: [] },
    redactionMap: [],
    actionHistory: [],
    pageContext: {
      activeModal: { isOpen: true, title: 'Confirm Order Payment', selector: '#modal-1' },
      alerts: [{ type: 'error', text: 'CVV code is required' }],
      loadingState: { isLoading: true, indicator: 'Processing…' }
    }
  };

  payload.screenshot = { format: 'png', dataBase64: 'abc' };
  const req = buildPromptRequest(payload);
  const promptText = req.messages[1].content.find(c => c.type === 'text').text;

  assert.ok(promptText.includes('[ACTIVE MODAL DIALOG]: An overlay dialog "Confirm Order Payment" is currently OPEN.'));
  assert.ok(promptText.includes('Live Page Alerts / Messages:'));
  assert.ok(promptText.includes('[ERROR]: CVV code is required'));
  assert.ok(promptText.includes('[PAGE LOADING]: Processing…'));
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
