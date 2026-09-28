/**
 * content/iconCandidateDetector.js
 *
 * Trigger condition for the local vision fallback (see
 * claude/v06-local-vision-fallback-scope.md and utils/iconHeuristics.js).
 * Runs purely over the plain-object elements list interactiveElements.js
 * already produced — no new DOM queries, no extra cost on pages that
 * don't need this at all.
 *
 * The whole point of this gate is to keep the fallback near-zero-cost:
 * on a typical page almost every button already has visible text or an
 * aria-label, so this returns an empty list and the vision heuristic
 * (utils/iconHeuristics.js, run later against the screenshot) never even
 * runs. It only fires for the actual failure case DOM extraction has no
 * answer for: icon-only glyph buttons (hamburger menus, cart icons,
 * social-login glyphs, close/settings icons) — exactly where a
 * screenshot-reading pass adds real information the DOM doesn't have.
 */
(function (root) {
  const MIN_ICON_SIZE = 16;
  const MAX_ICON_SIZE = 64;
  const MIN_ASPECT_RATIO = 0.6; // roughly square, not a full-width bar or a thin divider
  const MAX_ASPECT_RATIO = 1.67;
  // Raised from 5 after the real-browser end-to-end run measured the actual
  // cost of the shipped classifier at ~0.5ms per crop (see
  // Browser-Agent/tools/train-icon-model/README.md). The original cap was
  // set defensively when per-icon cost was unknown; at 0.5ms even a
  // toolbar-heavy page costs single-digit milliseconds, and capping at 5
  // meant silently ignoring most of the icons on exactly the dense
  // application UIs where naming them helps the reasoner most. The demo
  // fixture alone has 14 icon-only buttons, of which the old cap saw 5.
  const MAX_CANDIDATES = 16;

  const ICON_ELIGIBLE_TYPES = new Set(['button', 'link', 'role:button', 'role:tab', 'role:menuitem']);

  function isBlank(str) {
    return str == null || String(str).trim() === '';
  }

  /**
   * @param {Array<Object>} elements - the plain-object elements list from interactiveElements.js
   * @param {number} [maxCandidates]
   * @returns {Array<{elementId: number|string, bbox: {x,y,width,height}}>}
   */
  function findUnlabeledIconCandidates(elements, maxCandidates = MAX_CANDIDATES) {
    if (!Array.isArray(elements)) return [];
    const candidates = [];

    for (const el of elements) {
      if (!el || el.visible === false || el.enabled === false) continue;

      // Already has a usable label — DOM extraction already gave the
      // reasoner everything it needs, no need for a vision pass.
      if (!isBlank(el.text) || !isBlank(el.ariaLabel) || !isBlank(el.placeholder)) continue;

      if (!ICON_ELIGIBLE_TYPES.has(el.type)) continue;

      const bbox = el.bbox;
      if (!bbox || !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)) continue;
      if (bbox.width < MIN_ICON_SIZE || bbox.width > MAX_ICON_SIZE) continue;
      if (bbox.height < MIN_ICON_SIZE || bbox.height > MAX_ICON_SIZE) continue;

      const ratio = bbox.width / bbox.height;
      if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) continue;

      candidates.push({ elementId: el.id, bbox });
      if (candidates.length >= maxCandidates) break;
    }

    return candidates;
  }

  root.__BA_IconCandidateDetector = { findUnlabeledIconCandidates };
})(window);
