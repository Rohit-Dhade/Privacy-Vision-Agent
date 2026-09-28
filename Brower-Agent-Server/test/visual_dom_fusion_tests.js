/**
 * test/visual_dom_fusion_tests.js
 *
 * Automated Test Suite for Visual + DOM Fusion:
 * - Proves reasoning from both structured semantic DOM and visual screenshot.
 * - Tests coordinate mapping correctness across DPR and viewport scales.
 * - Enforces safety rule: arbitrary coordinates are NEVER directly executed.
 * - Tests overlapping elements (modal backdrop vs modal button).
 * - Tests buttons with icons (icon clicked -> maps to parent button).
 * - Tests tables and cards (cell action button vs table container).
 * - Tests responsive layouts and approximate visual grounding.
 */

import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { VisualDomGrounder } = require('../../Browser-Agent/agent/visualDomGrounder.js');

console.log('================================================================');
console.log('RUNNING VISUAL + DOM FUSION TEST SUITE');
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
// [1] Coordinate Mapping & Scale Correctness
// -----------------------------------------------------------------------------
console.log('[1] Testing Coordinate Mapping & Scaling Correctness');

test('Maps screenshot pixel coordinates to viewport CSS coordinates across high-DPR displays', () => {
  // 2x Retina display: 2560x1600 screenshot for 1280x800 viewport
  const viewport = { width: 1280, height: 800 };
  const imageDimensions = { width: 2560, height: 1600 };
  const screenshotPoint = { x: 400, y: 300 }; // Equivalent to (200, 150) in viewport

  const mockElements = [
    {
      id: 'btn_search',
      tag: 'button',
      selector: '#search-btn',
      box: { x: 180, y: 140, width: 80, height: 30 },
      enabled: true,
      visible: true
    }
  ];

  const res = VisualDomGrounder.groundPoint(screenshotPoint, mockElements, {
    viewport,
    imageDimensions,
    isViewportSpace: false
  });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#search-btn');
  assert.strictEqual(res.viewportPoint.x, 200);
  assert.strictEqual(res.viewportPoint.y, 150);
});

// -----------------------------------------------------------------------------
// [2] Safety Enforcement: Arbitrary Coordinates Disallowed
// -----------------------------------------------------------------------------
console.log('\n[2] Testing Safety Enforcement (No Arbitrary Coordinate Execution)');

test('Rejects arbitrary coordinates when no validated DOM element exists near point', () => {
  const elements = [
    { id: '1', tag: 'button', selector: '#nav-btn', box: { x: 10, y: 10, width: 50, height: 30 }, enabled: true, visible: true }
  ];

  const emptySpacePoint = { x: 900, y: 900 }; // Nowhere near #nav-btn

  const res = VisualDomGrounder.groundPoint(emptySpacePoint, elements, { isViewportSpace: true });
  assert.strictEqual(res.grounded, false);
  assert.ok(res.reason.includes('do not map to any validated interactive DOM element'));

  const actionWithCoords = {
    action: 'click',
    visualGrounding: { approximatePoint: { x: 900, y: 900 } }
  };

  const fused = VisualDomGrounder.fuseVisualWithDom(actionWithCoords, elements, { isViewportSpace: true });
  assert.strictEqual(fused.ok, false, 'Arbitrary coordinate click must be rejected');
  assert.ok(fused.reason.includes('Arbitrary coordinate execution is disallowed'));
});

// -----------------------------------------------------------------------------
// [3] Overlapping Elements & Modal Dialogs
// -----------------------------------------------------------------------------
console.log('\n[3] Testing Overlapping Elements & Modal Dialogs');

test('Resolves innermost interactive control inside overlapping container (Card vs Button)', () => {
  const elements = [
    {
      id: 'card_container',
      tag: 'div',
      selector: '.product-card',
      box: { x: 100, y: 100, width: 300, height: 400 },
      enabled: true,
      visible: true
    },
    {
      id: 'btn_add_to_cart',
      tag: 'button',
      selector: '#add-to-cart-btn',
      box: { x: 120, y: 420, width: 120, height: 40 },
      enabled: true,
      visible: true
    }
  ];

  // Point is inside both the card and the button
  const clickPoint = { x: 150, y: 430 };
  const res = VisualDomGrounder.groundPoint(clickPoint, elements, { isViewportSpace: true });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#add-to-cart-btn', 'Must select interactive button over card container');
});

