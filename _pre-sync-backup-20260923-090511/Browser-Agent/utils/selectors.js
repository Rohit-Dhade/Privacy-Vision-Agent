/**
 * utils/selectors.js
 *
 * Builds a reasonably stable CSS selector for an element so that we can
 * re-resolve it later (e.g. right before performing a click) instead of
 * holding on to a stale live DOM reference across re-extractions.
 *
 * Preference order:
 *   1. #id                                (fastest, most stable)
 *   2. [data-testid]/[data-test]/[data-qa] (common test hooks, stable)
 *   3. tag + nth-of-type path from a nearby ancestor with an id
 *   4. full nth-of-type path from <html>   (last resort, still unique)
 *
 * SHADOW DOM. A CSS selector cannot cross a shadow boundary, so an element
 * inside a web component has no single selector that document.querySelector()
 * can resolve. Worse, the naive version of this file validated every
 * candidate with document.querySelectorAll(sel).length === 1 — which for a
 * shadow element always fails — and then fell through to a path walked with
 * parentElement, which stops dead at the shadow root and emits a path rooted
 * at <html> that resolves to the wrong node or to nothing at all.
 *
 * So shadow-hosted elements get a PIERCING PATH instead: segments joined by
 * ' >>> ', each resolved inside its own root.
 *
 *     #host-open >>> #sd-aadhaar
 *     #outer >>> div >>> #deep-btn
 *
 * resolveSelector() walks those segments, stepping through each host's
 * shadowRoot. Every candidate is validated against the element's OWN root
 * rather than the document, so the usual id/testid/name preferences still
 * apply inside a component.
 */
(function (root) {
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    // Minimal fallback escape.
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function nthOfTypeIndex(el) {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function segmentFor(el) {
    const tag = el.tagName.toLowerCase();
    return `${tag}:nth-of-type(${nthOfTypeIndex(el)})`;
  }

  const SHADOW_SEP = ' >>> ';

  /** The ShadowRoot or Document an element actually lives in. */
  function rootOf(el) {
    return (el.getRootNode && el.getRootNode()) || document;
  }

  function isShadowRoot(node) {
    return !!(node && node.host && node.nodeType === 11);
  }

  /** Unique within `scope` (a Document or ShadowRoot), not within the page. */
  function uniqueIn(scope, sel) {
    try {
      return scope.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  /** Path within one root only — stops at that root rather than walking out
   *  to <html>, which is what produced bogus paths for shadow content. */
  function buildPath(el, stopAtId) {
    const scope = rootOf(el);
    const boundary = isShadowRoot(scope) ? scope : document.documentElement;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== boundary) {
      if (node.id && stopAtId && uniqueIn(scope, `#${cssEscape(node.id)}`)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        return parts.join(' > ');
      }
      parts.unshift(segmentFor(node));
      const parent = node.parentElement;
      if (!parent) break; // top of a shadow root
      node = parent;
    }
    if (!isShadowRoot(scope)) parts.unshift('html');
    return parts.join(' > ');
  }

  /**
   * Returns a CSS selector string that should uniquely resolve back to
   * `el` within the current document.
   */
  /** Selector for `el` within its own root, ignoring shadow ancestry. */
  function localSelector(el) {
    const scope = rootOf(el);

    if (el.id) {
      const sel = `#${cssEscape(el.id)}`;
      if (uniqueIn(scope, sel)) return sel;
    }

    for (const attr of ['data-testid', 'data-test', 'data-qa']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${cssEscape(val)}"]`;
        if (uniqueIn(scope, sel)) return sel;
      }
    }

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${tag}[name="${cssEscape(name)}"]`;
      if (uniqueIn(scope, sel)) return sel;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim().length > 0 && ariaLabel.trim().length < 60) {
      const sel = `${tag}[aria-label="${cssEscape(ariaLabel.trim())}"]`;
      if (uniqueIn(scope, sel)) return sel;
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim().length > 0 && placeholder.trim().length < 60) {
      const sel = `${tag}[placeholder="${cssEscape(placeholder.trim())}"]`;
      if (uniqueIn(scope, sel)) return sel;
    }

    const shortPath = buildPath(el, true);
    if (shortPath && uniqueIn(scope, shortPath)) return shortPath;

    return buildPath(el, false);
  }

  /**
   * Returns a selector string that resolves back to `el`, piercing shadow
   * boundaries with ' >>> ' segments when the element lives inside one.
   */
  function getStableSelector(el) {
    if (!el || el.nodeType !== 1) return null;

    const segments = [localSelector(el)];
    let scope = rootOf(el);
    let guard = 0;
    while (isShadowRoot(scope) && guard++ < 12) {
      const host = scope.host;
      if (!host) break;
      segments.unshift(localSelector(host));
      scope = rootOf(host);
    }
    return segments.join(SHADOW_SEP);
  }

  /**
   * Resolve a selector back to a single live element, or null. Understands
   * the ' >>> ' piercing form by stepping into each host's shadowRoot.
   */
  function resolveSelector(selector) {
    if (!selector) return null;
    try {
      if (selector.indexOf(SHADOW_SEP) === -1) {
        const matches = document.querySelectorAll(selector);
        return matches.length >= 1 ? matches[0] : null;
      }
      const segments = selector.split(SHADOW_SEP);
      let scope = document;
      let el = null;
      for (let i = 0; i < segments.length; i++) {
        if (!scope || !scope.querySelector) return null;
        el = scope.querySelector(segments[i]);
        if (!el) return null;
        if (i < segments.length - 1) scope = el.shadowRoot;
      }
      return el;
    } catch (e) {
      return null;
    }
  }

  root.__BA_Selectors = {
    getStableSelector, resolveSelector,
    SHADOW_SEP,
    _internals: { localSelector, rootOf, isShadowRoot, uniqueIn }
  };
})(typeof window !== 'undefined' ? window : self);
