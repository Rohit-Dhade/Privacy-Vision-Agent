/**
 * content/fullPageScanner.js
 *
 * Whole-page, text-only privacy scan. No screenshots, no scrolling.
 *
 * WHY THIS EXISTS: the normal per-step pipeline (domExtractor.js ->
 * interactiveElements.js / textExtractor.js / piiDetector.js) looks only at
 * what is inside the viewport, because that is what the screenshot shows
 * and what the agent can act on right now. That is the right scope for
 * redaction and for what may be sent to a cloud reasoner, but it made the
 * agent answer "what is this form about?" from one screen only, and it hid
 * sensitive data further down the page from the Privacy Proof tab.
 *
 * This reads the DOM of the WHOLE page (above and below the fold), runs
 * the exact same detectors (piiDetector.scanPlainText, i.e. the same
 * checksum-validated patterns plus the on-device NER model), and returns a
 * summary that NEVER contains a raw sensitive value:
 *   - text lines, with any line containing PII replaced by a marker;
 *   - form fields: label, type, filled or not (never the value);
 *   - buttons/actions: label only;
 *   - sensitive items: type + masked form + where on the page it sits.
 *
 * It is READ-ONLY: it does not touch root.__BA_state (the element registry
 * the agent uses to act), does not scroll, and does not capture pixels.
 * Faces and ID-document images need pixels, so they are still only detected
 * on the visible screen (or by the "Capture full page" feature in the
 * popup, which scrolls and captures screen by screen).
 *
 * Nothing here leaves the device. The popup uses the result locally (page
 * questions in Fully Local mode, the Privacy Proof tab's whole-page list).
 */