test('Prioritizes interactive control inside active modal dialog over background page', () => {
  const elements = [
    {
      id: 'backdrop_div',
      tag: 'div',
      selector: '.modal-backdrop',
      box: { x: 0, y: 0, width: 1280, height: 800 },
      inModal: true,
      enabled: true,
      visible: true
    },
    {
      id: 'modal_close_btn',
      tag: 'button',
      selector: '#modal-close',
      box: { x: 750, y: 120, width: 30, height: 30 },
      inModal: true,
      enabled: true,
      visible: true
    }
  ];

  const clickPoint = { x: 760, y: 130 };
  const res = VisualDomGrounder.groundPoint(clickPoint, elements, {
    isViewportSpace: true,
    activeModalSelector: '.modal'
  });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#modal-close', 'Must resolve specific close button inside modal');
});

// -----------------------------------------------------------------------------
// [4] Buttons with Icons
// -----------------------------------------------------------------------------
console.log('\n[4] Testing Buttons with Icons');

test('Maps clicks on icon span inside button to the interactive parent button', () => {
  const elements = [
    {
      id: 'icon_span',
      tag: 'span',
      selector: '.material-symbols-outlined',
      box: { x: 50, y: 50, width: 20, height: 20 },
      enabled: true,
      visible: true
    },
    {
      id: 'parent_btn',
      tag: 'button',
      type: 'button',
      selector: '#download-action-btn',
      box: { x: 40, y: 40, width: 120, height: 40 },
      text: 'Download',
      enabled: true,
      visible: true
    }
  ];

  const clickOnIcon = { x: 55, y: 55 };
  const res = VisualDomGrounder.groundPoint(clickOnIcon, elements, { isViewportSpace: true });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#download-action-btn', 'Must prioritize interactive button over raw icon span');
});

// -----------------------------------------------------------------------------
// [5] Tables & Data Grids
// -----------------------------------------------------------------------------
console.log('\n[5] Testing Tables & Data Grids');

test('Resolves specific action button inside table cell rather than entire table or row', () => {
  const elements = [
    {
      id: 'table_main',
      tag: 'table',
      selector: '#flights-table',
      box: { x: 50, y: 100, width: 800, height: 600 },
      enabled: true,
      visible: true
    },
    {
      id: 'table_row_1',
      tag: 'tr',
      selector: '#flight-row-1',
      box: { x: 50, y: 140, width: 800, height: 50 },
      enabled: true,
      visible: true
    },
    {
      id: 'book_btn_1',
      tag: 'button',
      selector: '#book-flight-btn-1',
      box: { x: 720, y: 145, width: 90, height: 35 },
      text: 'Book Flight',
      enabled: true,
      visible: true
    }
  ];

  const clickPoint = { x: 740, y: 155 };
  const res = VisualDomGrounder.groundPoint(clickPoint, elements, { isViewportSpace: true });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#book-flight-btn-1', 'Must resolve specific book button in table cell');
});

// -----------------------------------------------------------------------------
// [6] Approximate Visual Proximity Grounding
// -----------------------------------------------------------------------------
console.log('\n[6] Testing Approximate Visual Proximity Grounding');

test('Snaps visual point slightly outside button boundary to nearest interactive target', () => {
  const elements = [
    {
      id: 'btn_confirm',
      tag: 'button',
      selector: '#btn-confirm',
      box: { x: 100, y: 100, width: 80, height: 30 },
      enabled: true,
      visible: true
    }
  ];

  // Point is 6px to the right of the button boundary: (186, 115)
  const offsetPoint = { x: 186, y: 115 };
  const res = VisualDomGrounder.groundPoint(offsetPoint, elements, {
    isViewportSpace: true,
    maxDistancePx: 45
  });

  assert.strictEqual(res.grounded, true);
  assert.strictEqual(res.targetSelector, '#btn-confirm');
  assert.strictEqual(res.method, 'APPROXIMATE_PROXIMITY');
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
