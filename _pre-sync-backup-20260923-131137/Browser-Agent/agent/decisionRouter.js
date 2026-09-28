/**
 * agent/decisionRouter.js
 *
 * Explicit 4-layer decision routing (claude/v25-master-implementation-guide.md
 * Part 3, Task 2.5): decision-tree -> heuristics -> local LLM -> cloud
 * escalation, formalized as one module instead of ad-hoc branching spread
 * across popup.js. Each layer is tried in increasing order of cost and
 * network exposure, and the router escalates past a layer only when that
 * layer couldn't confidently answer THIS step:
 *
 *   1. TREE       — agent/fieldMatcher.js exact-label / HTML-type matches
 *                    (confidence 'high'): a field this codebase already
 *                    knows maps to a specific private-data key. Zero
 *                    network, zero model, effectively instant.
 *   2. HEURISTIC   — agent/fieldMatcher.js fallback-regex matches
 *                    (confidence 'medium'): a looser but still fully local,
 *                    zero-model guess at the same thing.
 *   3. LOCAL_LLM   — agent/webllmEngine.js, reached via
 *                    agentBackend.decideNextActionLocalLLM(): the on-device
 *                    model reasons about the page once no deterministic
 *                    rule matched. Still makes zero network requests — see
 *                    that method's own doc comment in agent/agentBackend.js.
 *   4. CLOUD       — agentBackend.decideNextAction(): the one function in
 *                    the whole extension that makes an outbound network
 *                    call. Reached only when every local layer above
 *                    declined, failed, or (optionally) answered with low
 *                    confidence — and NEVER reached at all when the Privacy
 *                    Dial is set to Fully Local. This module enforces that
 *                    as its own guard, on top of (not instead of) the
 *                    identical hard guard already inside
 *                    agentBackend.decideNextAction() itself — belt and
 *                    braces, not a single point of failure.
 *
 * This is a different mechanism from agent/debateManager.js's Hybrid
 * Debate mode, and the two are not layered on top of each other. Debate
 * deliberately runs the local LLM and the cloud reasoner IN PARALLEL every
 * step, specifically to compare them and surface disagreement. This
 * router instead escalates IN SEQUENCE, going only as far up the chain as
 * it has to, to answer with the cheapest and most private layer capable of
 * a confident response. Cloud-Assisted and Hybrid Privacy Dial modes are
 * the intended callers of this module; Hybrid Debate mode keeps using
 * debateManager.js directly and never calls route() below.
 *
 * Nothing here loosens any guarantee in CONSTITUTION.md: whichever layer
 * produces a decision, popup.js still runs it through the exact same
 * consequential-action human-authorization protocol and sensitive-field
 * ask_user guard it always has. This module only decides WHICH reasoner
 * answers a given step — never whether a human needs to confirm what
 * happens next. It does attach a consequential-action preview
 * (agent/consequentialActionDetector.js) to the returned decision purely
 * for the routing-distribution telemetry and any UI that wants to show it
 * early; that preview is informational and is not itself a gate.
 *
 * Wired in (popup/popup.js's runAgentLoop()): only Hybrid mode calls
 * route(). Cloud-Assisted mode calls agentBackend.decideNextAction()
 * directly and unconditionally instead, by design — its whole point is
 * maximum-capability comparison against the cloud reasoner every step, so
 * it deliberately skips this router's local-first attempt. (An earlier
 * draft of this comment said Cloud-Assisted was also an intended caller;
 * that was never wired up and contradicted this module's own "escalate
 * only when needed" design, so it's corrected here rather than left
 * stale.) Fully Local mode keeps its own inline TREE/HEURISTIC/LOCAL_LLM
 * logic in popup.js rather than calling route() — functionally the same
 * three layers, kept separate because Fully Local mode's UX for a total
 * local-layer failure (retry the loop with a system message) intentionally
 * differs from this router's ASK_USER fallback.
 */
