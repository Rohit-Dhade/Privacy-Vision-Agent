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
    '[role="switch"]',
    '[role="option"]',
    '[tabindex]'
  ].join(',');

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
      return opt ? (opt.text || opt.value || null) : (el.value || null);
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

  /**
   * Collects visible interactive elements from the current document.
   * Returns { elements: [...], registry: Map<id, HTMLElement> }
   */
  function extractInteractiveElements(viewportWidth, viewportHeight) {
    const candidates = new Set(document.querySelectorAll(INTERACTIVE_SELECTOR));

    document.querySelectorAll('div,span,li,section,article').forEach((el) => {
      if (candidates.has(el)) return;
      if (hasPointerCursor(el) && el.getAttribute('tabindex') !== '-1') {
        candidates.add(el);
      }
    });

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

      elements.push({
        id,
        type: classifyType(el),
        text: shortText(el),
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
        enabled: !isDisabled(el)
      });

      registry.set(id, el);
    }

    return { elements, registry };
  }

  root.__BA_InteractiveElements = { extractInteractiveElements };
})(window);