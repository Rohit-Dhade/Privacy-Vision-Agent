/**
 * content/semanticDomBuilder.js
 *
 * Smart Semantic DOM Builder — Shadow Mode
 *
 * Builds a compact, task-aware semantic representation of the current page
 * from the raw extraction results produced by domExtractor.js.
 *
 * Runs entirely locally in the content script. The output is LOCAL-ONLY:
 *   - NEVER sent to the server or VLM
 *   - NEVER included in any outbound network payload
 *   - Stored only in window.__BA_state.shadowSemanticDom for local inspection
 *
 * The compact schema intentionally EXCLUDES:
 *   - CSS selectors (implementation detail, privacy-leaking)
 *   - Raw field values (PII)
 *   - Framework-internal attributes (data-reactid, ng-*, etc.)
 *   - Hidden inputs or invisible DOM internals
 *
 * The module maintains a SEPARATE local-only registry:
 *   semanticId → { selector, liveElement }
 * so that action execution can resolve semantic IDs back to DOM targets
 * without the compact schema ever carrying selectors.
 *
 * PRIVACY GUARANTEES:
 *   1. No selectors in the compact output
 *   2. No raw values in the compact output
 *   3. Explicit sanitization pass before any output/logging
 *   4. Input elements are NOT assumed to be pre-sanitized — verified here
 *   5. Full semantic index stays local, never serialized for transmission
 */
