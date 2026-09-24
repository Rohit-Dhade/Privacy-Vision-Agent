/**
 * content/textExtractor.js
 *
 * Produces a structured list of visible text runs, each tied to its
 * bounding box (and, where possible, an interactive element id), so
 * the PII detector can map a sensitive match back to on-screen
 * coordinates precisely.
 *
 * This intentionally does NOT just take document.body.innerText,
 * because that collapses everything into one blob with no positional
 * information — useless for redaction.
 */
(function (root) {
  // Matches interactiveElements.js — a guard against pathological nesting,
  // not a limit real pages hit.
  const MAX_SHADOW_DEPTH = 12;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

  function isTextNodeVisible(textNode, viewportWidth, viewportHeight) {
    const parent = textNode.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (!root.__BA_Visibility.isStyleVisible(parent)) return false;

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    range.detach && range.detach();

    if (!root.__BA_Geometry.rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
      return false;
    }
    return rect;
  }

  /**
   * Walks all visible text nodes in the document.
   *
   * elementRegistry (Map<id, HTMLElement>) is used to tag a text node
   * with the interactive element id it belongs to, if any, so the UI
   * can cross-reference "this sensitive text is inside element #4".
   */
  function extractVisibleText(viewportWidth, viewportHeight, elementRegistry) {
    // Build a reverse lookup: element -> registered interactive id.
    const elToId = new Map();
    if (elementRegistry) {
      for (const [id, el] of elementRegistry.entries()) elToId.set(el, id);
    }

    function nearestRegisteredAncestorId(el) {
      let node = el;
      while (node) {
        if (elToId.has(node)) return elToId.get(node);
        // Climb out of a shadow root into its host, so text inside a web
        // component still attributes to the interactive element containing it.
        node = node.parentElement ||
               (node.parentNode && node.parentNode.host) || null;
      }
      return null;
    }

    const textNodes = [];

    // A TreeWalker does not cross shadow boundaries, so one walker rooted at
    // document.body silently skips every text node inside a web component.
    // That is how an Aadhaar number rendered inside an open shadow root went
    // completely undetected while still being captured into the screenshot —
    // a privacy failure, measured against test-pages/hostile-realworld.html.
    //
    // The fix is one walker per shadow root, recursing into nested roots.
    // Closed roots stay unreachable by browser design.
    function walkScope(scopeRoot, depth) {
      if (!scopeRoot || depth > MAX_SHADOW_DEPTH) return;

      const walker = document.createTreeWalker(
        scopeRoot,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const rect = isTextNodeVisible(node, viewportWidth, viewportHeight);
        if (!rect) continue;

        textNodes.push({
          node, // live reference — used only within this pass, never serialized
          text: node.nodeValue.trim(),
          bbox: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          elementId: nearestRegisteredAncestorId(node.parentElement)
        });
      }

      // Recurse into every open shadow root within this scope.
      const hosts = scopeRoot.querySelectorAll ? scopeRoot.querySelectorAll('*') : [];
      hosts.forEach((el) => {
        if (el.shadowRoot) walkScope(el.shadowRoot, depth + 1);
      });
    }

    walkScope(document.body, 0);

    return textNodes;
  }

  root.__BA_TextExtractor = { extractVisibleText };
})(window);
