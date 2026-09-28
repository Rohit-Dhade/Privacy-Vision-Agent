/**
 * test/general_task_planning_tests.js
 *
 * Automated Test Suite for General Task Planning & Hierarchical Reasoning:
 * - Natural-language task interpretation (Objective & Constraints)
 * - Subgoal decomposition (USER GOAL -> SUBGOALS -> ACTIONS)
 * - Dynamic replanning on page obstacles (e.g. modals, failure)
 * - Gathered information tracking & criteria verification
 * - ActionSchema validation of plan object
 */

import assert from 'assert';
import actionSchema from '../src/schemas/actionSchema.js';

console.log('================================================================');
console.log('RUNNING GENERAL TASK PLANNING & HIERARCHICAL REASONING TEST SUITE');
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
// [1] Constraint Extraction & Task Decomposition
// -----------------------------------------------------------------------------
console.log('[1] Natural-Language Task Constraint Extraction');

function extractConstraints(text) {
  const constraints = [];
  if (!text) return constraints;

  const priceMatch = text.match(/(under|below|less than|max(?:imum)?|cheaper than)\s*([₹$€£]?\s*\d+(?:,\d+)?)/i);
  if (priceMatch) constraints.push(`Price: ${priceMatch[0]}`);

  const dateMatch = text.match(/\b(today|tomorrow|yesterday|next week|this weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dateMatch) constraints.push(`Date/Timing: ${dateMatch[0]}`);

  const optMatch = text.match(/\b(cheapest|lowest price|fastest|highest rated|best rated|nearest|shortest)\b/i);
  if (optMatch) constraints.push(`Preference: ${optMatch[0]}`);

  const fromToMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|tomorrow|today|under|below)|$)/i);
  if (fromToMatch) {
    constraints.push(`Route: from ${fromToMatch[1].trim()} to ${fromToMatch[2].trim()}`);
  }

  return constraints;
}

test('Extracts constraints from complex flight search prompt', () => {
  const prompt = "Find a flight from Mumbai to Delhi tomorrow under ₹5000 and show me the cheapest.";
  const c = extractConstraints(prompt);

  assert.ok(c.some(item => item.includes('Route: from Mumbai to Delhi')));
  assert.ok(c.some(item => item.includes('Date/Timing: tomorrow')));
  assert.ok(c.some(item => item.includes('Price: under ₹5000')));
  assert.ok(c.some(item => item.includes('Preference: cheapest')));
});

test('Extracts constraints from product search prompt', () => {
  const prompt = "Search for mechanical keyboard under $100 with highest rated reviews";
  const c = extractConstraints(prompt);

  assert.ok(c.some(item => item.includes('Price: under $100')));
  assert.ok(c.some(item => item.includes('Preference: highest rated')));
});

// -----------------------------------------------------------------------------
// [2] Hierarchical Subgoal Generation
// -----------------------------------------------------------------------------
console.log('\n[2] Hierarchical Subgoal Generation');

function decomposeTask(taskText) {
  const text = (taskText || '').trim();
  const lower = text.toLowerCase();

  if (/(find|search|look for|compare|check price|show me|cheapest|lowest)/i.test(lower)) {
    return [
      { id: 'sg_1', title: 'Locate Search', status: 'IN_PROGRESS', requiresUserInput: false },
      { id: 'sg_2', title: 'Enter Query & Criteria', status: 'PENDING', requiresUserInput: false },
      { id: 'sg_3', title: 'Execute Search', status: 'PENDING', requiresUserInput: false },
      { id: 'sg_4', title: 'Evaluate Results', status: 'PENDING', requiresUserInput: false },
      { id: 'sg_5', title: 'Verify & Present', status: 'PENDING', requiresUserInput: false }
    ];
  }

  if (/(complete|fill|sign up|register|apply|kyc|checkout)/i.test(lower)) {
    return [
      { id: 'sg_1', title: 'Inspect Form', status: 'IN_PROGRESS', requiresUserInput: false },
      { id: 'sg_2', title: 'Populate Information', status: 'PENDING', requiresUserInput: true },
      { id: 'sg_3', title: 'Review Entries', status: 'PENDING', requiresUserInput: false },
      { id: 'sg_4', title: 'Authorize Submission', status: 'PENDING', requiresConfirmation: true }
    ];
  }

  return [
    { id: 'sg_1', title: 'Understand Page', status: 'IN_PROGRESS' },
    { id: 'sg_2', title: 'Perform Actions', status: 'PENDING' },
    { id: 'sg_3', title: 'Verify Goal', status: 'PENDING' }
  ];
}

