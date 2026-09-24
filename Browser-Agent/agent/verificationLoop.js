/**
 * agent/verificationLoop.js
 *
 * Task-completion verification (claude/v25-master-implementation-guide.md
 * Part 3, Task 3.1 — "Verification Loop").
 *
 * The gap this closes: before this module existed, the only thing that
 * decided whether a task was "done" was the reasoner's own self-report.
 * `agent/actionVerifier.js`'s `action === 'done'` branch returned
 * `verified: true` unconditionally with the comment "Task marked as
 * completed by reasoner" — and `agent/taskManager.js`'s
 * `updateProgress()` set `isVerifiedComplete = true` on the same signal,
 * with no independent check at all. That is exactly the failure mode
 * v25's Part 7 calls out by name: "Others: 'Trust me, I made the right
 * decision.' Us: 'Here's a screenshot proving the task is complete.'"
 * Neither of those two places was actually doing the second half of that
 * sentence. This module is what does.
 *
 * What it checks, all 100% local (no model, no network, nothing beyond
 * data this extension already extracts for other reasons):
 *
 *   1. Productive-action check (gating): did *any* action in this task's
 *      history actually succeed? A "done" declared over an action history
 *      that is empty, or is nothing but waits/replans/failures, is
 *      rejected outright regardless of what else is true.
 *   2. Structural, task-type-aware check (gating): classifies the task's
 *      own text into the same rough categories `agent/taskManager.js`
 *      already uses to build subgoals (form/KYC/checkout, find/gather
 *      information, navigate, general) and applies a completion
 *      criterion appropriate to that type — e.g. a form-completion task
 *      is only accepted if the final `formSummary` genuinely reads as
 *      fully filled; a find/gather task is only accepted if something was
 *      actually recorded in `taskManager`'s `gatheredInformation`, not
 *      just claimed in prose.
 *   3. Visual-change check (gating for everything except find/gather
 *      tasks, where a lookup can legitimately leave the page pixel-
 *      identical): diffs the very first screenshot of the task against
 *      the screenshot at the moment "done" was declared, using the same
 *      `utils/visualStateEngine.js` frame-differencing already used for
 *      loading-indicator/no-effect detection elsewhere in the agent loop.
 *      A task that claims to be finished but changed literally nothing on
 *      screen over its whole run is treated as unverified.
 *   4. Confirmation-text check (advisory only — it can raise confidence
 *      but never by itself blocks or forces a verdict): a small,
 *      deliberately generic set of "thank you / success / confirmed /
 *      submitted" phrases scanned against the same redaction-safe
 *      `visibleText` summary `content/domExtractor.js` already produces
 *      (sensitive lines are already replaced with a fixed placeholder
 *      there, so this scan never sees real PII). Kept advisory rather
 *      than gating because it is the most site- and language-specific of
 *      the four checks, and a real completion with no matching phrase on
 *      screen is common and should not be penalized.
 *
 * What this deliberately does NOT do: it does not call any model, local
 * or cloud, to "judge" whether the task looks done — every check here is
 * a deterministic function over data already on hand, in keeping with
 * this codebase's existing local-decision layers (agent/decisionRouter.js
 * TREE/HEURISTIC layers, agent/complianceChecker.js). It also does not
 * replace `agent/actionVerifier.js`'s per-action outcome classification —
 * that still runs for every ordinary action; this module only gates the
 * *final* "the whole task is done" claim, which nothing previously
 * checked at all.
 *
 * Honesty note: like everything else in this codebase, this has not been
 * run in a real browser (no browser is available in the sandbox this was
 * written in) — see docs/TESTING.md. The pure-logic pieces
 * (`classifyTaskIntent`, `hasProductiveAction`, `hasConfirmationText`,
 * `verifyCompletion`'s check-combination logic) are unit-tested against
 * synthetic data extracted from this exact file; the screenshot-diff path
 * depends on `utils/visualStateEngine.js`'s `compareFrames`, which is
 * itself unverified end-to-end for the same reason.
 */
