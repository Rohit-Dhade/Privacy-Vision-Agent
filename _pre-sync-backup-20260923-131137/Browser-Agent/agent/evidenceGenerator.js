/**
 * agent/evidenceGenerator.js
 *
 * Decision evidence (claude/v25-master-implementation-guide.md Part 3,
 * Task 3.2 — "Evidence Generation"). v25's own spec for this is an
 * annotated screenshot ("green: safe, red: danger, orange: ambiguous")
 * plus a structured reasoning/confidence/PII breakdown attached to a
 * decision, so a person looking at it sees *where* on the page a
 * decision applies, not just prose about it.
 *
 * This extension already has several evidence surfaces (the Privacy
 * Receipt panel, the Merkle-committed redaction proof, the Hybrid Debate
 * evidence card, and — as of this pass — the Task Verification evidence
 * card in agent/verificationLoop.js), but none of them draw a highlighted
 * screenshot. This module is the piece that was actually missing: it
 * computes WHERE the colored boxes go and WHAT color each one is, for
 * the two moments in the agent loop where seeing that matters most —
 * (1) right before asking the user to authorize a consequential action
 * (agent/consequentialActionDetector.js already gates this; this module
 * highlights the exact target plus any PII still visible on the page at
 * that moment), and (2) at task completion, alongside the verification
 * loop's evidence, highlighting every element the task actually acted on
 * successfully and any sensitive item still visible in the final state.
 *
 * Deliberately split from the actual pixel-drawing: this module only
 * computes a list of {bbox, color, kind, label} highlight regions in DOM
 * coordinate space (plus a small structured summary) from data the
 * extension already extracted. The pixel-drawing step — mapping each DOM
 * bbox into screenshot pixel space and painting the colored boxes — needs
 * the Canvas 2D API, which only exists in a real browser, so it lives in
 * popup.js's annotateScreenshotDataUrl(), next to the very similar
 * existing drawRedactedScreenshot(). That split keeps everything in THIS
 * file unit-testable in plain Node, the same reasoning
 * agent/verificationLoop.js's header comment explains for itself.
 *
 * Honesty note: like verificationLoop.js, the highlight-selection logic
 * here is unit-tested against synthetic data; the actual canvas drawing
 * in popup.js is not, and has not been run in a real browser — see
 * docs/TESTING.md.
 */
(function (root) {
  const COLORS = Object.freeze({
    SAFE: '#16a34a',      // green — successfully, non-consequentially acted on
    DANGER: '#dc2626',    // red — irreversible/consequential target, or PII still visible
    AMBIGUOUS: '#d97706', // orange — reversible-but-consequential, or an unresolved/advisory finding
  });

  const FAILING_OUTCOMES = new Set(['FAILED', 'NO_EFFECT', 'TARGET_DISAPPEARED']);

  /**
   * Highlight set for a consequential-action authorization moment: the
   * element about to be acted on (red if irreversible, orange if
   * reversible — mirroring agent/consequentialActionDetector.js's own
   * reversibility flag), plus every sensitive item detected on the page
   * right now, so the person authorizing sees both what's about to
   * happen AND what's currently on screen while they decide.
   *
   * @param {Object} params
   * @param {{x:number,y:number,width:number,height:number}} [params.targetBbox]
   * @param {boolean} [params.isReversible]
   * @param {string} [params.actionType] - e.g. 'PAYMENT', 'SUBMIT'
   * @param {Array<{bbox?: Object, type?: string}>} [params.sensitiveItems]
   * @returns {Array<{bbox: Object, color: string, kind: 'safe'|'danger'|'ambiguous', label: string}>}
   */
  function buildAuthorizationHighlights({ targetBbox, isReversible, actionType, sensitiveItems } = {}) {
    const highlights = [];
    if (targetBbox) {
      highlights.push({
        bbox: targetBbox,
        color: isReversible ? COLORS.AMBIGUOUS : COLORS.DANGER,
        kind: isReversible ? 'ambiguous' : 'danger',
        label: `${actionType || 'Consequential'}${isReversible ? ' (reversible)' : ' (irreversible)'}`,
      });
    }
    for (const item of (sensitiveItems || [])) {
      if (!item || !item.bbox) continue;
      highlights.push({
        bbox: item.bbox,
        color: COLORS.DANGER,
        kind: 'danger',
        label: item.type ? `PII: ${item.type}` : 'Sensitive item',
      });
    }
    return highlights;
  }

  /**
   * Highlight set for a task-completion moment: green for every element
   * actionHistory recorded a genuinely successful, targeted interaction
   * against (deduplicated by elementId, first success wins); red for any
   * sensitive item still visible in the final page state.
   *
   * @param {Object} params
   * @param {Array<Object>} [params.actionHistory]
   * @param {Array<{id?: number, bbox?: Object}>} [params.elements] - final extraction.elements
   * @param {Array<{bbox?: Object, type?: string}>} [params.sensitiveItems] - final extraction.sensitiveItems
   * @returns {Array<{bbox: Object, color: string, kind: 'safe'|'danger', label: string}>}
   */
  function buildCompletionHighlights({ actionHistory, elements, sensitiveItems } = {}) {
    const highlights = [];
    const elementById = new Map();
    for (const el of (elements || [])) {
      if (el && el.id != null) elementById.set(el.id, el);
    }

    const seenIds = new Set();
    for (const entry of (actionHistory || [])) {
      if (!entry || entry.elementId == null || seenIds.has(entry.elementId)) continue;
      const r = entry.result;
      const succeeded = !!r && r.success !== false && (!r.outcome || !FAILING_OUTCOMES.has(r.outcome));
      if (!succeeded) continue;
      const el = elementById.get(entry.elementId);
      if (!el || !el.bbox) continue;
      seenIds.add(entry.elementId);
      highlights.push({
        bbox: el.bbox,
        color: COLORS.SAFE,
        kind: 'safe',
        label: `${entry.action}: succeeded`,
      });
    }

    for (const item of (sensitiveItems || [])) {
      if (!item || !item.bbox) continue;
      highlights.push({
        bbox: item.bbox,
        color: COLORS.DANGER,
        kind: 'danger',
        label: item.type ? `PII still visible: ${item.type}` : 'Sensitive item still visible',
      });
    }

    return highlights;
  }

  /**
   * A compact, structured summary of a piece of evidence — the non-visual
   * half of v25's "generateDecisionEvidence" (see this file's header for
   * why the visual half lives in popup.js instead).
   *
   * @param {Object} params
   * @param {Object} [params.decision]
   * @param {Object} [params.verification] - agent/verificationLoop.js's verifyCompletion() output, if any
   * @param {Array} [params.sensitiveItems]
   * @param {Array} [params.highlights]
   * @returns {Object}
   */
  function summarizeEvidence({ decision, verification, sensitiveItems, highlights } = {}) {
    const hl = highlights || [];
    return {
      decision: decision
        ? { action: decision.action, reasoning: decision.reasoning || null, confidence: decision.confidence ?? null }
        : null,
      verification: verification
        ? { verified: verification.verified, confidence: verification.confidence, reason: verification.reason }
        : null,
      piiCount: Array.isArray(sensitiveItems) ? sensitiveItems.length : 0,
      highlightCounts: {
        safe: hl.filter((h) => h.kind === 'safe').length,
        danger: hl.filter((h) => h.kind === 'danger').length,
        ambiguous: hl.filter((h) => h.kind === 'ambiguous').length,
      },
    };
  }

  root.__BA_EvidenceGenerator = {
    COLORS,
    buildAuthorizationHighlights,
    buildCompletionHighlights,
    summarizeEvidence,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__BA_EvidenceGenerator;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
