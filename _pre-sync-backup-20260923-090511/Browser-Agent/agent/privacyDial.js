/**
 * agent/privacyDial.js
 *
 * The Privacy Dial — a user-facing, explicit control over the trust
 * boundary this extension operates under, instead of one fixed pipeline.
 * Three positions:
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
 *              Local mode resolves only what a deterministic, zero-network
 *              engine can honestly resolve: filling fields the local
 *              semantic matcher + private store can confidently answer,
 *              and asking the human directly for anything else (never
 *              guessing, never inferring intent from a screenshot). This
 *              is the mode for a genuinely high-stakes privacy context —
 *              a user who needs zero data transmitted, not a good-faith
 *              best effort at minimizing it.
 *
 * This file only owns mode storage + small pure helpers. The actual
 * behavioral differences live where they always did: agent/agentBackend.js
 * (the hard cloud-call guard + the new decideNextActionLocalOnly()) and
 * popup/popup.js (which branch of the agent loop runs each step).
 */
(function (root) {

  const STORAGE_KEY = 'ba_privacy_dial_mode';
  const DEFAULT_MODE = 'hybrid';
  const MODES = ['cloud', 'hybrid', 'local'];

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
      description: 'The cloud model is never contacted for the rest of this task — not even redacted structural metadata. Fills what it can confidently match locally and asks you directly for the rest. Slower and less capable on complex pages, by design.'
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