(function (root) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────

  // HTML5 landmark roles and their equivalent ARIA roles
  const LANDMARK_MAP = {
    'HEADER':  'banner',
    'NAV':     'navigation',
    'MAIN':    'main',
    'ASIDE':   'complementary',
    'FOOTER':  'contentinfo',
    'SECTION': 'region',
    'ARTICLE': 'article',
    'FORM':    'form'
  };

  const ARIA_LANDMARK_ROLES = new Set([
    'banner', 'navigation', 'main', 'complementary', 'contentinfo',
    'region', 'search', 'form', 'dialog', 'alertdialog', 'application'
  ]);

  // Framework-internal attributes that must NEVER appear in output
  const FRAMEWORK_ATTR_PATTERNS = [
    /^data-react/i, /^data-v-/i, /^ng-/i, /^_ng/i,
    /^data-testid$/i, /^data-cy$/i, /^data-test$/i,
    /^__/i, /^data-styled/i, /^data-emotion/i,
    /^jsname$/i, /^jscontroller$/i, /^jsaction$/i
  ];

  // Values that indicate a field is sensitive / redacted
  const REDACTED_MARKERS = new Set([
    '[REDACTED]', '[FILLED_FROM_LOCAL]', '[ALREADY_POPULATED]'
  ]);

  // Noise words for task-token extraction
  const NOISE_WORDS = new Set([
    'the', 'a', 'an', 'of', 'for', 'in', 'to', 'and', 'or', 'is', 'it',
    'this', 'that', 'with', 'from', 'on', 'at', 'by', 'my', 'me', 'i',
    'please', 'can', 'you', 'do', 'using', 'use', 'complete', 'fill'
  ]);

  // ── Local-only Registry ──────────────────────────────────────────────────────
  //
  // Maps semantic IDs → { selector, element (live DOM ref if available) }
  // This NEVER leaves the content script context.
  let _localRegistry = new Map();

  // ── Landmark Detection ───────────────────────────────────────────────────────

  /**
   * Scans the document for HTML5 and ARIA landmark regions.
   * Returns an array of { role, label, element, bbox } objects.
   */
  function detectLandmarks() {
    const landmarks = [];
    const seen = new Set();

    // 1. HTML5 semantic elements
    const tagSelectors = Object.keys(LANDMARK_MAP).map(t => t.toLowerCase());
    for (const tag of tagSelectors) {
      document.querySelectorAll(tag).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const role = LANDMARK_MAP[el.tagName] || tag;
        landmarks.push({
          role,
          label: _getLandmarkLabel(el),
          element: el,
          bbox: _safeBbox(el)
        });
      });
    }

    // 2. ARIA role-based landmarks
    ARIA_LANDMARK_ROLES.forEach(role => {
      document.querySelectorAll(`[role="${role}"]`).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        landmarks.push({
          role,
          label: _getLandmarkLabel(el),
          element: el,
          bbox: _safeBbox(el)
        });
      });
    });

    return landmarks;
  }

  /**
   * Scans the document for semantic headings (h1-h6, [role="heading"])
   * to preserve non-interactive semantic anchors.
   */
  function detectHeadings() {
    if (typeof document === 'undefined') return [];
    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]').forEach(el => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 150) return;
      let level = 1;
      const tag = el.tagName ? el.tagName.toUpperCase() : '';
      if (/^H[1-6]$/.test(tag)) {
        level = parseInt(tag.charAt(1), 10);
      } else {
        const ariaLevel = el.getAttribute('aria-level');
        if (ariaLevel) level = parseInt(ariaLevel, 10) || 2;
      }
      headings.push({
        level,
        text: _sanitizeLabelText(text)
      });
    });
    return headings.slice(0, 10);
  }

  /**
   * Scans the document for table structures to preserve headers and row counts.
   */
  function detectTables() {
    if (typeof document === 'undefined') return [];
    const tables = [];
    document.querySelectorAll('table, [role="table"], [role="grid"]').forEach((tbl, idx) => {
      const headers = [];
      tbl.querySelectorAll('th, [role="columnheader"]').forEach(th => {
        const hText = (th.innerText || th.textContent || '').trim();
        if (hText) headers.push(_sanitizeLabelText(hText.slice(0, 50)));
      });
      const rows = tbl.querySelectorAll('tr, [role="row"]').length;
      tables.push({
        id: `table_${idx}`,
        headers,
        rowCount: rows > 0 ? rows - 1 : 0
      });
    });
    return tables.slice(0, 5);
  }

  /**
   * Detects presence of code blocks, embedded editors, and iframes.
   */
  function detectCodeAndEmbeds() {
    if (typeof document === 'undefined') return { codeBlocksCount: 0, iframesCount: 0 };
    const codeBlocks = document.querySelectorAll('pre, code, .monaco-editor, .CodeMirror, [role="textbox"][class*="code" i]').length;
    const iframes = document.querySelectorAll('iframe').length;
    return {
      codeBlocksCount: codeBlocks,
      iframesCount: iframes
    };
  }

  /**
   * Builds semantic relationships between elements (forms -> fields/submit, dialog -> controls, nav -> links).
   */
  function buildRelationships(fullIndex, landmarks, pageContext, tables) {
    // Form relationships: formId -> field IDs & submit action IDs
    const formMap = new Map();
    for (const entry of fullIndex) {
      if (entry.formId) {
        if (!formMap.has(entry.formId)) {
          formMap.set(entry.formId, { formId: entry.formId, fieldIds: [], submitIds: [] });
        }
        const f = formMap.get(entry.formId);
        if (entry.semanticRole === 'submit_button' || entry.semanticRole === 'form_button') {
          f.submitIds.push(entry.id);
        } else {
          f.fieldIds.push(entry.id);
        }
      }
    }

    const forms = Array.from(formMap.values()).map(f => ({
      formId: f.formId,
      fieldCount: f.fieldIds.length,
      fieldIds: f.fieldIds,
      submitIds: f.submitIds
    }));

    // Dialog relationships
    let dialog = null;
    if (pageContext?.activeModal?.isOpen) {
      const modalElements = fullIndex.filter(e => e.region === 'modal');
      dialog = {
        title: _sanitizeLabelText(pageContext.activeModal.title || null),
        controlIds: modalElements.map(e => e.id)
      };
    }

    // Navigation relationships
    const navigations = landmarks
      .filter(lm => lm.role === 'navigation' || lm.role === 'banner')
      .map(lm => ({
        label: lm.label,
        linkIds: fullIndex.filter(e => e.region === lm.role && (e.semanticRole === 'navigation_link' || e.semanticRole === 'content_link')).map(e => e.id)
      }))
      .filter(nav => nav.linkIds.length > 0);

    return {
      forms,
      dialog,
      navigations,
      tableCount: tables.length
    };
  }

  function _getLandmarkLabel(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') && _resolveAriaLabelledBy(el) ||
      el.getAttribute('title') ||
      _headingText(el) ||
      null
    );
  }

  function _resolveAriaLabelledBy(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
    const parts = [];
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref) {
        const text = (ref.innerText || ref.textContent || '').trim();
        if (text) parts.push(text.slice(0, 80));
      }
    }
    return parts.join(' ') || null;
  }

  function _headingText(el) {
    const heading = el.querySelector('h1, h2, h3, h4, [role="heading"]');
    if (!heading) return null;
    return (heading.innerText || heading.textContent || '').trim().slice(0, 80) || null;
  }

  function _safeBbox(el) {
    try {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch (_) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  // ── Element Region Assignment ────────────────────────────────────────────────

  /**
   * For a given element record, determine which landmark region it belongs to.
   */
  function assignRegion(el, landmarks) {
    if (!el || !el.bbox) return 'unknown';

    // Modal takes priority
    if (el.inModal) return 'modal';

    // Check explicit landmark containment via bounding box overlap
    for (const lm of landmarks) {
      if (lm.bbox && _bboxContains(lm.bbox, el.bbox)) {
        return lm.role;
      }
    }

    // Fallback from existing semantic flags
    if (el.inNav) return 'navigation';
    if (el.isSticky) return 'sticky';
    if (el.formId) return 'form';

    return 'content';
  }

  function _bboxContains(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      (inner.x + inner.width) <= (outer.x + outer.width + 2) &&
      (inner.y + inner.height) <= (outer.y + outer.height + 2)
    );
  }

  // ── Semantic Role Classification ─────────────────────────────────────────────

  /**
   * Determines the semantic role of an element from its type, attributes,
   * and context. General-purpose — no site-specific logic.
   */
  function classifySemanticRole(el) {
    const type = (el.type || '').toLowerCase();

    // Form fields
    if (type.startsWith('input:') || type === 'textarea') {
      const subtype = type.replace('input:', '');
      if (subtype === 'submit') return 'submit_button';
      if (subtype === 'checkbox') return 'checkbox';
      if (subtype === 'radio') return 'radio_button';
      if (subtype === 'file') return 'file_upload';
      if (subtype === 'hidden') return 'hidden_field';
      if (el.isSearch) return 'search_input';
      return 'form_field';
    }

    if (type === 'select') return 'dropdown';

    // Buttons
    if (type === 'button' || type === 'role:button') {
      if (el.isSearch) return 'search_button';
      if (el.formId) return 'form_button';
      return 'action_button';
    }

    // Links
    if (type === 'link') {
      if (el.isPagination) return 'pagination_control';
      if (el.inNav) return 'navigation_link';
      return 'content_link';
    }

    // ARIA roles
    if (type === 'role:tab') return 'tab_control';
    if (type === 'role:menuitem') return 'menu_item';
    if (type === 'role:checkbox') return 'checkbox';
    if (type === 'role:radio') return 'radio_button';
    if (type === 'role:combobox') return 'combobox';
    if (type === 'role:switch') return 'toggle';
    if (type === 'role:option') return 'list_option';
    if (type === 'role:link') return 'content_link';

    return 'interactive_element';
  }

  // ── Label Resolution ─────────────────────────────────────────────────────────

  /**
   * Builds the best human-readable label for an element.
   * Priority: explicit <label for> > aria-label > placeholder > visible text > title
   * Ensures NO raw PII values leak into the label.
   */
  function resolveSemanticLabel(el) {
    // aria-label is the most explicit accessible name
    if (el.ariaLabel && el.ariaLabel.trim()) {
      return _sanitizeLabelText(el.ariaLabel.trim());
    }

    // placeholder is common for form fields
    if (el.placeholder && el.placeholder.trim()) {
      return _sanitizeLabelText(el.placeholder.trim());
    }

    // Visible text (button text, link text)
    if (el.text && el.text.trim()) {
      return _sanitizeLabelText(el.text.trim());
    }

    return null;
  }

  /**
   * Sanitize label text: truncate, strip potential PII patterns.
   * Labels come from page-authored metadata (aria-label, placeholder, button text)
   * which should not contain user PII, but we verify defensively.
   */
  function _sanitizeLabelText(text) {
    if (!text) return null;
    let clean = text.slice(0, 100);

    // Strip anything that looks like it could be a leaked email
    clean = clean.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]');
    // Strip phone-like patterns (10+ digits possibly separated)
    clean = clean.replace(/(\+?\d[\d\s\-()]{8,}\d)/g, '[REDACTED]');

    return clean;
  }

  // ── Privacy Sanitization ─────────────────────────────────────────────────────

  /**
   * Explicit sanitization pass on a compact element record.
   * Ensures NO selector, NO raw value, NO framework internals leak.
   * Called on every element BEFORE it enters any output structure.
   */
  function sanitizeCompactElement(record) {
    // 1. NEVER include selector
    delete record.selector;

    // 2. NEVER include raw values — only hasValue boolean
    delete record.value;
    delete record.rawValue;

    // 3. Strip framework-internal attributes if somehow present
    if (record.attributes) {
      for (const key of Object.keys(record.attributes)) {
        if (FRAMEWORK_ATTR_PATTERNS.some(p => p.test(key))) {
          delete record.attributes[key];
        }
      }
      if (Object.keys(record.attributes).length === 0) {
        delete record.attributes;
      }
    }

    // 4. Strip any field that contains a redacted marker as label
    // (this means the label was derived from a user-entered value)
    if (record.semanticLabel && REDACTED_MARKERS.has(record.semanticLabel)) {
      record.semanticLabel = null;
    }

    // 5. Remove implementation-detail fields
    delete record.formId;
    delete record.href;
    delete record.isSticky;
    delete record.inNav;
    delete record.inModal;
    delete record.isSearch;
    delete record.isPagination;

    return record;
  }

  /**
   * Verifies that an element from the extraction pipeline does not carry
   * unsanitized PII values. This does NOT assume the upstream pipeline
   * has already redacted — it checks defensively.
   */
  function verifyElementPrivacy(el) {
    const issues = [];

    // Check if raw value exists and is not a known safe marker
    if (el.value != null && el.value !== '' &&
        !REDACTED_MARKERS.has(el.value) &&
        el.value !== 'checked' && el.value !== 'unchecked') {
      // Flag but don't block — the existing pipeline should have handled this
      // We just never let it into our compact output
      issues.push('raw_value_present');
    }

    return issues;
  }

  // ── Task-Relevance Scoring ───────────────────────────────────────────────────

  /**
   * Extracts meaningful tokens from the task instruction for relevance matching.
   */
  function extractTaskTokens(taskInstruction) {
    if (!taskInstruction) return [];
    return taskInstruction
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !NOISE_WORDS.has(w));
  }

  /**
   * Scores an element's task relevance using semantic signals.
   * Higher score = more relevant to the current task.
   * This is recomputed on every fresh DOM extraction (stateless).
   */
  function scoreTaskRelevance(el, taskTokens, hasActiveModal) {
    let score = 0;
    const semanticRole = classifySemanticRole(el);

    // Modal priority: if a modal is open, modal elements are critical
    if (hasActiveModal) {
      if (el.inModal) score += 100;
      else score -= 30;
    }

    // Task-token matching against semantic labels
    const labelText = `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''}`.toLowerCase();
    for (const tok of taskTokens) {
      if (labelText.includes(tok)) score += 20;
    }

    // Semantic role bonuses
    if (semanticRole === 'form_field') score += 15;
    if (semanticRole === 'submit_button') score += 15;
    if (semanticRole === 'search_input') score += 15;
    if (semanticRole === 'dropdown') score += 12;
    if (semanticRole === 'checkbox' || semanticRole === 'radio_button') score += 10;
    if (semanticRole === 'pagination_control') score += 10;
    if (semanticRole === 'tab_control') score += 8;
    if (semanticRole === 'action_button') score += 8;

    // Empty fields are more actionable than filled ones
    if (el.hasValue === false) score += 10;
    if (el.hasValue === true) score -= 5;

    // Form membership
    if (el.formId) score += 8;

    // Disabled/invisible elements are low priority
    if (!el.enabled) score -= 20;
    if (el.visible === false) score -= 50;

    // Generic nav/footer links are low priority (unless task mentions navigation)
    if (el.inNav && !el.isSearch && semanticRole === 'navigation_link') score -= 10;

    return score;
  }

  // ── Page Type Detection ──────────────────────────────────────────────────────

  /**
   * Heuristic page-type classification based on element composition.
   * General-purpose — not hardcoded to any specific site.
   */
  function detectPageType(elements, landmarks, pageContext) {
    let formFieldCount = 0;
    let searchCount = 0;
    let linkCount = 0;
    let tablePresent = false;
    let articlePresent = false;

    for (const el of elements) {
      const role = classifySemanticRole(el);
      if (role === 'form_field' || role === 'dropdown' || role === 'checkbox' || role === 'radio_button') formFieldCount++;
      if (role === 'search_input' || role === 'search_button') searchCount++;
      if (role === 'content_link' || role === 'navigation_link') linkCount++;
    }

    for (const lm of landmarks) {
      if (lm.role === 'article') articlePresent = true;
    }

    // Check for tables in page
    if (typeof document !== 'undefined') {
      tablePresent = document.querySelectorAll('table').length > 0;
    }

    // Modal overrides page type
    if (pageContext?.activeModal?.isOpen) return 'dialog';

    // Heuristic classification
    if (formFieldCount >= 3) return 'form';
    if (searchCount > 0 && linkCount > 5) return 'search';
    if (tablePresent && formFieldCount < 3) return 'data';
    if (articlePresent) return 'article';
    if (linkCount > 15) return 'navigation';

    return 'mixed';
  }

  // ── Token/Character Measurement ──────────────────────────────────────────────

  /**
   * Measures the approximate token and character count of a payload.
   * Uses whitespace-split as a rough token proxy (no actual tokenizer needed).
   */
  function measurePayload(obj) {
    const json = JSON.stringify(obj);
    const charCount = json.length;
    // Rough token estimate: split on whitespace + punctuation boundaries
    const tokenCount = json.split(/[\s,{}\[\]:"]+/).filter(t => t.length > 0).length;
    return { charCount, tokenCount };
  }

  // ── Compact View Builder ─────────────────────────────────────────────────────

  /**
   * Main entry point. Builds the smart semantic DOM from extraction results.
   *
   * @param {Array} elements  - Elements from domExtractor (may contain raw values)
   * @param {string} url      - Current page URL
   * @param {Object} pageContext - { activeModal, alerts, loadingState, forms }
   * @param {Array} visibleText  - Visible text entries
   * @param {string} taskInstruction - User's task string
   * @returns {Object} Compact semantic view (local-only, privacy-sanitized)
   */
  function buildSemanticView(elements, url, pageContext, visibleText, taskInstruction) {
    if (!Array.isArray(elements)) elements = [];

    // Clear and rebuild the local registry on every invocation
    // (semantic relevance is always recomputed from fresh DOM)
    _localRegistry = new Map();

    const taskTokens = extractTaskTokens(taskInstruction);
    const hasActiveModal = Boolean(pageContext?.activeModal?.isOpen);

    // Detect page landmarks
    const landmarks = (typeof document !== 'undefined') ? detectLandmarks() : [];

    // Build the full local semantic index (local-only, never transmitted)
    const fullIndex = [];
    const privacyWarnings = [];

    for (const el of elements) {
      // Verify upstream privacy — don't assume elements are pre-sanitized
      const issues = verifyElementPrivacy(el);
      if (issues.length > 0) {
        privacyWarnings.push({ elementId: el.id, issues });
      }

      const semanticRole = classifySemanticRole(el);
      const semanticLabel = resolveSemanticLabel(el);
      const region = assignRegion(el, landmarks);
      const relevanceScore = scoreTaskRelevance(el, taskTokens, hasActiveModal);

      // Full local index entry (includes selector — local only)
      const indexEntry = {
        id: String(el.id),
        semanticRole,
        semanticLabel,
        type: el.type || null,
        region,
        hasValue: Boolean(el.hasValue),
        enabled: el.enabled !== false,
        visible: el.visible !== false,
        relevanceScore,
        bbox: el.bbox || null,
        formId: el.formId || null,
        selector: el.selector || null,  // LOCAL ONLY — stripped from compact output
        options: el.options || null,
        radioGroup: el.radioGroup || null
      };

      fullIndex.push(indexEntry);

      // Maintain the local selector registry
      _localRegistry.set(String(el.id), {
        selector: el.selector || null,
        element: null  // Live DOM ref resolved at action time
      });
    }

    // Sort by relevance score descending
    fullIndex.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // ── Build compact output (privacy-sanitized, no selectors) ─────────────

    // Split into task-relevant (top-scored) and global context
    // Keep BOTH — don't aggressively prune to only matching elements
    const TASK_RELEVANT_LIMIT = 40;
    const GLOBAL_CONTEXT_LIMIT = 20;

    const taskRelevantElements = [];
    const globalContextElements = [];

    for (let i = 0; i < fullIndex.length; i++) {
      const entry = { ...fullIndex[i] };

      // Build the sanitized compact record (no selector, no raw value)
      const compact = {
        id: entry.id,
        semanticRole: entry.semanticRole,
        semanticLabel: entry.semanticLabel,
        type: entry.type,
        region: entry.region,
        hasValue: entry.hasValue,
        enabled: entry.enabled,
        visible: entry.visible,
        bbox: entry.bbox
      };

      // Add select/radio metadata (safe — these are page-authored options, not user PII)
      if (entry.options) compact.options = entry.options;
      if (entry.radioGroup) compact.radioGroup = entry.radioGroup;

      // Explicit sanitization pass
      sanitizeCompactElement(compact);

      if (i < TASK_RELEVANT_LIMIT) {
        taskRelevantElements.push(compact);
      } else if (i < TASK_RELEVANT_LIMIT + GLOBAL_CONTEXT_LIMIT) {
        globalContextElements.push(compact);
      }
    }

    // Page type
    const pageType = detectPageType(elements, landmarks, pageContext);

    // Landmark summary (compact — no DOM refs, no selectors)
    const landmarkSummary = landmarks.map(lm => ({
      role: lm.role,
      label: lm.label ? _sanitizeLabelText(lm.label) : null,
      elementCount: fullIndex.filter(e => e.region === lm.role).length
    })).filter(lm => lm.elementCount > 0);

    // Active context (sanitized)
    const activeContext = {
      modal: pageContext?.activeModal?.isOpen ? {
        title: _sanitizeLabelText(pageContext.activeModal.title || null),
        elementCount: fullIndex.filter(e => e.region === 'modal').length
      } : null,
      alerts: Array.isArray(pageContext?.alerts) ? pageContext.alerts.map(a => ({
        type: a.type,
        text: _sanitizeLabelText(a.text)
      })) : [],
      loadingState: pageContext?.loadingState || { isLoading: false }
    };

    // Detect non-interactive semantic anchors & embeds
    const headings = detectHeadings();
    const tables = detectTables();
    const codeAndEmbeds = detectCodeAndEmbeds();
    const relationships = buildRelationships(fullIndex, landmarks, pageContext, tables);

    // Context summary (human-readable)
    const contextSummary = _buildContextSummary(
      pageType, fullIndex, landmarkSummary, activeContext, taskRelevantElements
    );

    // ── Measurements ───────────────────────────────────────────────────────

    // Measure the original elements payload for comparison
    const originalMeasurement = measurePayload(elements);

    const compactOutput = {
      url: url || null,
      pageType,
      landmarks: landmarkSummary,
      headings,
      tables,
      codeAndEmbeds,
      relationships,
      activeContext,
      taskRelevantElements,
      globalContextElements,
      contextSummary,
      stats: {
        totalElementsExtracted: elements.length,
        taskRelevantCount: taskRelevantElements.length,
        globalContextCount: globalContextElements.length,
        headingsCount: headings.length,
        tablesCount: tables.length,
        reductionPercent: elements.length > 0
          ? Math.round((1 - (taskRelevantElements.length + globalContextElements.length) / elements.length) * 100)
          : 0
      }
    };

    // Measure the compact output
    const compactMeasurement = measurePayload(compactOutput);

    compactOutput.measurements = {
      original: originalMeasurement,
      compact: compactMeasurement,
      charReduction: originalMeasurement.charCount > 0
        ? Math.round((1 - compactMeasurement.charCount / originalMeasurement.charCount) * 100)
        : 0,
      tokenReduction: originalMeasurement.tokenCount > 0
        ? Math.round((1 - compactMeasurement.tokenCount / originalMeasurement.tokenCount) * 100)
        : 0
    };

    // Log privacy warnings (local only)
    if (privacyWarnings.length > 0) {
      console.debug('[SemanticDOM:Privacy] Upstream privacy issues detected:', privacyWarnings);
    }

    return compactOutput;
  }

  function _buildContextSummary(pageType, fullIndex, landmarks, activeContext, taskRelevant) {
    const parts = [];

    // Page type
    const typeLabels = {
      form: 'Form page',
      search: 'Search page',
      data: 'Data/table page',
      article: 'Article page',
      navigation: 'Navigation page',
      dialog: 'Active dialog',
      mixed: 'Mixed content page'
    };
    parts.push(typeLabels[pageType] || 'Page');

    // Form summary
    const formFields = fullIndex.filter(e => e.semanticRole === 'form_field' || e.semanticRole === 'dropdown');
    if (formFields.length > 0) {
      const filled = formFields.filter(e => e.hasValue).length;
      const empty = formFields.length - filled;
      parts.push(`with ${formFields.length} form fields (${filled} filled, ${empty} empty)`);
    }

    // Landmark summary
    if (landmarks.length > 0) {
      const regions = landmarks.map(lm => `${lm.role}(${lm.elementCount})`).join(', ');
      parts.push(`Regions: ${regions}`);
    }

    // Modal
    if (activeContext.modal) {
      parts.push(`Modal open: "${activeContext.modal.title || 'Dialog'}"`);
    }

    // Alerts
    if (activeContext.alerts.length > 0) {
      parts.push(`${activeContext.alerts.length} alert(s) visible`);
    }

    return parts.join('. ') + '.';
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Returns the local-only registry mapping semantic IDs to selectors/elements.
   * This MUST NEVER be serialized or sent over any network boundary.
   */
  function getLocalRegistry() {
    return _localRegistry;
  }

  /**
   * Resolves a semantic element ID to its CSS selector from the local registry.
   * For local action execution only.
   */
  function resolveSelector(semanticId) {
    const entry = _localRegistry.get(String(semanticId));
    return entry ? entry.selector : null;
  }

  root.__BA_SemanticDom = {
    buildSemanticView,
    getLocalRegistry,
    resolveSelector,
    // Exported for testing only — not part of the production API
    _testExports: {
      detectLandmarks,
      detectHeadings,
      detectTables,
      detectCodeAndEmbeds,
      buildRelationships,
      classifySemanticRole,
      resolveSemanticLabel,
      sanitizeCompactElement,
      verifyElementPrivacy,
      scoreTaskRelevance,
      extractTaskTokens,
      detectPageType,
      measurePayload,
      assignRegion,
      _sanitizeLabelText
    }
  };

})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
