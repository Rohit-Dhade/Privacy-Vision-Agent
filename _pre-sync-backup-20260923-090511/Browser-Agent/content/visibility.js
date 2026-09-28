/**
 * content/visibility.js
 *
 * Determines whether an element is *actually visible to the user right
 * now* — on screen, not display:none/visibility:hidden/opacity:0, and
 * not zero-sized. This is the gatekeeper used before an element is ever
 * added to the extracted DOM list, per the extension's "only what the
 * user can see" principle.
 */
(function (root) {
  function isStyleVisible(el) {
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  /**
   * Climbs one level up the COMPOSED tree: normally the parent element, but
   * out through a shadow root to its host when the node sits at the top of
   * one. `parentElement` is null for an element whose parent is a ShadowRoot
   * (a ShadowRoot is a DocumentFragment, not an Element), so a plain
   * parentElement walk silently stops at every shadow boundary.
   */
  function composedParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    // A ShadowRoot exposes its host; that is the way out of the shadow tree.
    if (p && p.host) return p.host;
    return null;
  }

  /** True when `ancestor` contains `node` in the composed tree, crossing
   *  shadow boundaries. Node.contains() does not cross them. */
  function composedContains(ancestor, node) {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = composedParent(cur);
    }
    return false;
  }

  /**
   * Hit-tests through shadow roots.
   *
   * document.elementFromPoint() does not pierce shadow DOM — it returns the
   * HOST element. Combined with Node.contains() also not crossing shadow
   * boundaries, the occlusion check below concluded that every element
   * inside a web component was hidden behind something, and rejected all of
   * them. That is why extraction reported ZERO interactive elements on
   * test-pages/hostile-realworld.html while happily finding the same page's
   * shadow-DOM text: the text walker had been fixed, this gate had not.
   *
   * Drilling down with each root's own elementFromPoint reaches the true topmost
   * node through any depth of nesting.
   */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard++ < 12) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /**
   * Walks up the ancestor chain to make sure no ancestor is itself
   * hidden (display:none on a parent hides children even if their own
   * computed style looks fine in some edge cases with detached checks).
   * Crosses shadow boundaries, so a component hidden by its host is
   * correctly treated as hidden.
   */
  function ancestorsVisible(el) {
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 200) {
      if (!isStyleVisible(node)) return false;
      node = composedParent(node);
    }
    return true;
  }

  /**
   * Core visibility check combining geometry + computed style.
   * viewportWidth/Height should be window.innerWidth/innerHeight.
   */
  function isElementVisible(el, viewportWidth, viewportHeight) {
    if (!el || el.nodeType !== 1) return false;

    const rect = el.getBoundingClientRect();
    if (!root.__BA_Geometry.rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
      return false;
    }

    if (!isStyleVisible(el)) return false;
    if (!ancestorsVisible(el)) return false;

    // elementFromPoint sanity check: is *this* element (or a descendant
    // of it, e.g. an inner <span> inside a <button>) actually the
    // topmost thing at its own center point? This filters out elements
    // fully hidden behind an unrelated overlay/modal.
    try {
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);
      const topEl = deepElementFromPoint(cx, cy);
      if (topEl && !(composedContains(el, topEl) || composedContains(topEl, el))) {
        return false;
      }
    } catch (e) {
      // If elementFromPoint fails for any reason, don't block on it.
    }

    return true;
  }

  root.__BA_Visibility = {
    isElementVisible, isStyleVisible,
    // Exposed because other content modules need the same shadow-aware
    // traversal rather than reimplementing it.
    composedParent, composedContains, deepElementFromPoint
  };
})(window);
