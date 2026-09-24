/**
 * agent/debateManager.js
 *
 * Multi-Agent Debate — the Hybrid Debate Privacy Dial position, per
 * claude/v25-master-implementation-guide.md Part 2 (Mode 3) and Part 3
 * (Task 2.3): run the on-device reasoner (agent/webllmEngine.js, via
 * agentBackend.decideNextActionLocalLLM(), executed inside offscreen.js)
 * and the cloud reasoner (agentBackend.decideNextAction(), the extension's
 * one network call) IN PARALLEL for the same step, then tell the user
 * plainly whether they agreed and, if not, by how much and why.
 *
 * This is deliberately NOT a black box that silently averages two
 * opinions. Every debate produces a full evidence record — both
 * decisions, both confidence breakdowns (agent/confidenceScorer.js), the
 * disagreement gap, and which resolution tier fired — for
 * popup.js to render before the chosen action executes.
 *
 * Resolution tiers (v25 spec):
 *   agree                      -> use the higher-confidence side (they
 *                                 already picked the same action; this
 *                                 only decides whose confidence framing to
 *                                 keep)
 *   disagree, gap < 5%         -> auto-resolve: use higher confidence
 *   disagree, gap 5%–15%       -> use higher confidence, but flag clearly
 *                                 for the user in the evidence panel
 *   disagree, gap > 15%        -> use higher confidence, flag strongly —
 *                                 popup.js still routes the action through
 *                                 every existing safety gate below this
 *                                 (consequential-action confirmation,
 *                                 sensitive-field ask_user, stale-target
 *                                 re-validation) exactly as it would for
 *                                 any other mode, so a wide disagreement
 *                                 on a high-stakes action is still caught
 *                                 there even before a human reads the
 *                                 evidence panel.
 *
 * Degraded modes: either reasoner may be genuinely unavailable this step
 * (local model not vendored yet — see lib/webllm/README.md — or the cloud
 * backend unreachable). Promise.allSettled() means one failing never
 * blocks the other; the debate result simply records which side degraded
 * and why, and the surviving decision is used with no debate to show.
 */
(function (root) {

  function actionsRoughlyMatch(a, b) {
    if (!a || !b) return false;
    if (a.action !== b.action) return false;
    if (a.targetSelector && b.targetSelector) return a.targetSelector === b.targetSelector;
    if (a.elementId != null && b.elementId != null) return a.elementId === b.elementId;
    // Actions with no target at all (wait/done/back/forward/navigate) —
    // matching action names is agreement enough.
    return !a.targetSelector && !b.targetSelector && a.elementId == null && b.elementId == null;
  }

  function resolutionForGap(agree, gap) {
    if (agree) return 'AGREE';
    if (gap < 0.05) return 'DISAGREE_AUTO_RESOLVE';
    if (gap < 0.15) return 'DISAGREE_SHOW_BOTH';
    return 'DISAGREE_ASK_USER_RECOMMENDED';
  }

  class DebateManager {
    /**
     * @param {{agentBackend: object, confidenceScorer?: object}} deps
     */
    constructor({ agentBackend, confidenceScorer } = {}) {
      if (!agentBackend) throw new Error('DebateManager requires an agentBackend instance.');
      this.agentBackend = agentBackend;
      this.confidenceScorer = confidenceScorer || root.__BA_ConfidenceScorer || null;
    }

    _scoreOrFallback(decision, evidence, fallback) {
      if (!decision) return { confidence: 0, factors: {}, vulnerabilities: [] };
      if (this.confidenceScorer) {
        try { return this.confidenceScorer.score({ decision, evidence }); } catch (_) { /* fall through */ }
      }
      return { confidence: typeof decision.confidence === 'number' ? decision.confidence : fallback, factors: {}, vulnerabilities: [] };
    }

    /**
     * @param {object} localArgs  Passed straight to agentBackend.decideNextActionLocalLLM().
     * @param {object} cloudArgs  Passed straight to agentBackend.decideNextAction().
     * @param {object} evidence   Shared evidence for confidenceScorer (task, elements, sensitiveItems, pageUrl, pageContext, consequential, trustGate).
     * @returns {Promise<{decision: object, debate: object}>}
     */
    async runDebate({ localArgs, cloudArgs, evidence = {} } = {}) {
      const [localSettled, cloudSettled] = await Promise.allSettled([
        this.agentBackend.decideNextActionLocalLLM(localArgs),
        this.agentBackend.decideNextAction(cloudArgs),
      ]);

      const local = localSettled.status === 'fulfilled' ? localSettled.value : null;
      const localError = localSettled.status === 'rejected'
        ? (localSettled.reason && localSettled.reason.message) || String(localSettled.reason)
        : null;

      const cloud = cloudSettled.status === 'fulfilled' ? cloudSettled.value : null;
      const cloudError = cloudSettled.status === 'rejected'
        ? (cloudSettled.reason && cloudSettled.reason.message) || String(cloudSettled.reason)
        : null;

      if (!local && !cloud) {
        const err = new Error(
          `Hybrid Debate: both reasoners failed this step. Local: ${localError || 'unknown error'}. ` +
          `Cloud: ${cloudError || 'unknown error'}.`
        );
        err.localError = localError;
        err.cloudError = cloudError;
        throw err;
      }

      if (!local) {
        return {
          decision: cloud,
          debate: {
            mode: 'CLOUD_ONLY_DEGRADED',
            reason: localError,
            agreement: null,
            gap: null,
            resolution: 'CLOUD_ONLY_DEGRADED',
            local: null,
            cloud: { ...cloud, confidence: this._scoreOrFallback(cloud, evidence, cloud.confidence ?? 0.7).confidence },
          },
        };
      }

      if (!cloud) {
        return {
          decision: local,
          debate: {
            mode: 'LOCAL_ONLY_DEGRADED',
            reason: cloudError,
            agreement: null,
            gap: null,
            resolution: 'LOCAL_ONLY_DEGRADED',
            local: { ...local, confidence: this._scoreOrFallback(local, evidence, local.confidence ?? 0.6).confidence },
            cloud: null,
          },
        };
      }

      const localScored = this._scoreOrFallback(local, evidence, local.confidence ?? 0.6);
      const cloudScored = this._scoreOrFallback(cloud, evidence, cloud.confidence ?? 0.7);

      const agree = actionsRoughlyMatch(local, cloud);
      const gap = Number(Math.abs(localScored.confidence - cloudScored.confidence).toFixed(3));
      const resolution = resolutionForGap(agree, gap);
      const preferLocal = localScored.confidence >= cloudScored.confidence;
      const winner = preferLocal ? local : cloud;

      return {
        decision: { ...winner, confidence: preferLocal ? localScored.confidence : cloudScored.confidence, decidedBy: preferLocal ? 'local' : 'cloud' },
        debate: {
          mode: 'FULL_DEBATE',
          agreement: agree,
          gap,
          resolution,
          local: { ...local, confidence: localScored.confidence, factors: localScored.factors, vulnerabilities: localScored.vulnerabilities },
          cloud: { ...cloud, confidence: cloudScored.confidence, factors: cloudScored.factors, vulnerabilities: cloudScored.vulnerabilities },
        },
      };
    }
  }

  root.__BA_DebateManager = DebateManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DebateManager };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