(function (root) {
  const KNOWN_LAYERS = ['TREE', 'HEURISTIC', 'LOCAL_LLM', 'CLOUD', 'ASK_USER'];

  class DecisionRouter {
    /**
     * @param {{
     *   agentBackend: object,
     *   fieldMatcher?: object,
     *   formAnalyzer?: object,
     *   consequentialActionDetector?: object,
     * }} deps
     */
    constructor({ agentBackend, fieldMatcher, formAnalyzer, consequentialActionDetector } = {}) {
      if (!agentBackend) throw new Error('DecisionRouter requires an agentBackend instance.');
      this.agentBackend = agentBackend;
      this.fieldMatcher = fieldMatcher || root.__BA_FieldMatcher || null;
      this.formAnalyzer = formAnalyzer || root.__BA_FormAnalyzer || null;
      this.consequentialActionDetector = consequentialActionDetector || root.__BA_ConsequentialActionDetector || null;
      this._stats = { TREE: 0, HEURISTIC: 0, LOCAL_LLM: 0, CLOUD: 0, ASK_USER: 0 };
    }

    /**
     * Routing-distribution telemetry v25 Part 3 Task 2.5 calls for: how
     * many decisions, over this session, were resolved at each layer.
     * Surfaced by popup.js so a user (or a benchmark run) can see how
     * often the extension actually needed the cloud versus how often a
     * fully-local layer already had the answer.
     */
    getRoutingStats() {
      const total = Object.values(this._stats).reduce((a, b) => a + b, 0);
      return { counts: { ...this._stats }, total };
    }

    resetRoutingStats() {
      for (const k of Object.keys(this._stats)) this._stats[k] = 0;
    }

    _record(layer) {
      if (Object.prototype.hasOwnProperty.call(this._stats, layer)) this._stats[layer]++;
    }

    _annotateConsequential(decision, context) {
      if (!decision || !this.consequentialActionDetector) return decision;
      try {
        const elements = context.elements || [];
        const el = elements.find((e) => e && e.id === decision.elementId) || null;
        const info = this.consequentialActionDetector.isConsequentialElement(el, decision.targetSelector, {
          pageUrl: context.pageUrl,
          taskInstruction: context.task,
          pageContext: context.pageContext,
        });
        return { ...decision, consequentialPreview: info };
      } catch (_) {
        return decision;
      }
    }

    /**
     * Layers 1+2, combined into one scan: a from-scratch pass over the
     * live elements rather than reusing
     * agentBackend.decideNextActionLocalOnly() as-is, because that method
     * (by design, for its own simpler callers) doesn't expose which
     * fieldMatcher confidence tier — 'high' (tree) vs 'medium' (heuristic)
     * — actually fired, and this router needs that split for its
     * telemetry. The matching logic itself is unchanged: same
     * formAnalyzer.isFormInputElement() gate, same
     * AgentBackend.isElementPopulated() skip, same fieldMatcher.matchElement().
     */
    _routeTreeAndHeuristic(elements) {
      if (!this.fieldMatcher || !Array.isArray(elements)) return null;
      const AgentBackendCtor = root.__BA_AgentBackend;
      const isPopulated = (AgentBackendCtor && typeof AgentBackendCtor.isElementPopulated === 'function')
        ? AgentBackendCtor.isElementPopulated
        : () => false;
      const isFormField = (el) => (this.formAnalyzer ? this.formAnalyzer.isFormInputElement(el) : Boolean(el && el.tag === 'input'));

      for (const el of elements) {
        if (!isFormField(el) || isPopulated(el)) continue;
        const match = this.fieldMatcher.matchElement(el);
        if (!match.matched || !match.key) continue;
        const layer = match.confidence === 'high' ? 'TREE' : 'HEURISTIC';
        return {
          layer,
          decision: {
            action: 'fill_from_local',
            elementId: el.id,
            targetSelector: el.selector,
            value: null,
            matchedKey: match.key,
            matchReason: match.reason,
          },
        };
      }
      return null;
    }

    /**
     * Runs the full 4-layer escalation for one agent step.
     *
     * @param {object} args
     * @param {string} args.task
     * @param {{elements: Array, url?: string}} args.extraction
     * @param {Array} [args.actionHistory]
     * @param {object} [args.formSummary]
     * @param {object} [args.cloudArgs]            Full payload for
     *   agentBackend.decideNextAction(), if cloud escalation is reached.
     *   Omit (or leave privacyDialMode:'local') to make layer 4 unreachable.
     * @param {string} args.privacyDialMode         'local' | 'hybrid' | 'cloud'
     *   (never 'debate' — Hybrid Debate mode calls debateManager.js directly,
     *   not this router).
     * @param {string} [args.mode='hitl']           passed through to the
     *   translateAction() normalization inside agentBackend.
     * @param {number} [args.localLlmConfidenceFloor=0.5] Below this
     *   confidence, and only when cloud escalation is actually possible,
     *   the router asks the cloud reasoner for a second opinion instead of
     *   settling for the local model's uncertain guess.
     * @returns {Promise<{decision: object, routing: {layer: string, attempts: Array}}>}
     */
    async route({
      task,
      extraction,
      actionHistory = [],
      formSummary,
      cloudArgs,
      privacyDialMode,
      mode = 'hitl',
      localLlmConfidenceFloor = 0.5,
    } = {}) {
      const elements = (extraction && Array.isArray(extraction.elements)) ? extraction.elements : [];
      const context = { elements, task, pageUrl: extraction && extraction.url, pageContext: cloudArgs && cloudArgs.pageContext };
      const attempts = [];

      // Layers 1+2 — decision tree, then heuristic fallback.
      const treeResult = this._routeTreeAndHeuristic(elements);
      if (treeResult) {
        this._record(treeResult.layer);
        attempts.push({ layer: treeResult.layer, outcome: 'used' });
        return { decision: this._annotateConsequential(treeResult.decision, context), routing: { layer: treeResult.layer, attempts } };
      }
      attempts.push({ layer: 'TREE', outcome: 'no_match' });
      attempts.push({ layer: 'HEURISTIC', outcome: 'no_match' });

      // Layer 3 — on-device LLM. Always attempted next, even in Fully
      // Local mode: per agentBackend.decideNextActionLocalLLM()'s own doc
      // comment this is the one escalation Fully Local mode allows, since
      // it never leaves the browser.
      let localLlmResult = null;
      let localLlmError = null;
      try {
        localLlmResult = await this.agentBackend.decideNextActionLocalLLM({ task, extraction, actionHistory, formSummary, mode });
      } catch (err) {
        localLlmError = (err && err.message) || String(err);
      }

      const canEscalateToCloud = privacyDialMode !== 'local' && Boolean(cloudArgs);
      const localConfidence = (localLlmResult && typeof localLlmResult.confidence === 'number') ? localLlmResult.confidence : 0;

      if (localLlmResult && (!canEscalateToCloud || localConfidence >= localLlmConfidenceFloor)) {
        this._record('LOCAL_LLM');
        attempts.push({ layer: 'LOCAL_LLM', outcome: 'used', confidence: localConfidence });
        return { decision: this._annotateConsequential(localLlmResult, context), routing: { layer: 'LOCAL_LLM', attempts } };
      }
      attempts.push({
        layer: 'LOCAL_LLM',
        outcome: localLlmResult ? 'low_confidence' : 'unavailable',
        error: localLlmError,
        confidence: localConfidence,
      });

      // Layer 4 — cloud escalation. Never reached in Fully Local mode, or
      // when the caller didn't even supply a cloud payload.
      if (canEscalateToCloud) {
        try {
          const cloudResult = await this.agentBackend.decideNextAction(cloudArgs);
          this._record('CLOUD');
          attempts.push({ layer: 'CLOUD', outcome: 'used' });
          return { decision: this._annotateConsequential(cloudResult, context), routing: { layer: 'CLOUD', attempts } };
        } catch (err) {
          attempts.push({ layer: 'CLOUD', outcome: 'failed', error: (err && err.message) || String(err) });
        }
      } else if (privacyDialMode === 'local') {
        attempts.push({ layer: 'CLOUD', outcome: 'skipped_fully_local' });
      }

      // Every layer above either declined or failed outright. If the local
      // LLM at least produced a low-confidence answer and cloud either
      // isn't allowed or just failed too, use that answer rather than
      // stalling on ask_user — a disclosed low-confidence guess is still
      // routed through every downstream safety gate (consequential-action
      // confirmation, sensitive-field ask_user) exactly like any other
      // decision, so this doesn't trade away any protection.
      if (localLlmResult) {
        this._record('LOCAL_LLM');
        attempts.push({ layer: 'LOCAL_LLM', outcome: 'used_as_last_resort', confidence: localConfidence });
        return { decision: this._annotateConsequential(localLlmResult, context), routing: { layer: 'LOCAL_LLM', attempts } };
      }

      this._record('ASK_USER');
      attempts.push({ layer: 'ASK_USER', outcome: 'used' });
      const fallback = (typeof this.agentBackend.buildAskUserAction === 'function')
        ? this.agentBackend.buildAskUserAction(null, null, null)
        : { action: 'ask_user', elementId: null, targetSelector: null, value: null, question: 'I could not determine the next step — what should I do?' };
      return { decision: fallback, routing: { layer: 'ASK_USER', attempts } };
    }
  }

  DecisionRouter.KNOWN_LAYERS = KNOWN_LAYERS;
  root.__BA_DecisionRouter = DecisionRouter;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DecisionRouter };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
