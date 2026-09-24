/**
 * content/interactiveElements.js
 *
 * Finds candidate interactive elements on the page and turns each
 * visible one into a plain-object record safe to serialize back to the
 * extension's background/popup contexts.
 */
(function (root) {
  const INTERACTIVE_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[onclick]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="switch"]',
    '[role="option"]',
    '[tabindex]'
  ].join(',');

  // How many nested open shadow roots to descend. Design systems nest a few
  // levels; this is a guard against a pathological or cyclic structure, not a
  // meaningful limit on real pages.
  const MAX_SHADOW_DEPTH = 12;

  // Input types whose raw value must never be captured, even locally.
  const SENSITIVE_VALUE_INPUT_TYPES = new Set(['password']);

  function classifyType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      return `input:${(el.getAttribute('type') || 'text').toLowerCase()}`;
    }
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    const role = el.getAttribute('role');
    if (role) return `role:${role}`;
    return tag;
  }

  function hasPointerCursor(el) {
    try {
      return window.getComputedStyle(el).cursor === 'pointer';
    } catch (e) {
      return false;
    }
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function safeValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SENSITIVE_VALUE_INPUT_TYPES.has(type)) return null;
      if (type === 'checkbox') return el.checked ? 'checked' : 'unchecked';
      if (type === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (type === 'file') return el.files && el.files.length > 0 ? `${el.files.length} file(s) selected` : null;
      return el.value || null;
    }
    if (tag === 'select') {
      const opt = el.options && el.options[el.selectedIndex];
      if (!opt || opt.value === '' || opt.disabled) return null;
      return opt.value || opt.text || null;
    }
    if (tag === 'textarea') return el.value || null;
    return null;
  }

  /** Extract all <option> labels from a <select> (safe, no PII risk). */
  function selectOptions(el) {
    if (el.tagName.toLowerCase() !== 'select') return null;
    const opts = [];
    for (const opt of el.options) {
      if (opt.value === '' || opt.disabled) continue; // skip placeholder options
      opts.push({ value: opt.value, label: opt.text.trim() });
    }
    return opts.length > 0 ? opts : null;
  }

  /** For radio groups, capture the name & all sibling values. */
  function radioGroup(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag !== 'input' || type !== 'radio') return null;
    const name = el.getAttribute('name');
    if (!name) return null;
    const siblings = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
    return siblings.map((r) => ({
      value: r.value,
      label: r.getAttribute('aria-label') ||
             (r.id ? (document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent?.trim() || r.value) : r.value),
      checked: r.checked
    }));
  }

  function shortText(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.value ||
      (el.innerText || el.textContent || '').trim();
    return label ? label.slice(0, 200) : '';
  }

  function isStickyElement(el) {
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      try {
        const pos = window.getComputedStyle(curr).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
      } catch (_) {}
      curr = curr.parentElement;
    }
    return false;
  }

  function isSearchInput(el, inputType) {
    if (inputType === 'search') return true;
    if (el.getAttribute('role') === 'searchbox') return true;
    const name = (el.getAttribute('name') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    return name.includes('search') || placeholder.includes('search') || ariaLabel.includes('search') || id.includes('search');
  }

  function isPaginationControl(el, text) {
    const parentNav = el.closest('nav, [role="navigation"]');
    const isPagingNav = parentNav && /pagination|paging/i.test(parentNav.getAttribute('aria-label') || parentNav.className || '');
    if (isPagingNav) return true;
    const cleanText = text.trim().toLowerCase();
    if (/^(next|prev|previous|first|last|\d+)$/i.test(cleanText)) return true;
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('page') || ariaLabel.includes('pagination') || ariaLabel.includes('next page') || ariaLabel.includes('previous page')) return true;
    return false;
  }

  function getModalAncestor(el) {
    return el.closest('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  }

  function getNavAncestor(el) {
    return el.closest('nav, [role="navigation"], header');
  }

  /**
   * Collects visible interactive elements from the current document.
   * Returns { elements: [...], registry: Map<id, HTMLElement> }
   */
  function extractInteractiveElements(viewportWidth, viewportHeight) {
    const candidates = new Set();

    // Collect across shadow boundaries.
    //
    // document.querySelectorAll() does not pierce shadow roots — not "less
    // reliably", not at all. On a site built from web components (which is now
    // most design systems: Salesforce Lightning, Ionic, many bank portals,
    // large parts of YouTube) a document-level query returns ZERO interactive
    // elements. That was measured, not assumed: against
    // test-pages/hostile-realworld.html the pipeline found zero elements and
    // zero PII on a page carrying an Aadhaar number and a form field three
    // shadow roots deep.
    //
    // Both halves of that matter. The agent being blind is a capability
    // failure. The PII going undetected is a PRIVACY failure, because those
    // pixels are still captured into the screenshot that gets transmitted.
    //
    // So this walks the composed tree: every element's own shadowRoot is
    // descended into recursively. Closed roots remain unreachable — that is a
    // browser guarantee rather than an oversight, and the hostile fixture
    // documents it.
    //
    // A CSS selector cannot cross a shadow boundary, so selectors generated
    // for these elements will not resolve through document.querySelector().
    // That is handled: content.js's resolveElement() prefers the live element
    // registry keyed by id and only falls back to the selector, and the
    // registry holds the real node reference.
    function collectDeep(scope, depth) {
      if (!scope || depth > MAX_SHADOW_DEPTH) return;

      scope.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => candidates.add(el));

      scope.querySelectorAll('div,span,li,section,article').forEach((el) => {
        if (candidates.has(el)) return;
        if (hasPointerCursor(el) && el.getAttribute('tabindex') !== '-1') {
          candidates.add(el);
        }
      });

      scope.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) collectDeep(el.shadowRoot, depth + 1);
      });
    }

    collectDeep(document, 0);

    const elements = [];
    const registry = new Map();
    let nextId = 0;

    for (const el of candidates) {
      if (!root.__BA_Visibility.isElementVisible(el, viewportWidth, viewportHeight)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      const id = nextId++;
      const selector = root.__BA_Selectors.getStableSelector(el);
      const tag = el.tagName.toLowerCase();
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      const text = shortText(el);

      elements.push({
        id,
        type: classifyType(el),
        text,
        ariaLabel: el.getAttribute('aria-label') || null,
        placeholder: el.getAttribute('placeholder') || null,
        value: safeValue(el),
        href: tag === 'a' ? el.getAttribute('href') : null,
        // Extra metadata for special element types
        options: selectOptions(el),          // <select> choices
        radioGroup: radioGroup(el),          // radio group siblings
        accept: (tag === 'input' && inputType === 'file') ? (el.getAttribute('accept') || null) : null,
        multiple: (tag === 'input' && inputType === 'file') ? el.multiple : false,
        bbox: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        selector,
        visible: true,
        enabled: !isDisabled(el),
        // Semantic categorization
        isSearch: isSearchInput(el, inputType),
        isPagination: isPaginationControl(el, text),
        inModal: Boolean(getModalAncestor(el)),
        inNav: Boolean(getNavAncestor(el)),
        isSticky: isStickyElement(el),
        formId: el.form ? (el.form.id || el.form.name || el.form.getAttribute('action') || 'form') : (el.closest('form') ? (el.closest('form').id || 'form') : null),
        // Resolved (absolute) form submission URL, if any — used by the
        // pre-autofill trust gate (agent/trustGate.js) to detect a form
        // that posts to a different domain than the page it's shown on.
        // `.action` (not getAttribute) so the browser resolves it to an
        // absolute URL for us, matching how it will actually submit.
        formAction: el.form ? (el.form.action || null) : (el.closest('form') ? (el.closest('form').action || null) : null)
      });

      registry.set(id, el);
    }

    return { elements, registry };
  }

  root.__BA_InteractiveElements = { extractInteractiveElements };
})(window);