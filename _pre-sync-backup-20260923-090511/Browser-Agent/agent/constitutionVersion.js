/**
 * agent/constitutionVersion.js
 *
 * The single source of truth for which version of CONSTITUTION.md (the
 * plain-language, publicly readable statement of what this agent will
 * and won't do on its own) this build follows.
 *
 * Surfaced in the Privacy Receipt panel (popup.js) as "POLICY vX.Y.Z" so
 * a user can tell, from inside the product itself, whether the policy
 * protecting them just changed between one build and the next — per
 * Pillar 7 of claude/v07-original-system-design-global.md: "note the
 * version in the Privacy Receipt so a user can tell whether the policy
 * protecting them just changed."
 *
 * Bump this whenever CONSTITUTION.md's version changes (see that file's
 * own "Versioning rule" section for what counts as a bump-worthy change)
 * — the two numbers are meant to always match.
 */
(function (root) {
  root.__BA_ConstitutionVersion = '1.0.0';
})(typeof window !== 'undefined' ? window : self);