(function (root) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT', 'CANVAS']);
  const MAX_TEXT_NODES = 1500;   // pathological-page guard
  const MAX_LINES = 400;         // lines kept in the summary
  const MAX_SHADOW_DEPTH = 8;
  const REDACTED_LINE = '[REDACTED - sensitive text on this line]';

  function isRendered(el) {
    if (!el) return false;
    const vis = root.__BA_Visibility;
    if (vis && typeof vis.isStyleVisible === 'function' && !vis.isStyleVisible(el)) return false;
    return el.getClientRects().length > 0;
  }

  /** 'on screen' | 'below the fold' | 'above the fold' for a rect. */
  function positionOf(rect) {
    if (!rect) return 'unknown';
    if (rect.bottom <= 0) return 'above the fold';
    if (rect.top >= window.innerHeight) return 'below the fold';
    return 'on screen';
  }

  function collectTextNodes(start, out, depth) {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (out.length >= MAX_TEXT_NODES) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) continue;
        if (!node.textContent || !node.textContent.trim()) continue;
        out.push(node);
      } else if (node.shadowRoot && depth < MAX_SHADOW_DEPTH) {
        collectTextNodes(node.shadowRoot, out, depth + 1);
      }
    }
  }

  function rectOfTextNode(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }

  function clean(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max || 300);
  }

  function labelForField(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 80);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy.split(/\s+/).map((id) => {
        const ref = document.getElementById(id);
        return ref ? ref.textContent : '';
      }).join(' ');
      if (txt.trim()) return clean(txt, 80);
    }
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && lab.textContent.trim()) return clean(lab.textContent, 80);
      } catch (_) { /* ignore */ }
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.textContent.trim()) return clean(wrapping.textContent, 80);
    if (el.placeholder) return clean(el.placeholder, 80);
    if (el.name) return clean(el.name.replace(/[_-]+/g, ' '), 80);
    return '';
  }

  function fieldValue(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : '';
    if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      const v = opt ? (opt.textContent || opt.value || '') : '';
      return /^\s*(--|select|choose)/i.test(v) ? '' : v;
    }
    return el.value || '';
  }

  async function scan() {
    const pii = root.__BA_PiiDetector;
    if (!pii || typeof pii.scanPlainText !== 'function') {
      throw new Error('piiDetector.js is not loaded in this page.');
    }

    // ── Text ──────────────────────────────────────────────────────────
    const nodes = [];
    if (document.body) collectTextNodes(document.body, nodes, 0);

    const entries = [];
    let lastText = null;
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!isRendered(parent)) continue;
      const text = clean(node.textContent, 1000);
      if (!text || text === lastText) continue;
      lastText = text;
      const heading = parent.closest('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
      entries.push({ text, rect: rectOfTextNode(node), heading: !!heading });
      if (entries.length >= MAX_LINES) break;
    }

    const textResults = await Promise.all(entries.map((e) => pii.scanPlainText(e.text).catch(() => [])));

    const sensitiveItems = [];
    const lines = [];
    entries.forEach((e, i) => {
      const found = textResults[i] || [];
      const where = positionOf(e.rect);
      for (const it of found) {
        sensitiveItems.push({ type: it.type, masked: it.masked, confidence: it.confidence, where, source: 'text' });
      }
      lines.push({
        text: found.length ? REDACTED_LINE : e.text.slice(0, 300),
        heading: e.heading,
        where,
      });
    });

    // ── Form fields (values are scanned, never returned) ──────────────
    const fields = [];
    const fieldEls = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((el) => {
        const type = (el.getAttribute('type') || '').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type) && isRendered(el);
      })
      .slice(0, 200);
    const valueScans = await Promise.all(fieldEls.map((el) => {
      const v = fieldValue(el);
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (!v || v === 'checked' || type === 'password') return Promise.resolve([]);
      return pii.scanPlainText(v, labelForField(el)).catch(() => []);
    }));
    fieldEls.forEach((el, i) => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      const where = positionOf(el.getBoundingClientRect());
      const value = fieldValue(el);
      const found = valueScans[i] || [];
      for (const it of found) {
        sensitiveItems.push({ type: it.type, masked: it.masked, confidence: it.confidence, where, source: 'field' });
      }
      fields.push({
        label: labelForField(el),
        type,
        filled: !!value,
        sensitive: found.length > 0 || type === 'password',
        where,
      });
    });

    // ── Buttons / actions (labels only) ───────────────────────────────
    const buttons = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
      if (!isRendered(el)) continue;
      const label = clean(el.getAttribute('aria-label') || el.textContent || el.value || el.title || '', 60);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      buttons.push({ label, where: positionOf(el.getBoundingClientRect()) });
      if (buttons.length >= 40) break;
    }

    // ── Page facts ────────────────────────────────────────────────────
    let title = clean(document.title, 120);
    if (title) {
      const titleHits = await pii.scanPlainText(title).catch(() => []);
      if (titleHits.length) title = '[REDACTED title]';
    }
    const scrollHeight = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );

    return {
      url: location.href,
      title,
      viewportHeight: window.innerHeight,
      scrollHeight,
      screens: Math.max(1, Math.ceil(scrollHeight / Math.max(1, window.innerHeight))),
      lines,
      fields,
      buttons,
      sensitiveItems,
      truncated: nodes.length >= MAX_TEXT_NODES || entries.length >= MAX_LINES,
      scannedAt: Date.now(),
    };
  }

  /* ── Local form navigation ─────────────────────────────────────────
   * Used by the agent when the visible screen has no empty fields left but
   * the form continues further down (or up) the page. Finds the next empty
   * fillable field that is OFF screen (or, for kind 'submit', the submit
   * control) and scrolls it into view. Deterministic, no model, no network.
   * Returns only a key and a label, never a value.
   *
   * Checkboxes/radios are not treated as "empty fields" (consent boxes and
   * optional choices must stay the user's decision). skipKeys lets the
   * agent visit each off-screen field at most once per task, so a field the
   * user chose to leave empty can't cause an endless scroll loop.
   */
  const NON_TEXT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);

  function fieldKey(el, index) {
    if (el.id) return '#' + el.id;
    if (el.name) return `[name="${el.name}"]`;
    return `field-${index}`;
  }

  /** Fully inside the viewport. A field that is only partly visible (cut
   *  off at the bottom edge) is treated as off screen, because the per-step
   *  scan may not count it as visible either, and then neither side would
   *  deal with it — the agent would think the form was finished. */
  function isInView(rect) {
    return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
  }

  function formTargets(opts) {
    const kind = (opts && opts.kind) || 'empty-field';
    const skip = new Set((opts && opts.skipKeys) || []);
    const doScroll = !(opts && opts.scroll === false);
    // includeInView: also report empty fields that ARE on screen. Used for
    // "is the whole form done?" checks, which must not depend on whether
    // the per-step scan happened to see a field (it can miss one that is
    // mid-scroll or partly covered).
    const includeInView = !!(opts && opts.includeInView);

    if (kind === 'empty-field') {
      const offscreen = [];
      Array.from(document.querySelectorAll('input, textarea, select')).forEach((el, i) => {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (NON_TEXT_TYPES.has(type) || el.disabled || el.readOnly || !isRendered(el)) return;
        if (fieldValue(el)) return; // already filled
        const key = fieldKey(el, i);
        if (skip.has(key) || (!includeInView && isInView(el.getBoundingClientRect()))) return;
        offscreen.push({ el, key });
      });
      if (offscreen.length === 0) return { found: false, scrolled: false, remaining: 0, scrollY: window.scrollY };
      const target = offscreen[0];
      if (doScroll) target.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return {
        found: true, scrolled: doScroll, key: target.key,
        label: labelForField(target.el) || target.key, remaining: offscreen.length, scrollY: window.scrollY,
      };
    }

    if (kind === 'submit') {
      const SUBMIT_RE = /\b(submit|pay|apply|continue|next|finish|finali[sz]e|register|sign ?up|confirm|place order|send)\b/i;
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
      for (let i = 0; i < buttons.length; i++) {
        const el = buttons[i];
        if (!isRendered(el) || el.disabled) continue;
        const label = clean(el.getAttribute('aria-label') || el.textContent || el.value || '', 60);
        const isSubmit = (el.getAttribute('type') || '').toLowerCase() === 'submit' || SUBMIT_RE.test(label);
        if (!isSubmit) continue;
        const key = el.id ? '#' + el.id : `submit-${i}`;
        if (skip.has(key) || isInView(el.getBoundingClientRect())) continue;
        if (doScroll) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        return { found: true, scrolled: doScroll, key, label: label || 'submit', remaining: 1, scrollY: window.scrollY };
      }
      return { found: false, scrolled: false, remaining: 0, scrollY: window.scrollY };
    }
    return { found: false, scrolled: false, remaining: 0, scrollY: window.scrollY };
  }

  root.__BA_FullPageScanner = { scan, formTargets };
})(window);
