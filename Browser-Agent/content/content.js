/**
 * content/content.js
 * Entry point injected into the page. Exposes window.__BA API.
 */
(function (window) {
  if (window.__BA_state) return;

  window.__BA_state = {
    registry: new Map(),
    lastResult: null,
    observer: null,
    debounceTimer: null,
    guideCleanup: null
  };

  function resolveElement(id) {
    const cached = window.__BA_state.registry.get(id);
    if (cached && document.contains(cached)) return cached;
    const meta = window.__BA_state.lastResult &&
      window.__BA_state.lastResult.elements.find((e) => e.id === id);
    if (meta && meta.selector) return window.__BA_Selectors.resolveSelector(meta.selector);
    return null;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function dispatchNativeInput(el, text) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Inject all guide CSS once ──────────────────────────────────────────────
  function ensureGuideStyles() {
    if (document.getElementById('pv-guide-styles')) return;
    const s = document.createElement('style');
    s.id = 'pv-guide-styles';
    s.textContent = `
      /* Pulsing ring around the target input */
      @keyframes pvRingPulse {
        0%   { box-shadow: 0 0 0 0   rgba(0,85,184,.55), 0 0 0 0   rgba(0,85,184,.25); }
        60%  { box-shadow: 0 0 0 6px rgba(0,85,184,.25), 0 0 0 14px rgba(0,85,184,0);  }
        100% { box-shadow: 0 0 0 0   rgba(0,85,184,.55), 0 0 0 0   rgba(0,85,184,.25); }
      }
      .pv-field-active {
        outline: 2.5px solid #0055b8 !important;
        outline-offset: 2px !important;
        animation: pvRingPulse 1.8s ease-in-out infinite !important;
        transition: outline .15s ease !important;
        position: relative !important;
        z-index: 100 !important;
      }

      /* Callout card */
      #pv-guide-card {
        position: absolute;
        z-index: 2147483640;
        width: 300px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.10);
        border: 1.5px solid #dce7fb;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        overflow: visible;
        pointer-events: auto;
        transform-origin: top left;
      }
      #pv-guide-card.pv-card-enter {
        animation: pvCardIn .35s cubic-bezier(.22,.9,.36,1) forwards;
      }
      #pv-guide-card.pv-card-exit {
        animation: pvCardOut .25s ease-in forwards;
      }
      @keyframes pvCardIn {
        from { opacity:0; transform: scale(.92) translateY(8px); }
        to   { opacity:1; transform: scale(1)  translateY(0);    }
      }
      @keyframes pvCardOut {
        from { opacity:1; transform: scale(1)  translateY(0);    }
        to   { opacity:0; transform: scale(.92) translateY(8px); }
      }

      /* Card inner sections */
      .pv-card-header {
        background: linear-gradient(135deg, #0055b8, #1a73e8);
        border-radius: 10px 10px 0 0;
        padding: 11px 14px 10px;
        display: flex; align-items: center; gap: 8px;
      }
      .pv-card-header-icon {
        font-size: 18px; color: #fff; flex-shrink: 0;
      }
      .pv-card-header-title {
        font-size: 13px; font-weight: 700; color: #fff; line-height: 1.25;
      }
      .pv-card-header-sub {
        font-size: 10.5px; color: rgba(255,255,255,.8); margin-top:1px;
      }
      .pv-card-body { padding: 12px 14px 10px; }
      .pv-card-desc {
        font-size: 12px; color: #3c4043; line-height: 1.5; margin-bottom: 8px;
      }
      .pv-card-example {
        background: #f1f3f4; border-radius: 6px;
        padding: 7px 10px; margin-bottom: 10px;
      }
      .pv-card-example-label {
        font-size: 10px; font-weight: 700; color: #5f6368;
        text-transform: uppercase; letter-spacing: .5px; margin-bottom:3px;
      }
      .pv-card-example-val {
        font-size: 11px; font-family: "Roboto Mono", "Courier New", monospace;
        color: #174ea6; word-break: break-all; line-height:1.4;
      }
      .pv-card-footer {
        border-top: 1px solid #e8eaed;
        padding: 8px 14px;
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
      }
      .pv-card-hint {
        font-size: 10.5px; color: #80868b; flex: 1;
      }
      .pv-card-done-btn {
        background: #0055b8; color: #fff;
        border: none; border-radius: 6px;
        padding: 5px 12px; font-size: 11.5px; font-weight: 600;
        cursor: pointer; flex-shrink: 0;
        transition: background .15s;
      }
      .pv-card-done-btn:hover { background: #1a73e8; }

      /* SVG connector line */
      #pv-guide-svg {
        position: absolute;
        z-index: 2147483639;
        pointer-events: none;
        overflow: visible;
        top: 0; left: 0;
      }
      #pv-guide-svg .pv-connector {
        stroke: #0055b8;
        stroke-width: 2;
        fill: none;
        stroke-dasharray: 6 4;
        animation: pvDash 1.2s linear infinite;
      }
      @keyframes pvDash {
        to { stroke-dashoffset: -20; }
      }

      /* Backdrop dim for target area */
      #pv-guide-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.18);
        z-index: 2147483630;
        pointer-events: none;
        animation: pvFadeIn .3s ease forwards;
      }
      #pv-guide-spotlight {
        position: absolute;
        border-radius: 6px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,.18);
        pointer-events: none;
        transition: all .35s cubic-bezier(.22,.9,.36,1);
      }
      @keyframes pvFadeIn {
        from { opacity:0; } to { opacity:1; }
      }

      /* Step progress dots */
      .pv-step-dots {
        display: flex; gap: 5px; align-items: center; padding: 0 14px 9px;
      }
      .pv-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #dadce0; transition: background .2s, transform .2s;
      }
      .pv-dot.active { background: #0055b8; transform: scale(1.3); }
    `;
    document.head.appendChild(s);
  }

  // ── Build a rich description for a field ──────────────────────────────────
  function buildFieldInfo(fieldName, expectedValue, inputType) {
    const name = (fieldName || '').toLowerCase();
    const sel  = (expectedValue || '').toLowerCase();

    if (name.includes('pan') || sel.includes('pan')) {
      return {
        icon: '🪪',
        title: 'PAN Card Number',
        subtitle: 'Permanent Account Number',
        desc: 'Enter your 10-character Permanent Account Number exactly as printed on your PAN card — no spaces.',
        example: 'ABCDE1234F',
        hint: 'Format: 5 letters · 4 digits · 1 letter'
      };
    }
    if (name.includes('aadhaar') || name.includes('aadhar')) {
      return {
        icon: '🪪',
        title: 'Aadhaar Number',
        subtitle: 'UIDAI 12-digit ID',
        desc: 'Enter your 12-digit Aadhaar number. You can find this on your Aadhaar card or e-Aadhaar PDF.',
        example: '1234 5678 9012',
        hint: 'Spaces are optional — enter digits only if unsure'
      };
    }
    if (name.includes('upi') || name.includes('vpa')) {
      return {
        icon: '💳',
        title: 'UPI PIN / VPA',
        subtitle: 'Unified Payments Interface',
        desc: 'Enter your UPI Virtual Payment Address or 4/6-digit UPI PIN as registered with your bank app.',
        example: 'yourname@upi',
        hint: 'PIN is never stored or transmitted'
      };
    }
    if (name.includes('email') || inputType === 'email') {
      return {
        icon: '✉️',
        title: 'Email Address',
        subtitle: 'Your registered email',
        desc: 'Enter the email address associated with your account. It should be in standard email format.',
        example: 'yourname@example.com',
        hint: 'Must contain @ and a valid domain'
      };
    }
    if (name.includes('phone') || name.includes('mobile') || inputType === 'tel') {
      return {
        icon: '📱',
        title: 'Mobile Number',
        subtitle: 'Registered phone number',
        desc: 'Enter your 10-digit mobile number without country code or spaces.',
        example: '9876543210',
        hint: 'Do not include +91 or leading zeros'
      };
    }
    if (name.includes('pass') || inputType === 'password') {
      return {
        icon: '🔒',
        title: 'Password',
        subtitle: 'Your account password',
        desc: 'Enter your account password. It will not be stored, logged, or sent to any server — it is typed directly into the page.',
        example: '(your secret password)',
        hint: 'Entered directly on the page, never captured'
      };
    }
    if (name.includes('dob') || name.includes('birth') || inputType === 'date') {
      return {
        icon: '📅',
        title: 'Date of Birth',
        subtitle: 'As on official documents',
        desc: 'Enter your date of birth in the format shown by the field — typically DD/MM/YYYY or YYYY-MM-DD.',
        example: '15/08/1995',
        hint: 'Use the date picker or type in the required format'
      };
    }
    if (name.includes('name')) {
      return {
        icon: '👤',
        title: 'Full Name',
        subtitle: 'As on official documents',
        desc: 'Enter your full legal name exactly as it appears on your government-issued ID or bank records.',
        example: 'Rohit Dhade',
        hint: 'Avoid nicknames or abbreviations'
      };
    }
    if (name.includes('ifsc')) {
      return {
        icon: '🏦',
        title: 'IFSC Code',
        subtitle: 'Bank branch identifier',
        desc: 'Enter the 11-character IFSC code of your bank branch. You can find it on your cheque book or bank passbook.',
        example: 'SBIN0001234',
        hint: 'Format: 4 letters · 0 · 6 digits/letters'
      };
    }
    if (name.includes('account') || name.includes('acc no')) {
      return {
        icon: '🏦',
        title: 'Account Number',
        subtitle: 'Bank account number',
        desc: 'Enter your full bank account number without spaces or dashes, as listed on your passbook.',
        example: '00001234567890',
        hint: 'Usually 9–18 digits depending on your bank'
      };
    }
    // generic fallback
    return {
      icon: '✏️',
      title: fieldName || 'Required Field',
      subtitle: 'Agent needs your input',
      desc: expectedValue || 'Please enter the required value directly into this field on the page.',
      example: null,
      hint: 'Type directly into the highlighted field'
    };
  }

  // ── Core guide renderer ────────────────────────────────────────────────────
  function showFieldGuide(el, fieldName, expectedValue, inputType, onDone) {
    ensureGuideStyles();

    // Clean up any previous guide
    _removeGuideDOM();

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const info = buildFieldInfo(fieldName, expectedValue, inputType);

    // 1. Spotlight backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'pv-guide-backdrop';
    document.body.appendChild(backdrop);

    const spotlight = document.createElement('div');
    spotlight.id = 'pv-guide-spotlight';
    backdrop.appendChild(spotlight);

    function updateSpotlight() {
      const r = el.getBoundingClientRect();
      const pad = 6;
      spotlight.style.left   = `${r.left - pad}px`;
      spotlight.style.top    = `${r.top  - pad}px`;
      spotlight.style.width  = `${r.width  + pad * 2}px`;
      spotlight.style.height = `${r.height + pad * 2}px`;
    }
    updateSpotlight();

    // 2. Pulsing outline on element
    el.classList.add('pv-field-active');
    setTimeout(() => el.focus(), 200);

    // 3. Build callout card
    const card = document.createElement('div');
    card.id = 'pv-guide-card';
    card.innerHTML = `
      <div class="pv-card-header">
        <span class="pv-card-header-icon">${info.icon}</span>
        <div>
          <div class="pv-card-header-title">${escapeHtml(info.title)}</div>
          <div class="pv-card-header-sub">${escapeHtml(info.subtitle)}</div>
        </div>
      </div>
      <div class="pv-card-body">
        <div class="pv-card-desc">${escapeHtml(info.desc)}</div>
        ${info.example ? `
          <div class="pv-card-example">
            <div class="pv-card-example-label">Example</div>
            <div class="pv-card-example-val">${escapeHtml(info.example)}</div>
          </div>` : ''}
      </div>
      <div class="pv-card-footer">
        <span class="pv-card-hint">💡 ${escapeHtml(info.hint)}</span>
        <button class="pv-card-done-btn" id="pv-guide-done-btn">Done ✓</button>
      </div>
    `;
    document.body.appendChild(card);
    card.classList.add('pv-card-enter');

    // 4. Position card (prefer right side of element, fall back to top/bottom)
    function positionCard() {
      const r   = el.getBoundingClientRect();
      const vw  = window.innerWidth;
      const vh  = window.innerHeight;
      const cw  = 310; // card width
      const ch  = card.offsetHeight || 200;
      let   cx, cy;

      const spaceRight  = vw - r.right - 20;
      const spaceLeft   = r.left - 20;
      const spaceTop    = r.top - 20;
      const spaceBottom = vh - r.bottom - 20;

      if (spaceRight >= cw) {
        cx = window.scrollX + r.right + 16;
        cy = window.scrollY + r.top + (r.height - ch) / 2;
      } else if (spaceLeft >= cw) {
        cx = window.scrollX + r.left - cw - 16;
        cy = window.scrollY + r.top + (r.height - ch) / 2;
      } else if (spaceTop >= ch) {
        cx = window.scrollX + r.left + (r.width - cw) / 2;
        cy = window.scrollY + r.top - ch - 16;
      } else {
        cx = window.scrollX + r.left + (r.width - cw) / 2;
        cy = window.scrollY + r.bottom + 16;
      }

      // Clamp inside viewport
      cx = Math.max(window.scrollX + 10, Math.min(cx, window.scrollX + vw - cw - 10));
      cy = Math.max(window.scrollY + 10, cy);

      card.style.left  = `${cx}px`;
      card.style.top   = `${cy}px`;
      card.style.width = `${cw}px`;

      return { cx, cy, cw, ch: card.offsetHeight };
    }
    setTimeout(positionCard, 0);

    // 5. SVG animated dashed connector line
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'pv-guide-svg';
    svg.style.width  = '1px';
    svg.style.height = '1px';
    document.body.appendChild(svg);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'pv-connector');
    svg.appendChild(path);

    // Arrowhead marker
    const defs   = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'pv-arrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const arrowPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    arrowPoly.setAttribute('points', '0 0, 8 3, 0 6');
    arrowPoly.setAttribute('fill', '#0055b8');
    marker.appendChild(arrowPoly);
    defs.appendChild(marker);
    svg.appendChild(defs);
    path.setAttribute('marker-end', 'url(#pv-arrow)');

    function drawConnector() {
      const r  = el.getBoundingClientRect();
      const cr = card.getBoundingClientRect();

      // Start: closest card edge midpoint; End: element midpoint
      const ex = window.scrollX + r.left + r.width  / 2;
      const ey = window.scrollY + r.top  + r.height / 2;
      const cx = window.scrollX + (cr.left + cr.width  / 2);
      const cy = window.scrollY + (cr.top  + cr.height / 2);

      // Choose start from card edge nearest element
      let sx, sy;
      if (cr.right < r.left) {
        sx = window.scrollX + cr.right; sy = window.scrollY + cr.top + cr.height / 2;
      } else if (cr.left > r.right) {
        sx = window.scrollX + cr.left; sy = window.scrollY + cr.top + cr.height / 2;
      } else if (cr.bottom < r.top) {
        sx = cx; sy = window.scrollY + cr.bottom;
      } else {
        sx = cx; sy = window.scrollY + cr.top;
      }

      const dx = ex - sx;
      const dy = ey - sy;
      const d  = `M ${sx} ${sy} C ${sx + dx * .4} ${sy}, ${ex - dx * .3} ${ey}, ${ex} ${ey}`;
      path.setAttribute('d', d);

      // Resize SVG to cover area
      const minX = Math.min(sx, ex) - 20;
      const minY = Math.min(sy, ey) - 20;
      const maxX = Math.max(sx, ex) + 20;
      const maxY = Math.max(sy, ey) + 20;
      svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
      svg.style.left   = `${minX}px`;
      svg.style.top    = `${minY}px`;
      svg.style.width  = `${maxX - minX}px`;
      svg.style.height = `${maxY - minY}px`;
    }

    let rafId;
    function rafLoop() {
      updateSpotlight();
      positionCard();
      drawConnector();
      rafId = requestAnimationFrame(rafLoop);
    }
    // Only run RAF for a short time to settle, then stop (performance)
    rafId = requestAnimationFrame(rafLoop);
    setTimeout(() => cancelAnimationFrame(rafId), 600);

    // 6. Done handler
    function handleDone() {
      _removeGuideDOM();
      if (typeof onDone === 'function') onDone();
    }

    const doneBtn = document.getElementById('pv-guide-done-btn');
    if (doneBtn) doneBtn.addEventListener('click', handleDone, { once: true });
    el.addEventListener('change', handleDone, { once: true });

    // Store cleanup reference
    window.__BA_state.guideCleanup = handleDone;
    return { success: true };
  }

  function _removeGuideDOM() {
    cancelAnimationFrame(window.__BA_state._guideRaf);
    ['pv-guide-card', 'pv-guide-svg', 'pv-guide-backdrop'].forEach((id) => {
      document.getElementById(id)?.remove();
    });
    document.querySelectorAll('.pv-field-active').forEach((e) => e.classList.remove('pv-field-active'));
    window.__BA_state.guideCleanup = null;
  }

  // ── Public BrowserAgent API ────────────────────────────────────────────────
  const BrowserAgent = {
    runFullExtraction() { return window.__BA_DomExtractor.runExtraction(); },
    getLastResult()     { return window.__BA_state.lastResult; },

    click(elementId) {
      const el = resolveElement(elementId);
      if (!el) return { success: false, reason: 'element_not_found' };
      if (!window.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight))
        return { success: false, reason: 'element_not_visible' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { success: true };
    },

    type(elementId, text) {
      const el = resolveElement(elementId);
      if (!el) return { success: false, reason: 'element_not_found' };
      if (!window.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight))
        return { success: false, reason: 'element_not_visible' };
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return { success: false, reason: 'element_not_typeable' };
      el.focus();
      dispatchNativeInput(el, text);
      return { success: true };
    },

    scroll(direction, amount = 400) {
      window.scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'smooth' });
      return { success: true };
    },

    select(elementId, optionValue) {
      const el = resolveElement(elementId);
      if (!el || el.tagName.toLowerCase() !== 'select')
        return { success: false, reason: 'element_not_found_or_not_select' };
      el.value = optionValue;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    },

    highlightField(elementId, fieldName, expectedValue) {
      const el = resolveElement(elementId);
      if (!el) return { success: false, reason: 'element_not_found' };
      const inputType = el.getAttribute('type') || '';
      showFieldGuide(el, fieldName, expectedValue, inputType, null);
      return { success: true };
    },

    clearHighlight() {
      _removeGuideDOM();
      return { success: true };
    },

    startObserving() {
      if (window.__BA_state.observer) return;
      const observer = new MutationObserver(() => {
        clearTimeout(window.__BA_state.debounceTimer);
        window.__BA_state.debounceTimer = setTimeout(() => {
          try { window.__BA_DomExtractor.runExtraction(); } catch (e) {}
        }, 400);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      window.__BA_state.observer = observer;
    },

    stopObserving() {
      if (window.__BA_state.observer) {
        window.__BA_state.observer.disconnect();
        window.__BA_state.observer = null;
      }
    }
  };

  window.__BA = BrowserAgent;
})(window);