(function (root) {
  // Deliberately generic and English-only for now — matching this
  // project's existing disclosed-scope pattern (see docs/PRIVACY.md's
  // language coverage notes) rather than silently claiming multilingual
  // coverage it doesn't have. Advisory-only (see header), so a miss here
  // never blocks a real completion.
  const CONFIRMATION_PATTERNS = [
    /\bthank you\b/i,
    /\bsuccess(?:fully)?\b/i,
    /\border\s+(?:placed|confirmed|received)\b/i,
    /\bapplication\s+(?:received|submitted)\b/i,
    /\bsubmitted\s+successfully\b/i,
    /\bregistration\s+(?:complete|successful)\b/i,
    /\bpayment\s+(?:successful|received|confirmed)\b/i,
    /\bbooking\s+confirmed\b/i,
    /\bconfirmation\s+(?:number|code|email)\b/i,
    /\byou'?re\s+all\s+set\b/i,
    /\ball\s+done\b/i,
    /\bwe'?ve\s+received\b/i,
    /\bwelcome\s+aboard\b/i,
    /\bcongratulations\b/i,
  ];

  const NON_PRODUCTIVE_ACTIONS = new Set(['wait', 'replan']);
  const FAILING_OUTCOMES = new Set(['FAILED', 'NO_EFFECT', 'TARGET_DISAPPEARED']);

  /**
   * Classifies a task's own text into the same rough intent buckets
   * `agent/taskManager.js`'s `decomposeTaskIntoSubgoals()` already uses,
   * and reuses the exact same regexes it (and the `isExplicitFormTask`
   * check duplicated at several call sites in popup.js) already trust,
   * rather than inventing a second, possibly-inconsistent taxonomy.
   *
   * @param {string} taskText
   * @returns {'gather'|'form'|'navigate'|'general'}
   */
  function classifyTaskIntent(taskText) {
    const text = (taskText || '').trim();
    if (/(find|search|look for|compare|check price|show me|cheapest|lowest|what is|who is|how much|look up)/i.test(text)) {
      return 'gather';
    }
    if (/(complete|fill).*(form|application|kyc|profile|registration)|sign up|register|checkout|\bapply\b/i.test(text)) {
      return 'form';
    }
    if (/(go to|navigate|open|click|toggle|switch)/i.test(text)) {
      return 'navigate';
    }
    return 'general';
  }

  /**
   * True if at least one entry in actionHistory represents a real,
   * successful step — not a wait, not a replan marker, not a failure.
   * A "done" declared over a history with nothing productive in it is
   * rejected outright by verifyCompletion() regardless of every other
   * check, since there is nothing on the record for it to have achieved.
   *
   * @param {Array<Object>} actionHistory
   * @returns {boolean}
   */
  function hasProductiveAction(actionHistory) {
    if (!Array.isArray(actionHistory) || actionHistory.length === 0) return false;
    return actionHistory.some((entry) => {
      if (!entry || NON_PRODUCTIVE_ACTIONS.has(entry.action)) return false;
      const r = entry.result;
      if (!r) return false;
      if (r.success === false) return false;
      if (r.outcome && FAILING_OUTCOMES.has(r.outcome)) return false;
      return true;
    });
  }

  /**
   * Advisory-only scan for a common success/confirmation phrase in the
   * page's already-redaction-safe visible-text summary (see
   * content/domExtractor.js — sensitive lines are already replaced with
   * '[REDACTED - sensitive text on this line]' there, so this never sees
   * real PII). Never gates verifyCompletion() by itself.
   *
   * @param {Array<{text?: string}>} visibleText
   * @returns {boolean}
   */
  function hasConfirmationText(visibleText) {
    if (!Array.isArray(visibleText)) return false;
    return visibleText.some((entry) => {
      const text = entry && typeof entry.text === 'string' ? entry.text : '';
      if (!text || text.indexOf('[REDACTED') === 0) return false;
      return CONFIRMATION_PATTERNS.some((re) => re.test(text));
    });
  }

  /**
   * The actual verification: runs all four checks described in this
   * file's header comment and combines them into one verdict.
   *
   * @param {Object} input
   * @param {string} input.taskText - the original user task instruction
   * @param {Object} [input.taskPlan] - agent/taskManager.js's getPlanSummary() output
   * @param {Object} [input.formSummary] - agent/formAnalyzer.js's analyzeForm() output for the CURRENT step
   * @param {Array<Object>} [input.actionHistory]
   * @param {ImageData|null} [input.baselineFrame] - raw pixel frame from task step 0 (before redaction boxes are painted)
   * @param {ImageData|null} [input.currentFrame] - raw pixel frame from the step where 'done' was declared
   * @param {Array<Object>} [input.visibleText] - content/domExtractor.js's visibleText summary for the current step
   * @returns {{
   *   verified: boolean,
   *   confidence: number,
   *   intent: 'gather'|'form'|'navigate'|'general',
   *   checks: Array<{name: string, passed: boolean, advisory?: boolean, detail: string}>,
   *   reason: string
   * }}
   */
  function verifyCompletion(input) {
    const {
      taskText, taskPlan, formSummary, actionHistory,
      baselineFrame, currentFrame, visibleText,
    } = input || {};

    const intent = classifyTaskIntent(taskText);
    const checks = [];

    // Check 1: something actually happened.
    const productive = hasProductiveAction(actionHistory);
    checks.push({
      name: 'productive_action',
      passed: productive,
      detail: productive
        ? 'At least one action in this task executed successfully.'
        : 'No action in this task\'s history executed successfully — "done" was declared with nothing on the record to show for it.',
    });

    // Check 2: task-type-aware structural check.
    let structuralPassed = true;
    let structuralDetail = 'No task-type-specific completion criterion applies to this task (navigation/general) — relying on the productive-action and visual-change checks instead.';
    if (intent === 'form') {
      const formOk = !!(formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0);
      structuralPassed = formOk;
      if (formOk) {
        structuralDetail = `Final form state reads as fully filled (${formSummary.totalFields}/${formSummary.totalFields} field(s)).`;
      } else if (formSummary && formSummary.formDetected) {
        structuralDetail = `Final form state still has ${formSummary.emptyFields} empty required field(s) out of ${formSummary.totalFields}.`;
      } else {
        structuralDetail = 'This looked like a form/KYC/checkout task, but no form was detected on the final page at all.';
      }
    } else if (intent === 'gather') {
      const gatheredKeys = (taskPlan && taskPlan.gatheredInformation) ? Object.keys(taskPlan.gatheredInformation) : [];
      structuralPassed = gatheredKeys.length > 0;
      structuralDetail = structuralPassed
        ? `${gatheredKeys.length} piece(s) of information were recorded: ${gatheredKeys.join(', ')}.`
        : 'This looked like a find/search/gather-information task, but nothing was recorded as a finding.';
    }
    checks.push({ name: 'structural', passed: structuralPassed, detail: structuralDetail });

    // Check 3: visual change across the whole task (gating, except for
    // 'gather' tasks where the page can legitimately stay the same).
    let visualPassed = true;
    let visualDetail = 'No usable baseline/current screenshot pair was available, so the visual-change check was skipped.';
    if (baselineFrame && currentFrame && root.__BA_VisualStateEngine && typeof root.__BA_VisualStateEngine.compareFrames === 'function') {
      const diff = root.__BA_VisualStateEngine.compareFrames(baselineFrame, currentFrame);
      if (diff.comparable || diff.verdict === 'major_change') {
        const changed = diff.verdict !== 'no_change';
        const pct = ((diff.changeRatio || 0) * 100).toFixed(1);
        visualDetail = `Screen changed ${pct}% (${diff.verdict}) between task start and this step.`;
        if (intent !== 'gather') {
          visualPassed = changed;
          if (!changed) visualDetail += ' No visible change occurred over the entire task, which is unusual for this kind of task.';
        } else {
          visualDetail += ' (Advisory only for a find/gather task — the page can legitimately stay unchanged.)';
        }
      }
    }
    checks.push({ name: 'visual_change', passed: visualPassed, advisory: intent === 'gather', detail: visualDetail });

    // Check 4: confirmation text — advisory only, see header comment.
    const confirmed = hasConfirmationText(visibleText);
    checks.push({
      name: 'confirmation_text',
      passed: true,
      advisory: true,
      detail: confirmed
        ? 'Found page text matching a common success/confirmation phrase.'
        : 'No common success/confirmation phrase found in the visible page text (not required — many legitimate completions have none).',
    });

    const gatingChecks = checks.filter((c) => !c.advisory);
    const passedCount = gatingChecks.filter((c) => c.passed).length;
    const verified = gatingChecks.every((c) => c.passed);
    const confidence = gatingChecks.length > 0 ? passedCount / gatingChecks.length : 1;

    const reason = verified
      ? 'Independent local verification confirms the declared completion.'
      : 'Independent local verification could not confirm the declared completion: ' +
        gatingChecks.filter((c) => !c.passed).map((c) => c.detail).join(' ');

    return { verified, confidence, intent, checks, reason };
  }

  /**
   * Thin stateful wrapper: holds the task's baseline (step-0) frame for
   * the duration of one task run, so callers don't have to thread it
   * through every step by hand. One instance per task (create fresh in
   * runAgentLoop(), same lifetime as actionHistory/privacyReceiptTotals).
   */
  class TaskVerifier {
    constructor() {
      this.baselineFrame = null;
      this.attempts = 0;
    }

    /** Call once, at step 0 of a task, with that step's raw (pre-redaction) frame. */
    captureBaseline(frame) {
      this.baselineFrame = frame || null;
    }

    reset() {
      this.baselineFrame = null;
      this.attempts = 0;
    }

    /** @see verifyCompletion — baselineFrame is filled in from captureBaseline(). */
    verify(input) {
      return verifyCompletion({ ...(input || {}), baselineFrame: this.baselineFrame });
    }
  }

  // Mirrors v25 Task 3.1's maxAttempts=3: the original "done" declaration
  // counts as attempt 1, so this bounds two further replan-and-retry
  // cycles before the loop stops and reports honestly instead of looping
  // forever or silently accepting an unverified claim.
  const MAX_VERIFICATION_ATTEMPTS = 2;

  root.__BA_VerificationLoop = {
    TaskVerifier,
    verifyCompletion,
    classifyTaskIntent,
    hasProductiveAction,
    hasConfirmationText,
    MAX_VERIFICATION_ATTEMPTS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__BA_VerificationLoop;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
