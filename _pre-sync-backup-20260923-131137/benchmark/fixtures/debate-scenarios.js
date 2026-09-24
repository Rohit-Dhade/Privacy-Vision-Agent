/**
 * benchmark/fixtures/debate-scenarios.js
 *
 * Fixtures for agent/debateManager.js's Hybrid Debate resolution logic
 * (v25 Part 3, Task 6.1). Each scenario specifies what the local reasoner
 * (agentBackend.decideNextActionLocalLLM) and the cloud reasoner
 * (agentBackend.decideNextAction) would resolve/reject with, and what
 * debateManager.js is expected to conclude.
 *
 * Deliberately mocks ONLY agentBackend's two decision sources — everything
 * downstream (agent/debateManager.js's own resolution-tier logic,
 * agent/confidenceScorer.js's real scoring) runs unmodified, exactly like
 * the rest of this benchmark runs the extension's own unmodified source
 * files. Every scenario passes `evidence: {}` to runDebate(), which makes
 * confidenceScorer.js's combineFactors() collapse to a single present
 * factor (modelSelfConfidence) — so the scored confidence is deterministic
 * and exactly equal to each mocked decision's own `confidence` field. This
 * keeps the fixture fully reproducible without needing a second fake
 * confidenceScorer standing in for the real one.
 *
 * `resolutionForGap()`'s tiers, restated here for the fixtures below:
 *   agree                -> 'AGREE'
 *   disagree, gap < 0.05  -> 'DISAGREE_AUTO_RESOLVE'
 *   disagree, 0.05<=gap<0.15 -> 'DISAGREE_SHOW_BOTH'
 *   disagree, gap >= 0.15 -> 'DISAGREE_ASK_USER_RECOMMENDED'
 */

const SCENARIOS = [
  {
    id: 'agree-same-target-high-confidence',
    note: 'Both reasoners pick the same field and are both fairly confident — should resolve as a plain AGREE, using whichever side scored (marginally) higher.',
    local: { action: 'click', targetSelector: '#next', confidence: 0.9 },
    cloud: { action: 'click', targetSelector: '#next', confidence: 0.88 },
    expected: { mode: 'FULL_DEBATE', resolution: 'AGREE', agreement: true, decidedBy: 'local', winnerAction: 'click', winnerTarget: '#next' },
  },
  {
    id: 'agree-no-target-both-wait',
    note: 'Both reasoners propose a targetless action (wait) — actionsRoughlyMatch() has an explicit branch for this; it should still count as agreement.',
    local: { action: 'wait', confidence: 0.6 },
    cloud: { action: 'wait', confidence: 0.55 },
    expected: { mode: 'FULL_DEBATE', resolution: 'AGREE', agreement: true, decidedBy: 'local', winnerAction: 'wait' },
  },
  {
    id: 'disagree-small-gap-auto-resolve',
    note: 'Different targets, confidence gap under 5% — small enough to auto-resolve to the higher-confidence side without extra fanfare.',
    local: { action: 'click', targetSelector: '#a', confidence: 0.80 },
    cloud: { action: 'click', targetSelector: '#b', confidence: 0.83 },
    expected: { mode: 'FULL_DEBATE', resolution: 'DISAGREE_AUTO_RESOLVE', agreement: false, decidedBy: 'cloud', winnerAction: 'click', winnerTarget: '#b' },
  },
  {
    id: 'disagree-medium-gap-show-both',
    note: 'Confidence gap of 10 points (0.70 vs 0.80) — in the 5%-15% band where both sides should be shown to the user, not silently auto-resolved.',
    local: { action: 'click', targetSelector: '#a', confidence: 0.70 },
    cloud: { action: 'click', targetSelector: '#b', confidence: 0.80 },
    expected: { mode: 'FULL_DEBATE', resolution: 'DISAGREE_SHOW_BOTH', agreement: false, decidedBy: 'cloud', winnerAction: 'click', winnerTarget: '#b' },
  },
  {
    id: 'disagree-large-gap-ask-user-recommended',
    note: 'Confidence gap of 30 points (0.60 vs 0.90) — wide disagreement should be flagged strongly, recommending the user look before this executes.',
    local: { action: 'click', targetSelector: '#a', confidence: 0.60 },
    cloud: { action: 'click', targetSelector: '#pay-now', confidence: 0.90 },
    expected: { mode: 'FULL_DEBATE', resolution: 'DISAGREE_ASK_USER_RECOMMENDED', agreement: false, decidedBy: 'cloud', winnerAction: 'click', winnerTarget: '#pay-now' },
  },
  {
    id: 'local-only-degraded-cloud-backend-down',
    note: 'Cloud backend errors out (e.g. network failure) — debate should degrade gracefully to the local decision alone, not throw.',
    local: { action: 'fill_from_local', elementId: 5, confidence: 0.75 },
    cloudError: 'Network error reaching backend at https://example-backend/decide: fetch failed',
    expected: { mode: 'LOCAL_ONLY_DEGRADED', agreement: null, decidedBy: undefined, winnerAction: 'fill_from_local' },
  },
  {
    id: 'cloud-only-degraded-local-model-unavailable',
    note: 'On-device WebLLM not available yet (e.g. not vendored, or model still loading) — debate should degrade gracefully to the cloud decision alone.',
    localError: 'On-device reasoning (WebLLM) is unavailable.',
    cloud: { action: 'click', targetSelector: '#submit', confidence: 0.65 },
    expected: { mode: 'CLOUD_ONLY_DEGRADED', agreement: null, decidedBy: undefined, winnerAction: 'click', winnerTarget: '#submit' },
  },
  {
    id: 'both-reasoners-fail',
    note: 'Both the local model and the cloud backend fail in the same step — there is nothing left to act on, so this must throw rather than silently returning a fabricated decision.',
    localError: 'On-device reasoning (WebLLM) is unavailable.',
    cloudError: 'Network error reaching backend: timeout',
    expectThrow: true,
  },
];

module.exports = { SCENARIOS };
