/**
 * agent/privacyDial.js
 *
 * The Privacy Dial — a user-facing, explicit control over the trust
 * boundary this extension operates under, instead of one fixed pipeline.
 * Four positions:
 *
 *   'cloud'  — Cloud-Assisted (previous fixed default). Every step's
 *              redacted screenshot + sanitized DOM skeleton is sent to
 *              the configured cloud reasoner. Fastest, most capable.
 *
 *   'hybrid' — Prefer the local, zero-cloud fast path (agent/fieldMatcher.js
 *              + privateDataStore) whenever it alone can resolve every
 *              empty field on the page; fall back to the cloud reasoner
 *              only when local confidence isn't enough. This is the
 *              existing zero-cloud fast path from the prior round, now
 *              exposed as an explicit, named, user-chosen position rather
 *              than always-on undocumented behavior.
 *
 *   'local'  — Fully Local. The cloud reasoner is never contacted, for
 *              any step, for the rest of the task — not "usually skipped",
 *              architecturally unreachable. See agentBackend.js's own
 *              decideNextAction() guard, which independently refuses to
 *              run when this mode is active, so the guarantee doesn't
 *              depend on every caller remembering to check the dial.
 *              Local mode resolves what the deterministic semantic
 *              matcher + private store can confidently answer, then falls
 *              back to the on-device Qwen2.5 reasoner (agent/
 *              webllmEngine.js, via agentBackend.decideNextActionLocalLLM()
 *              — see lib/webllm/README.md for the one-time vendoring step)
 *              before finally asking the human directly for anything
 *              neither can resolve. Every step of that chain — matcher,
 *              local model, human — runs with zero network requests to
 *              any reasoning backend; only a model's own one-time weight
 *              download (cached in OPFS after that) ever touches the
 *              network, and never per-step.
 *
 *   'debate' — Hybrid Debate (⭐ claude/v25-master-implementation-guide.md's
 *              core differentiator). Runs the on-device Qwen2.5 reasoner
 *              and the cloud reasoner IN PARALLEL for the same step
 *              (agent/debateManager.js) and shows you both decisions, both
 *              confidence breakdowns, and whether they agreed — instead of
 *              silently picking one. When they agree, the higher-
 *              confidence framing is used with no fuss. When they
 *              disagree, the evidence panel says so plainly, with the
 *              disagreement gap and which side was used, so a wrong
 *              decision is visible and explainable rather than hidden
 *              behind a single black-box answer. Every existing safety
 *              gate (consequential-action confirmation, sensitive-field
 *              ask_user, stale-target re-validation) still applies to
 *              whichever side's action is chosen — the debate changes
 *              what you're shown, never what's allowed to happen
 *              autonomously.
 *
 * This file only owns mode storage + small pure helpers. The actual
 * behavioral differences live where they always did: agent/agentBackend.js
 * (the hard cloud-call guard + decideNextActionLocalOnly() +
 * decideNextActionLocalLLM()), agent/debateManager.js (the Hybrid Debate
 * orchestration), and popup/popup.js (which branch of the agent loop runs
 * each step).
 */
(function (root) {

  const STORAGE_KEY = 'ba_privacy_dial_mode';
  const DEFAULT_MODE = 'hybrid';
  const MODES = ['cloud', 'hybrid', 'local', 'debate'];

  const META = {
    cloud: {
      label: 'Cloud-Assisted',
      shortLabel: 'CLOUD',
      description: 'Every step is reasoned about by the cloud model, on the already-redacted screenshot and sanitized DOM. Fastest and most capable.'
    },
    hybrid: {
      label: 'Hybrid (Recommended)',
      shortLabel: 'HYBRID',
      description: 'Resolves whatever it can straight from your local private store with zero network calls, and only asks the cloud model when local confidence isn’t enough.'
    },
    local: {
      label: 'Fully Local',
      shortLabel: 'LOCAL',
      description: 'The cloud model is never contacted for the rest of this task — not even redacted structural metadata. Fills what it can confidently match locally, asks the on-device Qwen2.5 model next, and asks you directly for anything neither can resolve. Slower and less capable on complex pages, by design.'
    },
    debate: {
      label: 'Hybrid Debate',
      shortLabel: 'DEBATE',
      description: 'Runs the on-device model and the cloud model at the same time and shows you both decisions and confidence scores — not just one answer. When they disagree, you see exactly how and why before the action runs.'
    }
  };

  function isValidMode(mode) {
    return MODES.indexOf(mode) !== -1;
  }

  function getModeMeta(mode) {
    return META[isValidMode(mode) ? mode : DEFAULT_MODE];
  }

  async function getMode() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          const stored = result ? result[STORAGE_KEY] : null;
          resolve(isValidMode(stored) ? stored : DEFAULT_MODE);
        });
      } catch (_) {
        resolve(DEFAULT_MODE);
      }
    });
  }

  async function setMode(mode) {
    const safeMode = isValidMode(mode) ? mode : DEFAULT_MODE;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: safeMode }, () => resolve(safeMode));
      } catch (_) {
        resolve(safeMode);
      }
    });
  }

  root.__BA_PrivacyDial = {
    MODES,
    DEFAULT_MODE,
    isValidMode,
    getModeMeta,
    getMode,
    setMode
  };

})(typeof window !== 'undefined' ? window : self);