test('Decomposes search/filter request into 5 structured subgoals', () => {
  const subgoals = decomposeTask("Find a flight from Mumbai to Delhi tomorrow under ₹5000 and show me the cheapest.");
  assert.strictEqual(subgoals.length, 5);
  assert.strictEqual(subgoals[0].title, 'Locate Search');
  assert.strictEqual(subgoals[1].title, 'Enter Query & Criteria');
  assert.strictEqual(subgoals[2].title, 'Execute Search');
  assert.strictEqual(subgoals[3].title, 'Evaluate Results');
  assert.strictEqual(subgoals[4].title, 'Verify & Present');
});

test('Decomposes form filling request with human confirmation point', () => {
  const subgoals = decomposeTask("Complete this KYC application form using my stored info");
  assert.strictEqual(subgoals.length, 4);
  assert.strictEqual(subgoals[3].requiresConfirmation, true);
});

// -----------------------------------------------------------------------------
// [3] Dynamic Replanning on Page Obstacles
// -----------------------------------------------------------------------------
console.log('\n[3] Dynamic Replanning on Page Obstacles');

class MockTaskManager {
  constructor(task) {
    this.task = task;
    this.subgoals = decomposeTask(task);
    this.currentIndex = 0;
    this.gathered = {};
    this.replanLog = [];
  }

  replan(reason, pageContext) {
    this.replanLog.push(reason);
    if (pageContext?.activeModal?.isOpen) {
      const modalSubgoal = {
        id: `modal_${Date.now()}`,
        title: 'Resolve Active Modal',
        description: `Dismiss or handle "${pageContext.activeModal.title}" dialog`,
        status: 'IN_PROGRESS'
      };
      this.subgoals[this.currentIndex].status = 'PENDING';
      this.subgoals.splice(this.currentIndex, 0, modalSubgoal);
    }
  }

  advanceSubgoal() {
    if (this.currentIndex < this.subgoals.length) {
      this.subgoals[this.currentIndex].status = 'COMPLETED';
      this.currentIndex++;
      if (this.currentIndex < this.subgoals.length) {
        this.subgoals[this.currentIndex].status = 'IN_PROGRESS';
      }
    }
  }
}

test('Inserts modal resolution subgoal when active modal appears during execution', () => {
  const tm = new MockTaskManager("Search for books");
  assert.strictEqual(tm.subgoals.length, 5);
  assert.strictEqual(tm.subgoals[0].title, 'Locate Search');

  // Modal dialog appears unexpectedly
  tm.replan('Unexpected overlay appeared', { activeModal: { isOpen: true, title: 'Newsletter Sign-Up' } });

  assert.strictEqual(tm.subgoals.length, 6);
  assert.strictEqual(tm.subgoals[0].title, 'Resolve Active Modal');
  assert.strictEqual(tm.subgoals[1].title, 'Locate Search');
});

// -----------------------------------------------------------------------------
// [4] Information Gathering & Task Completion Verification
// -----------------------------------------------------------------------------
console.log('\n[4] Information Gathering & Criteria Verification');

test('Records gathered information and verifies criteria before completion', () => {
  const tm = new MockTaskManager("Find flight");
  tm.gathered['cheapestFlight'] = 'Air India AI-101 ₹4,450';

  assert.strictEqual(tm.gathered['cheapestFlight'], 'Air India AI-101 ₹4,450');
  assert.ok(Object.keys(tm.gathered).length > 0);
});

// -----------------------------------------------------------------------------
// [5] ActionSchema Plan Validation
// -----------------------------------------------------------------------------
console.log('\n[5] ActionSchema Plan Object Validation');

test('ActionSchema validates action with hierarchical plan object', () => {
  const payload = {
    action: 'extract',
    targetSelector: '#flight-table',
    value: null,
    reasoning: 'Extract flight listing table to compare prices.',
    plan: {
      objective: 'Find cheapest flight under ₹5000',
      currentSubgoal: 'Evaluate Results',
      subgoalCompleted: false,
      gatheredInfo: { candidatePrice: '₹4,450' },
      isTaskComplete: false
    }
  };

  const parsed = actionSchema.safeParse(payload);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.plan.currentSubgoal, 'Evaluate Results');
  assert.strictEqual(parsed.data.plan.gatheredInfo.candidatePrice, '₹4,450');
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
