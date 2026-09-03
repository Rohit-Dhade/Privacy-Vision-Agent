/**
 * popup/popup.js
 *
 * Chat-driven controller for the agent loop:
 *
 *   user types a task
 *     -> analyze page (extract DOM + detect PII locally + screenshot)
 *     -> redact screenshot locally
 *     -> POST { task, redacted screenshot, sanitized elements, viewport, history }
 *        to the configured backend (agent/agentBackend.js — the ONLY
 *        network call in this extension)
 *     -> backend replies { action, element_id, value }
 *     -> execute click/type/scroll on that element_id via the content
 *        script (background/service-worker.js -> window.__BA.*)
 *     -> re-analyze the (possibly changed) page and repeat
 *     -> stop when the backend replies { action: "done" }, asks for
 *        user info via { action: "ask_user" }, errors, or a safety
 *        step-cap is hit
 */

const MAX_AGENT_STEPS = 25;
const SETTLE_DELAY_MS = 600; // let the page react to an action before re-analyzing

const els = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  backendUrlInput: document.getElementById('backendUrlInput'),
  saveBackendBtn: document.getElementById('saveBackendBtn'),
  backendSavedNote: document.getElementById('backendSavedNote'),

  closeBtn: document.getElementById('closeBtn'),

  chatLog: document.getElementById('chatLog'),
  taskInput: document.getElementById('taskInput'),
  sendBtn: document.getElementById('sendBtn'),
  errorLine: document.getElementById('errorLine'),

  userInputSection: document.getElementById('userInputSection'),
  userInputContainer: document.getElementById('userInputContainer'),

  detailsPanel: document.getElementById('detailsPanel'),
  countElements: document.getElementById('countElements'),
  countSensitive: document.getElementById('countSensitive'),
  screenshotCanvas: document.getElementById('screenshotCanvas'),
  elementsList: document.getElementById('elementsList'),
  elementsJson: document.getElementById('elementsJson'),
  visibleTextJson: document.getElementById('visibleTextJson'),
  sensitiveList: document.getElementById('sensitiveList'),
  agentStateLine: document.getElementById('agentStateLine'),

  statusDot: document.getElementById('statusDot'),
  statusBarText: document.getElementById('statusBarText'),

  // Local Private Information Store elements
  storeKeyInput: document.getElementById('storeKeyInput'),
  storeValInput: document.getElementById('storeValInput'),
  toggleStoreValMaskBtn: document.getElementById('toggleStoreValMaskBtn'),
  saveStoreEntryBtn: document.getElementById('saveStoreEntryBtn'),
  saveStoreEntryBtnText: document.getElementById('saveStoreEntryBtnText'),
  cancelStoreEditBtn: document.getElementById('cancelStoreEditBtn'),
  storeSavedNote: document.getElementById('storeSavedNote'),
  storeItemsCount: document.getElementById('storeItemsCount'),
  storeEntriesList: document.getElementById('storeEntriesList'),
  clearStoreBtn: document.getElementById('clearStoreBtn'),

  // Execution Mode elements
  radioModeHitl: document.getElementById('radioModeHitl'),
  radioModeComplete: document.getElementById('radioModeComplete'),
  modeOptHitl: document.getElementById('modeOptHitl'),
  modeOptComplete: document.getElementById('modeOptComplete'),

  // UI View & Navigation elements
  headerTitle: document.getElementById('headerTitle'),
  settingsBtnIcon: document.getElementById('settingsBtnIcon'),
  agentView: document.getElementById('agentView'),
  welcomeState: document.getElementById('welcomeState'),
  composerSection: document.getElementById('composerSection'),
  modeDropdownBtn: document.getElementById('modeDropdownBtn'),
  modeDropdownLabel: document.getElementById('modeDropdownLabel'),
  modeMenuPopover: document.getElementById('modeMenuPopover')
};

const agentController = new window.__BA_AgentController();
const agentBackend = new window.__BA_AgentBackend();
const userInputManager = new window.__BA_UserInputManager(els.userInputContainer);
const privateDataStore = new window.__BA_PrivateDataStore();

let isRunning = false;
let actionHistory = []; // { action, elementId, value, result } — in-memory only, cleared per task

agentController.onStateChange((state) => {
  if (els.agentStateLine) {
    els.agentStateLine.textContent = state;
  }

  // Synchronize status bar indicator
  if (els.statusBarText && els.statusDot) {
    switch (state) {
      case 'IDLE':
        els.statusBarText.textContent = 'LOCAL SCAN ACTIVE';
        els.statusDot.className = 'pv-status-dot';
        break;
      case 'OBSERVING':
        els.statusBarText.textContent = 'OBSERVING PAGE & REDACTING';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'UNDERSTANDING':
        els.statusBarText.textContent = 'UNDERSTANDING PAGE STATE';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'PLANNING':
        els.statusBarText.textContent = 'PLANNING NEXT STEP';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'WAITING_FOR_REASONER':
        els.statusBarText.textContent = 'CONSULTING AI REASONER';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'VALIDATING_ACTION':
        els.statusBarText.textContent = 'VALIDATING ACTION SAFETY';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'EXECUTING_ACTION':
        els.statusBarText.textContent = 'EXECUTING AGENT ACTION';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'VERIFYING_ACTION':
        els.statusBarText.textContent = 'VERIFYING ACTION OUTCOME';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'WAITING_FOR_USER':
        els.statusBarText.textContent = 'ACTION REQUIRED — INPUT NEEDED';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'WAITING_FOR_CONFIRMATION':
        els.statusBarText.textContent = 'HUMAN CONFIRMATION REQUIRED';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'REPLANNING':
        els.statusBarText.textContent = 'REPLANNING ACTION PATH';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'COMPLETED':
        els.statusBarText.textContent = 'TASK COMPLETED';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'BLOCKED':
        els.statusBarText.textContent = 'AGENT BLOCKED';
        els.statusDot.className = 'pv-status-dot error';
        break;
      case 'FAILED':
      case 'ERROR':
        els.statusBarText.textContent = 'AGENT FAILED';
        els.statusDot.className = 'pv-status-dot error';
        break;
      case 'STOPPED':
        els.statusBarText.textContent = 'EXECUTION STOPPED';
        els.statusDot.className = 'pv-status-dot';
        break;
      default:
        els.statusBarText.textContent = state;
        els.statusDot.className = 'pv-status-dot active';
        break;
    }
  }
});

// ---------- Chat rendering & Viewport Scrolling ----------

function scrollToBottom() {
  const mainEl = document.querySelector('.pv-main');
  if (mainEl) {
    mainEl.scrollTop = mainEl.scrollHeight;
  }
}

function addMessage(role, text, options = {}) {
  const card = document.createElement('div');

  if (role === 'user') {
    card.className = 'pv-msg-card pv-msg-user';
    card.innerHTML = `
      <div class="pv-msg-user-header">
        <span class="material-symbols-outlined">account_circle</span>
        <span>Task Request</span>
      </div>
      <div class="pv-msg-user-text"></div>
    `;
    card.querySelector('.pv-msg-user-text').textContent = text;
  } else if (role === 'agent') {
    card.className = 'pv-msg-card pv-msg-agent';
    card.innerHTML = `
      <div class="pv-msg-agent-header">
        <span class="material-symbols-outlined">shield</span>
        <span>Privacy Vision Agent</span>
      </div>
      <div class="pv-msg-agent-text"></div>
    `;
    card.querySelector('.pv-msg-agent-text').textContent = text;

    // Render Redaction Summary card component if sensitive items present
    if (options.sensitiveItems && options.sensitiveItems.length > 0) {
      const summaryBox = document.createElement('div');
      summaryBox.className = 'pv-redaction-summary-box';

      const itemsHtml = options.sensitiveItems.map(item => `
        <li class="pv-redaction-item">
          <span class="material-symbols-outlined">check_circle</span>
          <span>${escapeHtml(item.type)} field redacted (${escapeHtml(item.masked)})</span>
        </li>
      `).join('');

      summaryBox.innerHTML = `
        <div class="pv-redaction-header">
          <span class="material-symbols-outlined">policy</span>
          <span>Redaction Summary</span>
        </div>
        <ul class="pv-redaction-list">
          ${itemsHtml}
        </ul>
        <div class="pv-redaction-info-banner">
          <span class="material-symbols-outlined">info</span>
          <span>Sent to server: field structure only, no sensitive values</span>
        </div>
      `;
      card.appendChild(summaryBox);
    }
  } else if (role === 'system') {
    card.className = 'pv-msg-card pv-msg-system';
    card.innerHTML = `
      <span class="material-symbols-outlined">info</span>
      <span class="pv-msg-system-text"></span>
    `;
    card.querySelector('.pv-msg-system-text').textContent = text;
  } else if (role === 'suggestion') {
    card.className = 'pv-msg-card pv-msg-suggestion';
    const badgeText = (options?.badge || options?.type || 'SUGGESTION').toUpperCase().replace(/_/g, ' ');
    card.innerHTML = `
      <div class="pv-msg-suggestion-header">
        <span class="material-symbols-outlined">lightbulb</span>
        <span class="pv-suggestion-badge">${escapeHtml(badgeText)}</span>
      </div>
      <div class="pv-msg-suggestion-text"></div>
    `;
    card.querySelector('.pv-msg-suggestion-text').textContent = text;
  } else if (role === 'error') {
    card.className = 'pv-msg-card pv-msg-agent';
    card.style.borderLeftColor = 'var(--pv-error)';
    card.innerHTML = `
      <div class="pv-msg-agent-header" style="color: var(--pv-error);">
        <span class="material-symbols-outlined" style="color: var(--pv-error);">error</span>
        <span style="color: var(--pv-error);">Error</span>
      </div>
      <div class="pv-msg-agent-text" style="color: var(--pv-error);"></div>
    `;
    card.querySelector('.pv-msg-agent-text').textContent = text;
  } else {
    card.className = 'pv-msg-card';
    card.textContent = text;
  }

  els.chatLog.appendChild(card);
  updateWelcomeState();
  scrollToBottom();
  return card;
}

function updateWelcomeState() {
  if (els.welcomeState && els.chatLog) {
    els.welcomeState.hidden = (els.chatLog.children.length > 0);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showError(message) {
  els.errorLine.hidden = false;
  els.errorLine.textContent = message;
  addMessage('error', message);
}

function clearError() {
  els.errorLine.hidden = true;
  els.errorLine.textContent = '';
}

// ---------- Settings & Local Private Information Store ----------

let editingStoreKey = null;

async function renderPrivateStoreEntries() {
  if (!els.storeEntriesList) return;
  const entries = await privateDataStore.getAll();
  const keys = Object.keys(entries);

  if (els.storeItemsCount) {
    els.storeItemsCount.textContent = keys.length;
  }

  els.storeEntriesList.innerHTML = '';

  if (keys.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'pv-empty-store-msg';
    emptyMsg.textContent = 'No local information stored. Add entries above (e.g. name, email, phone).';
    els.storeEntriesList.appendChild(emptyMsg);
    return;
  }

  for (const key of keys) {
    const val = entries[key];
    const row = document.createElement('div');
    row.className = 'pv-store-item';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'pv-store-item-content';

    const keyBadge = document.createElement('span');
    keyBadge.className = 'pv-store-key-badge';
    keyBadge.textContent = key;

    const valPreview = document.createElement('span');
    valPreview.className = 'pv-store-val-preview';
    valPreview.textContent = '••••••••••••';
    valPreview.dataset.masked = 'true';

    contentDiv.appendChild(keyBadge);
    contentDiv.appendChild(valPreview);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pv-store-item-actions';

    // Show/Hide Mask button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'pv-icon-btn pv-btn-xs';
    toggleBtn.title = 'Show value';
    toggleBtn.setAttribute('aria-label', `Show value for ${key}`);
    toggleBtn.innerHTML = '<span class="material-symbols-outlined">visibility</span>';

    toggleBtn.addEventListener('click', () => {
      const isMasked = valPreview.dataset.masked === 'true';
      if (isMasked) {
        valPreview.textContent = val;
        valPreview.dataset.masked = 'false';
        valPreview.classList.add('revealed');
        toggleBtn.title = 'Hide value';
        toggleBtn.innerHTML = '<span class="material-symbols-outlined">visibility_off</span>';
      } else {
        valPreview.textContent = '••••••••••••';
        valPreview.dataset.masked = 'true';
        valPreview.classList.remove('revealed');
        toggleBtn.title = 'Show value';
        toggleBtn.innerHTML = '<span class="material-symbols-outlined">visibility</span>';
      }
    });

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'pv-icon-btn pv-btn-xs';
    editBtn.title = 'Edit value';
    editBtn.setAttribute('aria-label', `Edit value for ${key}`);
    editBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';

    editBtn.addEventListener('click', () => {
      editingStoreKey = key;
      els.storeKeyInput.value = key;
      els.storeValInput.value = val;
      els.storeKeyInput.disabled = true;
      els.saveStoreEntryBtnText.textContent = 'Update';
      els.cancelStoreEditBtn.hidden = false;
      els.storeValInput.focus();
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pv-icon-btn pv-btn-xs pv-btn-danger';
    delBtn.title = 'Delete';
    delBtn.setAttribute('aria-label', `Delete ${key}`);
    delBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';

    delBtn.addEventListener('click', async () => {
      await privateDataStore.remove(key);
      if (editingStoreKey === key) {
        resetStoreForm();
      }
      await renderPrivateStoreEntries();
    });

    actionsDiv.appendChild(toggleBtn);
    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(delBtn);

    row.appendChild(contentDiv);
    row.appendChild(actionsDiv);
    els.storeEntriesList.appendChild(row);
  }
}

function resetStoreForm() {
  editingStoreKey = null;
  els.storeKeyInput.value = '';
  els.storeValInput.value = '';
  els.storeKeyInput.disabled = false;
  els.saveStoreEntryBtnText.textContent = 'Save Information';
  els.cancelStoreEditBtn.hidden = true;
  els.storeValInput.type = 'password';
  if (els.toggleStoreValMaskBtn) {
    els.toggleStoreValMaskBtn.innerHTML = '<span class="material-symbols-outlined">visibility</span>';
  }
}

async function handleSaveStoreEntry() {
  const key = els.storeKeyInput.value.trim();
  const val = els.storeValInput.value;

  if (!key) {
    showError('Please enter a key name (e.g. name, email, phone).');
    els.storeKeyInput.focus();
    return;
  }

  clearError();
  await privateDataStore.set(key, val);

  resetStoreForm();
  if (els.storeSavedNote) {
    els.storeSavedNote.hidden = false;
    setTimeout(() => { els.storeSavedNote.hidden = true; }, 1500);
  }

  await renderPrivateStoreEntries();
}

function initPrivateStoreUI() {
  if (els.saveStoreEntryBtn) {
    els.saveStoreEntryBtn.addEventListener('click', handleSaveStoreEntry);
  }

  if (els.cancelStoreEditBtn) {
    els.cancelStoreEditBtn.addEventListener('click', resetStoreForm);
  }

  if (els.toggleStoreValMaskBtn) {
    els.toggleStoreValMaskBtn.addEventListener('click', () => {
      const isPassword = els.storeValInput.type === 'password';
      els.storeValInput.type = isPassword ? 'text' : 'password';
      els.toggleStoreValMaskBtn.innerHTML = isPassword
        ? '<span class="material-symbols-outlined">visibility_off</span>'
        : '<span class="material-symbols-outlined">visibility</span>';
    });
  }

  if (els.clearStoreBtn) {
    els.clearStoreBtn.addEventListener('click', async () => {
      const confirmed = window.confirm('Clear all stored personal information from this browser?');
      if (confirmed) {
        await privateDataStore.clear();
        resetStoreForm();
        await renderPrivateStoreEntries();
      }
    });
  }

  if (els.storeValInput) {
    els.storeValInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveStoreEntry();
      }
    });
  }

  if (els.storeKeyInput) {
    els.storeKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        els.storeValInput.focus();
      }
    });
  }
}

// ---------- Dual Execution Mode Management ----------

let isModeMenuOpen = false;

function getSelectedMode() {
  return els.radioModeComplete?.checked ? 'complete' : 'hitl';
}

function setAgentMode(mode) {
  const isComplete = mode === 'complete';
  if (isComplete) {
    if (els.radioModeComplete) els.radioModeComplete.checked = true;
    if (els.modeOptComplete) els.modeOptComplete.classList.add('active');
    if (els.modeOptHitl) els.modeOptHitl.classList.remove('active');
    if (els.modeDropdownLabel) els.modeDropdownLabel.textContent = 'Complete Automatically';
  } else {
    if (els.radioModeHitl) els.radioModeHitl.checked = true;
    if (els.modeOptHitl) els.modeOptHitl.classList.add('active');
    if (els.modeOptComplete) els.modeOptComplete.classList.remove('active');
    if (els.modeDropdownLabel) els.modeDropdownLabel.textContent = 'Assist Me (HITL)';
  }
}

function toggleModeMenu(force) {
  if (!els.modeMenuPopover) return;
  isModeMenuOpen = typeof force === 'boolean' ? force : !isModeMenuOpen;
  els.modeMenuPopover.hidden = !isModeMenuOpen;
  if (els.modeDropdownBtn) {
    els.modeDropdownBtn.setAttribute('aria-expanded', String(isModeMenuOpen));
    const chevron = els.modeDropdownBtn.querySelector('.pv-mode-chevron');
    if (chevron) {
      chevron.textContent = isModeMenuOpen ? 'expand_less' : 'expand_more';
    }
  }
}

function initModeSelector() {
  if (els.radioModeHitl) {
    els.radioModeHitl.addEventListener('change', () => {
      setAgentMode('hitl');
      toggleModeMenu(false);
    });
  }
  if (els.radioModeComplete) {
    els.radioModeComplete.addEventListener('change', () => {
      setAgentMode('complete');
      toggleModeMenu(false);
    });
  }
  if (els.modeOptHitl) {
    els.modeOptHitl.addEventListener('click', (e) => {
      e.stopPropagation();
      setAgentMode('hitl');
      toggleModeMenu(false);
    });
  }
  if (els.modeOptComplete) {
    els.modeOptComplete.addEventListener('click', (e) => {
      e.stopPropagation();
      setAgentMode('complete');
      toggleModeMenu(false);
    });
  }

  if (els.modeDropdownBtn) {
    els.modeDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModeMenu();
    });
  }

  // Close mode popover when clicking outside
  document.addEventListener('click', (e) => {
    if (isModeMenuOpen && !e.target.closest('.pv-mode-dropdown-wrapper')) {
      toggleModeMenu(false);
    }
  });

  toggleModeMenu(false);
  setAgentMode(getSelectedMode());
}

function toggleSettingsView(open) {
  const isOpening = typeof open === 'boolean' ? open : (els.settingsPanel ? els.settingsPanel.hidden : false);
  
  // Close mode popover when switching views
  toggleModeMenu(false);

  if (els.settingsPanel) els.settingsPanel.hidden = !isOpening;
  if (els.agentView) els.agentView.hidden = isOpening;

  if (isOpening) {
    if (els.settingsBtn) {
      els.settingsBtn.classList.add('active');
      els.settingsBtn.title = 'Back to Agent';
    }
    if (els.settingsBtnIcon) els.settingsBtnIcon.textContent = 'arrow_back';
    if (els.headerTitle) els.headerTitle.textContent = 'Settings & Local Data';
  } else {
    if (els.settingsBtn) {
      els.settingsBtn.classList.remove('active');
      els.settingsBtn.title = 'Settings & Local Data';
    }
    if (els.settingsBtnIcon) els.settingsBtnIcon.textContent = 'settings';
    if (els.headerTitle) els.headerTitle.textContent = 'Privacy Vision Agent';
    updateWelcomeState();
  }
}

async function initSettings() {
  els.backendUrlInput.value = await agentBackend.getEndpoint();
  await renderPrivateStoreEntries();
  initPrivateStoreUI();
  initModeSelector();
  toggleSettingsView(false);
  updateWelcomeState();
}

els.settingsBtn.addEventListener('click', () => {
  toggleSettingsView();
});

els.saveBackendBtn.addEventListener('click', async () => {
  const url = els.backendUrlInput.value.trim();
  if (!url) return;
  await agentBackend.setEndpoint(url);
  els.backendSavedNote.hidden = false;
  setTimeout(() => { els.backendSavedNote.hidden = true; }, 1500);
});

// ---------- Messaging to background ----------

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Rendering the latest analysis into the details panel ----------

function renderElementsList(elements) {
  els.elementsList.innerHTML = '';
  const top = elements.slice(0, 25);
  for (const el of top) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag';
    tag.textContent = el.type;
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = `[${el.id}] ${el.text || el.placeholder || el.ariaLabel || '(no label)'}`;
    row.appendChild(label);

    const bboxLine = document.createElement('div');
    bboxLine.style.color = '#737781';
    bboxLine.style.fontSize = '10px';
    bboxLine.textContent = `bbox: [${el.bbox.x}, ${el.bbox.y}, ${el.bbox.width}, ${el.bbox.height}]`;
    row.appendChild(bboxLine);

    els.elementsList.appendChild(row);
  }
  els.elementsJson.textContent = JSON.stringify(elements, null, 2);
}

function renderSensitiveList(sensitiveItems) {
  els.sensitiveList.innerHTML = '';
  for (const item of sensitiveItems) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag sensitive';
    tag.textContent = item.type;
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = `${item.masked} (confidence ${Math.round(item.confidence * 100)}%)`;
    row.appendChild(label);

    els.sensitiveList.appendChild(row);
  }
}

async function drawRedactedScreenshot(
  screenshotDataUrl,
  sensitiveItems,
  viewport,
  faceBoxes = []
) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not create 2D canvas context"));
        return;
      }

      ctx.drawImage(img, 0, 0);

      // Redact DOM PII
      ctx.fillStyle = "#000000";
      for (const item of (sensitiveItems || [])) {
        if (!item?.bbox) continue;

        const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(
          item.bbox,
          viewport,
          canvas.width,
          canvas.height,
          4
        );

        if (
          Number.isFinite(box.x) &&
          Number.isFinite(box.y) &&
          box.width > 0 &&
          box.height > 0
        ) {
          ctx.fillRect(box.x, box.y, box.width, box.height);
        }
      }

      // Redact Faces
      for (const face of (faceBoxes || [])) {
        if (
          !face ||
          !Number.isFinite(face.x) ||
          !Number.isFinite(face.y) ||
          !Number.isFinite(face.width) ||
          !Number.isFinite(face.height)
        ) {
          continue;
        }

        const padding = 10;
        let x = Math.floor(face.x - padding);
        let y = Math.floor(face.y - padding);
        let right = Math.ceil(face.x + face.width + padding);
        let bottom = Math.ceil(face.y + face.height + padding);

        x = Math.max(0, Math.min(canvas.width, x));
        y = Math.max(0, Math.min(canvas.height, y));
        right = Math.max(x, Math.min(canvas.width, right));
        bottom = Math.max(y, Math.min(canvas.height, bottom));

        const width = right - x;
        const height = bottom - y;

        if (width <= 0 || height <= 0) continue;

        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, width, height);
      }

      const dataUrl = canvas.toDataURL("image/png");
      resolve({ canvas, dataUrl });
    };

    img.onerror = (error) => {
      reject(new Error("Could not load screenshot"));
    };

    if (typeof screenshotDataUrl !== "string" || !screenshotDataUrl.startsWith("data:image/")) {
      reject(new Error("Invalid screenshot data URL"));
      return;
    }

    img.src = screenshotDataUrl;
  });
}

function findElementLabel(elements, elementId) {
  const el = Array.isArray(elements) ? elements.find((e) => e.id === elementId) : null;
  if (!el) return `element #${elementId}`;
  return el.text || el.placeholder || el.ariaLabel || `${el.type} #${elementId}`;
}

function findElementByTarget(targetSelector, elementId, elements) {
  if (!Array.isArray(elements)) return null;
  if (elementId != null) {
    const byId = elements.find(e => e.id === elementId);
    if (byId) return byId;
  }
  if (targetSelector) {
    const exact = elements.find(e => e.selector === targetSelector);
    if (exact) return exact;

    if (targetSelector.startsWith('#')) {
      const cleanId = targetSelector.slice(1);
      const bySubId = elements.find(e => e.selector === targetSelector || (e.selector && e.selector.includes(`#${cleanId}`)));
      if (bySubId) return bySubId;
    }

    const norm = targetSelector.trim().toLowerCase();
    const byNorm = elements.find(e => {
      if (!e.selector) return false;
      const s = e.selector.trim().toLowerCase();
      return s === norm || s.endsWith(norm) || norm.endsWith(s);
    });
    if (byNorm) return byNorm;
  }
  return null;
}

function isElementPopulated(el) {
  if (!el) return false;
  if (el.hasValue === true) return true;
  if (el.value != null && el.value !== '' && el.value !== 'unchecked' && el.value !== '[REDACTED]') {
    return true;
  }
  return false;
}

function reconcilePopulatedFields(elements, history) {
  if (!Array.isArray(elements) || !Array.isArray(history)) return;
  for (const el of elements) {
    if (!window.__BA_FormAnalyzer?.isFormInputElement(el)) continue;
    if (isElementPopulated(el)) {
      const alreadyInHistory = history.some(h => 
        (h.action === 'fill' || h.action === 'fill_from_local') && 
        (h.elementId === el.id || (h.targetSelector && (h.targetSelector === el.selector || el.selector?.endsWith(h.targetSelector))))
      );
      if (!alreadyInHistory) {
        history.push({
          action: 'fill',
          elementId: el.id,
          targetSelector: el.selector,
          fieldName: el.text || el.ariaLabel || el.placeholder || `field_${el.id}`,
          value: '[ENTERED_BY_USER]',
          result: { success: true, filledByUser: true }
        });
      }
    }
  }
}

function describeAction(decision, elements) {
  switch (decision.action) {
    case 'click':
      return `Clicking "${findElementLabel(elements, decision.elementId)}"…`;
    case 'type':
    case 'fill':
      return `Typing into "${findElementLabel(elements, decision.elementId)}"…`;
    case 'fill_from_local':
      return `Filling "${findElementLabel(elements, decision.elementId)}" from local private store…`;
    case 'clear':
      return `Clearing input "${findElementLabel(elements, decision.elementId)}"…`;
    case 'select':
      return `Selecting option "${decision.value || ''}" in dropdown "${findElementLabel(elements, decision.elementId)}"…`;
    case 'check':
      return `${decision.value !== false ? 'Checking' : 'Unchecking'} "${findElementLabel(elements, decision.elementId)}"…`;
    case 'hover':
      return `Hovering over "${findElementLabel(elements, decision.elementId)}"…`;
    case 'focus':
      return `Focusing "${findElementLabel(elements, decision.elementId)}"…`;
    case 'press_key':
      return `Pressing key "${decision.value || 'Enter'}" on "${findElementLabel(elements, decision.elementId)}"…`;
    case 'scroll':
      return `Scrolling ${decision.value || 'down'}…`;
    case 'navigate':
      return `Navigating to ${decision.value}…`;
    case 'back':
      return 'Navigating back in history…';
    case 'forward':
      return 'Navigating forward in history…';
    case 'extract':
      return `Extracting content from page…`;
    case 'wait':
      return 'Waiting for the page to settle…';
    default:
      return `Performing ${decision.action}…`;
  }
}

function buildActionArgs(decision) {
  switch (decision.action) {
    case 'click':
      return [decision.elementId, decision.targetSelector];
    case 'type':
    case 'fill':
      return [decision.elementId, decision.value || '', decision.targetSelector];
    case 'clear':
      return [decision.elementId, decision.targetSelector];
    case 'select':
      return [decision.elementId, decision.value || '', decision.targetSelector];
    case 'check':
      return [decision.elementId, decision.value !== false, decision.targetSelector];
    case 'hover':
      return [decision.elementId, decision.targetSelector];
    case 'focus':
      return [decision.elementId, decision.targetSelector];
    case 'press_key':
      return [decision.elementId, decision.value || 'Enter', decision.targetSelector];
    case 'scroll':
      return [decision.value === 'up' ? 'up' : 'down', 400, decision.targetSelector];
    case 'navigate':
      return [decision.value || ''];
    case 'back':
      return [];
    case 'forward':
      return [];
    case 'extract':
      return [decision.elementId, decision.targetSelector];
    default:
      return [decision.elementId, decision.value];
  }
}

// ---------- One analysis pass: extract + detect PII + screenshot + redact ----------

async function analyzeCurrentPage() {
  agentController.beginPageAnalysis();

  const response = await sendMessage({
    type: 'ANALYZE_PAGE'
  });

  if (response.data?.isUnsupportedScheme) {
    return {
      isUnsupportedScheme: true,
      url: response.data.url,
      extraction: null,
      redactedDataUrl: null
    };
  }

  const { extraction, screenshotDataUrl, faces } = response.data;

  agentController.onDomExtracted();
  agentController.onPiiDetected();
  agentController.onScreenshotCaptured();

  const faceBoxes = Array.isArray(faces) ? faces : [];

  const redactedResult = await drawRedactedScreenshot(
    screenshotDataUrl,
    extraction.sensitiveItems,
    extraction.viewport,
    faceBoxes
  );

  const redactedDataUrl = redactedResult.dataUrl;

  const displayCanvas = els.screenshotCanvas;
  if (displayCanvas) {
    const sourceCanvas = redactedResult.canvas;
    displayCanvas.width = sourceCanvas.width;
    displayCanvas.height = sourceCanvas.height;

    const displayCtx = displayCanvas.getContext("2d");
    if (displayCtx) {
      displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
      displayCtx.drawImage(sourceCanvas, 0, 0);
    }
  }

  agentController.onScreenshotRedacted();

  els.countElements.textContent = extraction.counts.interactiveElements;
  els.countSensitive.textContent = extraction.counts.sensitiveItems;

  renderElementsList(extraction.elements);
  renderSensitiveList(extraction.sensitiveItems);

  els.visibleTextJson.textContent = JSON.stringify(extraction.visibleText, null, 2);
  els.detailsPanel.hidden = false;

  agentController.evaluateReadiness(extraction);

  return {
    isUnsupportedScheme: false,
    extraction,
    redactedDataUrl
  };
}

/** Displays the On-Page Visual Guide notice in the sidebar until user types or clicks resume. */
function waitForUserInput(fields) {
  return new Promise((resolve) => {
    els.userInputSection.hidden = false;
    userInputManager.renderForm(fields, (values) => {
      els.userInputSection.hidden = true;
      userInputManager.clear();
      resolve(values);
    });

    setTimeout(() => {
      scrollToBottom();
      els.userInputSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  });
}

/** Displays the Pre-Submit / Human Authorization Gate notice in the sidebar until user confirms or cancels. */
function waitForUserConfirmation(options) {
  return new Promise((resolve) => {
    els.userInputSection.hidden = false;
    userInputManager.renderConfirmation(options, (confirmed) => {
      els.userInputSection.hidden = true;
      userInputManager.clear();
      resolve(confirmed);
    });

    setTimeout(() => {
      scrollToBottom();
      els.userInputSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  });
}

/** Displays the Generalized Human-in-the-Loop request notice in the sidebar until user acts or resumes. */
function waitForHitlIntervention(options) {
  return new Promise((resolve) => {
    els.userInputSection.hidden = false;
    userInputManager.renderHitlRequest(options, (response) => {
      els.userInputSection.hidden = true;
      userInputManager.clear();
      resolve(response);
    });

    setTimeout(() => {
      scrollToBottom();
      els.userInputSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  });
}

/**
 * Consequential Action Safety Protocol
 * Enforces the strict 9-step safety procedure before executing any consequential action:
 * 1. Stop
 * 2. Re-observe
 * 3. Verify target in fresh DOM
 * 4. Explain intended action to user
 * 5. Request explicit authorization
 * 6. Bind authorization to exact action & target
 * 7. Revalidate target after authorization
 * 8. Execute only then (consuming authorization immediately)
 * 9. Verify result
 */
async function authorizeAndExecuteConsequential(targetEl, decision, history, taskMemory, controller, context = {}) {
  const currentController = controller || agentController;
  // Step 1: STOP
  addMessage('system', '🛑 Consequential action detected — pausing automated loop for safety…');
  
  // Step 2: RE-OBSERVE
  let preAuthObservation;
  try {
    preAuthObservation = await analyzeCurrentPage();
  } catch (err) {
    showError(`Failed to re-observe page before authorization: ${err.message}`);
    currentController.markFailed(err);
    return false;
  }

  // Step 3: VERIFY TARGET IN FRESH DOM
  const freshElements = preAuthObservation?.extraction?.elements || [];
  const verifiedEl = findElementByTarget(decision?.targetSelector, decision?.elementId, freshElements) || targetEl;
  if (!verifiedEl && decision?.targetSelector) {
    addMessage('system', `⚠️ Target element "${decision.targetSelector}" disappeared before authorization could begin.`);
    currentController.triggerReplanning('Consequential target disappeared');
    return false;
  }

  const label = verifiedEl?.text || verifiedEl?.ariaLabel || verifiedEl?.placeholder || decision?.targetSelector || 'Execute Action';
  const consequential = window.__BA_ConsequentialActionDetector
    ? window.__BA_ConsequentialActionDetector.isConsequentialElement(verifiedEl, decision?.targetSelector, {
        pageUrl: preAuthObservation?.extraction?.url || context.pageUrl,
        taskInstruction: context.taskInstruction,
        pageContext: preAuthObservation?.extraction?.pageContext,
        surroundingText: verifiedEl?.surroundingText
      })
    : { isConsequential: true, actionType: 'SUBMIT', label, promptMessage: `Action "${label}" requires confirmation.`, isReversible: false };

  // Step 4: EXPLAIN INTENDED ACTION TO USER
  const reversibilityNotice = consequential.isReversible ? 'Reversible' : 'Irreversible (Cannot be undone)';
  const explanation = `${consequential.promptMessage}\n\n• **Action Type:** ${consequential.actionType || 'SUBMIT'}\n• **Reversibility:** ${reversibilityNotice}\n• **Target:** ${verifiedEl?.selector || decision?.targetSelector || label}`;
  addMessage('agent', explanation);

  const targetId = verifiedEl?.id ?? decision?.elementId;
  if (targetId != null) {
    try {
      await sendMessage({
        type: 'AGENT_ACTION',
        action: 'highlightField',
        args: [targetId, consequential.label, `Authorization Required (${reversibilityNotice})`]
      });
    } catch (_) {}
  }

  // Step 5: REQUEST EXPLICIT AUTHORIZATION
  currentController.waitForConfirmation(consequential);

  const isPayment = consequential.actionType === 'PAYMENT';
  const confirmed = await waitForUserConfirmation({
    title: isPayment ? 'Financial Action Authorization' : (consequential.isReversible ? 'Action Confirmation' : 'Irreversible Action Authorization'),
    promptMessage: explanation,
    actionLabel: consequential.label,
    actionType: consequential.actionType,
    cancelLabel: 'Decline / Do Not Execute'
  });

  try {
    await sendMessage({ type: 'AGENT_ACTION', action: 'clearHighlight', args: [] });
  } catch (_) {}

  if (!confirmed) {
    addMessage('system', 'Action execution paused by user.');
    addMessage('agent', `Execution held for "${consequential.label}" per your decision.`);
    currentController.markStopped('Consequential action declined by user');
    if (taskMemory) {
      taskMemory.recordConfirmation(decision?.action || 'click', decision?.targetSelector, false);
    }
    return false;
  }

  // Step 6: BIND AUTHORIZATION TO EXACT CURRENT ACTION & TARGET
  const authBinding = {
    token: 'AUTH_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    action: decision?.action || 'click',
    targetSelector: decision?.targetSelector,
    elementId: targetId,
    authorizedAt: Date.now(),
    consumed: false
  };

  // Step 7: REVALIDATE TARGET AFTER AUTHORIZATION
  let postAuthObservation;
  try {
    postAuthObservation = await analyzeCurrentPage();
  } catch (_) {}

  const postAuthElements = postAuthObservation?.extraction?.elements || [];
  const revalidatedEl = findElementByTarget(authBinding.targetSelector, authBinding.elementId, postAuthElements);
  if (!revalidatedEl && authBinding.targetSelector) {
    addMessage('system', `⚠️ Page state shifted during authorization; target "${authBinding.targetSelector}" is no longer valid.`);
    addMessage('agent', 'The target element moved or disappeared while waiting for confirmation. Halting execution for safety.');
    currentController.markStopped('Target invalidated during authorization');
    return false;
  }

  // Step 8: EXECUTE ONLY THEN (Consuming authorization immediately)
  if (authBinding.consumed) {
    throw new Error('Safety Violation: Authorization token has already been consumed and cannot be reused!');
  }
  authBinding.consumed = true; // Invalidate authorization token immediately so it can NEVER be reused

  addMessage('agent', `Authorized by user — executing "${consequential.label}"…`);
  currentController.beginExecuting(decision);

  let clickResp;
  try {
    clickResp = await sendMessage({
      type: 'AGENT_ACTION',
      action: 'click',
      args: [revalidatedEl?.id ?? targetId, decision?.targetSelector]
    });
  } catch (err) {
    console.warn('[popup] Consequential click failed:', err);
  }

  // Step 9: VERIFY RESULT
  currentController.beginVerifying(decision);
  const executionSuccess = clickResp?.ok ?? true;
  history.push({
    action: decision?.action || 'click',
    elementId: targetId,
    targetSelector: decision?.targetSelector,
    fieldName: consequential.label,
    value: null,
    result: { success: executionSuccess, authorizedByUser: true, outcome: 'TASK_COMPLETED' }
  });

  if (taskMemory) {
    taskMemory.recordConfirmation(decision?.action || 'click', decision?.targetSelector, true);
  }

  addMessage('agent', `🎉 Action "${consequential.label}" executed successfully! Task completed.`);
  currentController.markCompleted();
  return true;
}

async function handleFormCompletionGate(extraction, task, history) {
  const elements = Array.isArray(extraction) ? extraction : (extraction?.elements || []);
  const consequential = window.__BA_ConsequentialActionDetector
    ? window.__BA_ConsequentialActionDetector.detect(elements)
    : { found: false, element: null, elementId: null, targetSelector: null, label: '', actionType: null, promptMessage: '' };

  if (consequential.found && consequential.elementId != null) {
    const targetEl = consequential.element || elements.find(e => e.id === consequential.elementId);
    return await authorizeAndExecuteConsequential(targetEl, { action: 'click', elementId: consequential.elementId, targetSelector: consequential.targetSelector }, history);
  } else {
    addMessage('agent', '🎉 All required form fields are complete!');
    addMessage('system', 'Form fields are filled. What would you like me to do next?');
    agentController.markCompleted();
    return true;
  }
}

// ---------- Main agent loop ----------

async function runAgentLoop(task) {
  agentController.startTask(task);
  actionHistory = [];
  agentBackend.resetSession();
  let previousPageState = null;
  let lastRenderedSuggestion = null;
  const recentActionSignatures = [];
  let consecutiveUnproductiveCount = 0;
  const recoveryEngine = window.__BA_RecoveryEngine
    ? new window.__BA_RecoveryEngine()
    : { reset(){}, detectLoop(){ return { isLoop: false }; }, diagnose(){ return {}; }, evaluateNextStep(){ return { shouldHalt: false, userMessage: '' }; }, recordSuccess(){} };
  const taskMemory = window.__BA_TaskMemory
    ? new window.__BA_TaskMemory()
    : { reset(){}, recordPageVisit(){}, recordAttempt(){}, recordResult(){}, recordUserIntervention(){}, recordConfirmation(){}, updateSubgoal(){}, reconcileWithLiveState(){}, getSummary(){ return {}; }, formatContext(){ return ''; } };

  addMessage('agent', "Got it — analyzing the current page with local privacy scan.");

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    // ── Phase 1: OBSERVE ──────────────────────────────────────────────────
    agentController.beginObserving();
    addMessage('system', step === 0 ? 'Analyzing page & redacting PII…' : `Step ${step + 1}: Re-checking page state…`);

    let observation;
    try {
      observation = await analyzeCurrentPage();
    } catch (err) {
      agentController.markFailed(err);
      showError(`Page analysis failed: ${err.message}`);
      return;
    }

    // Handle unsupported initial page (e.g. chrome://newtab, about:blank, chrome://settings)
    if (observation.isUnsupportedScheme) {
      const navTarget = (typeof window !== 'undefined' && window.__BA_TaskManager?.resolveNavigationUrl)
        ? window.__BA_TaskManager.resolveNavigationUrl(task)
        : null;

      if (navTarget && navTarget.url) {
        addMessage('system', `Initial page (${observation.url}) is an internal browser page. Navigating to ${navTarget.url} to execute task…`);
        agentController.beginPlanning();
        agentController.beginExecuting({ action: 'navigate', value: navTarget.url });

        await sendMessage({
          type: 'AGENT_ACTION',
          action: 'navigate',
          args: [navTarget.url]
        });

        addMessage('system', 'Waiting for destination page to load…');
        await new Promise(r => setTimeout(r, 2500));

        // Reset state & memory so the destination page receives a clean, fresh observation
        previousPageState = null;
        taskMemory.reset();
        continue;
      } else {
        const msg = `The browser is currently on an internal page (${observation.url}) where content scripts cannot run. Please navigate to a normal webpage or specify a destination website in your task (e.g. "Open LeetCode...").`;
        addMessage('agent', msg);
        agentController.markCompleted();
        return;
      }
    }

    const { extraction, redactedDataUrl } = observation;

    addMessage(
      'agent',
      `Identified ${extraction.counts.interactiveElements} interactive elements and ${extraction.counts.sensitiveItems} sensitive item(s).`,
      { sensitiveItems: extraction.sensitiveItems }
    );

    // ── Phase 2: UNDERSTAND CURRENT STATE ─────────────────────────────────
    agentController.beginUnderstanding(extraction);
    const currentState = window.__BA_StateDiffEngine.captureState(extraction);
    const stateDiff = window.__BA_StateDiffEngine.computeDiff(previousPageState, currentState);
    const userInteractions = Array.isArray(extraction.userInteractions) ? extraction.userInteractions : [];

    // Reconcile task memory against live DOM state (Live DOM = Truth, History = Context)
    taskMemory.reconcileWithLiveState(extraction.elements, extraction.url, extraction.pageContext);

    // If state changes occurred since last step, show a clean summary
    if (step > 0) {
      const diffBullets = window.__BA_StateDiffEngine.formatDiffSummary(stateDiff);
      if (diffBullets.length > 0) {
        addMessage('system', `Page progression:\n${diffBullets.map(b => `• ${b}`).join('\n')}`);
      }
    }

    // Reconcile any newly populated fields in the current DOM into actionHistory
    reconcilePopulatedFields(extraction.elements, actionHistory);

    // At step 0, formulate and present initial hierarchical task plan
    if (step === 0) {
      agentController.taskManager.setTask(task, extraction.pageContext);
      addMessage('system', agentController.taskManager.formatPlanSummary());
    }

    // ── Phase 3: DETERMINE TASK PROGRESS & PLANNING ───────────────────────
    agentController.beginPlanning();
    const formSummary = window.__BA_FormAnalyzer
      ? await window.__BA_FormAnalyzer.analyzeForm(extraction.elements, privateDataStore)
      : null;

    // If user explicitly requested form completion AND all fields on page are already complete:
    const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
    if (isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0) {
      const submitEl = extraction.elements.find(el => {
        const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(el, el.selector);
        return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
      });
      if (submitEl) {
        agentController.waitForConfirmation();
        await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
        return;
      }
    }

    const mode = getSelectedMode();

    // ── Phase 4: WAITING FOR REASONER ─────────────────────────────────────
    agentController.waitForReasoner();
    let decision;
    try {
      decision = await agentBackend.decideNextAction({
        task,
        redactedScreenshotDataUrl: redactedDataUrl,
        elements: extraction.elements,
        viewport: extraction.viewport,
        history: actionHistory,
        pageUrl: extraction.url,
        sensitiveItems: extraction.sensitiveItems,
        mode,
        stateDiff,
        userInteractions,
        formSummary,
        pageContext: extraction.pageContext,
        taskPlan: agentController.taskManager.getPlanSummary(),
        taskMemory: taskMemory.getSummary(),
      });
    } catch (err) {
      agentController.markFailed(err);
      showError(err.message);
      return;
    }

    // Advance previous page state tracker
    previousPageState = currentState;

    // Display contextual high-level suggestion if available and not repeatedly emitted
    const candidateSuggestion = decision.suggestion || (window.__BA_FormAnalyzer ? window.__BA_FormAnalyzer.deriveSuggestion({ formSummary, stateDiff, userInteractions, mode, step }) : null);
    if (candidateSuggestion && candidateSuggestion.message && candidateSuggestion.message !== lastRenderedSuggestion) {
      lastRenderedSuggestion = candidateSuggestion.message;
      addMessage('suggestion', candidateSuggestion.message, { badge: candidateSuggestion.type });
    }

    // ── Phase 5: VALIDATING ACTION ────────────────────────────────────────
    agentController.beginValidating();
    taskMemory.recordAttempt(decision);

    // 5A: Comprehensive Loop Detection (A->A->A, stagnant scroll, navigation loop, oscillation)
    const loopResult = recoveryEngine.detectLoop(decision, stateDiff, extraction.url);
    if (loopResult.isLoop) {
      console.warn(`[popup] Loop detected (${loopResult.type}):`, loopResult.description);
      agentController.triggerReplanning(`Loop detected: ${loopResult.description}`);
      agentController.taskManager.replan(`Loop detected: ${loopResult.description}`, extraction.pageContext);
      addMessage('system', `⚠️ ${loopResult.description} Pausing automated execution.`);
      addMessage('agent', `I detected a repetitive execution pattern: ${loopResult.description}. Please review the page or guide me.`);
      agentController.waitForUser();
      return;
    }

    // 5B: Target Pre-Validation & Intelligent Diagnosis
    const isTargeted = ['click', 'type', 'fill', 'clear', 'select', 'check', 'uncheck', 'radio', 'hover', 'focus', 'fill_from_local'].includes(decision.action);
    if (isTargeted) {
      const targetEl = findElementByTarget(decision.targetSelector, decision.elementId, extraction.elements);
      const diagnosis = recoveryEngine.diagnose({
        decision,
        targetEl,
        liveElements: extraction.elements,
        pageContext: extraction.pageContext,
        currentUrl: extraction.url
      });

      // If intended state change already occurred, mark and advance smoothly
      if (diagnosis.cause === 'INTENDED_CHANGE_ALREADY_DONE') {
        addMessage('system', `✓ ${diagnosis.message}`);
        actionHistory.push({
          action: decision.action,
          targetSelector: decision.targetSelector,
          elementId: decision.elementId,
          result: { success: true, outcome: 'SUCCEEDED', note: 'already_done' }
        });
        await delay(SETTLE_DELAY_MS);
        continue;
      }

      // If target element disappeared or is unmounted
      if (!targetEl && decision.targetSelector) {
        console.warn(`[popup] Stale selector rejected before execution: "${decision.targetSelector}". Target not in current DOM.`);
        const evalResult = recoveryEngine.evaluateNextStep(diagnosis);
        agentController.triggerReplanning(diagnosis.message);
        agentController.taskManager.replan(diagnosis.message, extraction.pageContext);
        actionHistory.push({
          action: decision.action,
          targetSelector: decision.targetSelector,
          elementId: decision.elementId,
          result: { success: false, reason: 'target_disappeared', outcome: 'TARGET_DISAPPEARED' }
        });

        if (evalResult.shouldHalt) {
          addMessage('system', `⚠️ Bounded failure limit reached on missing target.`);
          addMessage('agent', evalResult.userMessage);
          agentController.waitForUser();
          return;
        } else {
          addMessage('system', `⚠️ Target element "${decision.targetSelector}" is not present in live DOM. Re-planning…`);
          await delay(SETTLE_DELAY_MS);
          continue;
        }
      }
    }

    if (decision.action === 'done') {
      agentController.taskManager.updateProgress({ action: 'done', outcome: 'TASK_COMPLETED', verified: true, plan: decision.plan });
      const planSummary = agentController.taskManager.getPlanSummary();
      const gatheredKeys = Object.keys(planSummary.gatheredInformation || {});
      const infoMsg = gatheredKeys.length > 0
        ? `\n\n**Gathered Findings:**\n${gatheredKeys.map(k => `• ${k}: ${planSummary.gatheredInformation[k]}`).join('\n')}`
        : '';
      addMessage('agent', `🎉 Task completed! ${decision.reasoning || ''}${infoMsg}`);
      agentController.markCompleted();
      return;
    }

    if (decision.action === 'notify_submit') {
      const targetEl = findElementByTarget(decision.targetSelector, decision.elementId, extraction.elements);
      await authorizeAndExecuteConsequential(targetEl, { action: 'click', elementId: decision.elementId, targetSelector: decision.targetSelector }, actionHistory, taskMemory, agentController, { pageUrl: extraction.url, taskInstruction: task });
      return;
    }

    if (decision.action === 'replan') {
      console.warn(`[popup] Replan requested: ${decision.value || 'Re-evaluating page'}`);
      agentController.triggerReplanning(decision.value || 'Reasoner requested replan');
      agentController.taskManager.replan(decision.value || 'Reasoner requested replan', extraction?.pageContext);
      addMessage('system', `Re-evaluating page state:\n${agentController.taskManager.formatPlanSummary()}`);
      actionHistory.push({
        action: 'replan',
        elementId: decision.elementId,
        targetSelector: decision.targetSelector,
        result: { success: true, outcome: 'REPLANNING' }
      });
      await delay(SETTLE_DELAY_MS);
      continue;
    }

    if (decision.action === 'skip_filled') {
      console.log(`[popup] Skipping field ${decision.targetSelector || decision.elementId} — already filled in DOM.`);
      actionHistory.push({
        action: 'fill',
        elementId: decision.elementId,
        targetSelector: decision.targetSelector,
        value: '[ALREADY_POPULATED]',
        result: { success: true, skippedAlreadyFilled: true }
      });
      continue;
    }

    if (decision.action === 'wait') {
      addMessage('system', 'Backend requested wait — allowing page to settle…');
      await delay(SETTLE_DELAY_MS * 2);
      actionHistory.push({ action: 'wait', result: 'waited' });
      continue;
    }

    // ── Phase 6: EXECUTE & HANDLE SPECIALIZED ACTIONS ─────────────────────
    if (decision.action === 'ask_user') {
      const firstField = Array.isArray(decision.fields) ? decision.fields[0] : null;
      const targetEl = findElementByTarget(firstField?.targetSelector || decision.targetSelector, firstField?.elementId ?? decision.elementId, extraction.elements);
      const targetElId = targetEl?.id ?? firstField?.elementId ?? decision.elementId;

      // Defensive guard: Check if target field is ALREADY populated in current DOM
      if (targetEl && isElementPopulated(targetEl)) {
        console.log(`[popup] Target field "${firstField?.fieldName || firstField?.label || decision.targetSelector}" is ALREADY populated in DOM. Skipping HITL prompt.`);
        actionHistory.push({
          action: 'fill',
          elementId: targetElId,
          targetSelector: targetEl?.selector || firstField?.targetSelector || decision.targetSelector,
          fieldName: firstField?.fieldName || firstField?.label,
          value: '[ALREADY_POPULATED]',
          result: { success: true, skippedAlreadyFilled: true }
        });

        const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
        if (isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.emptyFields === 0) {
          const submitEl = extraction.elements.find(el => {
            const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(el, el.selector);
            return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
          });
          if (submitEl) {
            agentController.waitForConfirmation();
            await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
            return;
          }
        }

        continue;
      }

      agentController.waitForUser(decision.fields);

      // Formulate generalized HITL request with the 4 mandatory points:
      // 1. Why blocked. 2. User action required. 3. Target context. 4. Next agent step.
      const hitlOptions = decision.hitlRequest || {
        category: firstField ? 'MISSING_INFO' : 'CLARIFICATION',
        title: firstField ? `Provide "${firstField.fieldName || firstField.label || 'Information'}"` : 'Human Guidance Required',
        whyBlocked: decision.reasoning || (firstField ? `Required field "${firstField.fieldName || firstField.label}" is empty and not present in local store.` : 'Agent paused for human guidance.'),
        userActionRequired: firstField ? 'Please enter this value directly into the highlighted field on the webpage.' : 'Please perform the necessary action on the webpage or provide clarification.',
        nextStepPlan: 'Observe updated page, reconcile state mutations, re-plan from fresh DOM, and continue.',
        targetContext: targetEl?.selector || decision.targetSelector || (firstField?.fieldName || 'Webpage Context'),
        choices: decision.choices,
        needsTextInput: Boolean(!firstField && !decision.choices)
      };

      addMessage('agent', `👉 ${hitlOptions.userActionRequired}`);

      // Highlight target element on webpage if targeted
      if (targetElId != null) {
        try {
          await sendMessage({
            type: 'AGENT_ACTION',
            action: 'highlightField',
            args: [targetElId, firstField?.fieldName || firstField?.label || 'Target', hitlOptions.userActionRequired]
          });
        } catch (err) {
          console.warn('[popup] Failed to highlight target element on webpage:', err);
        }
      }

      // Wait for user to interact and click resume
      const hitlResponse = await waitForHitlIntervention(hitlOptions);

      // Clear on-page highlight guide
      try {
        await sendMessage({ type: 'AGENT_ACTION', action: 'clearHighlight', args: [] });
      } catch (_) {}

      // Record intervention in short-term memory
      if (firstField || decision.targetSelector) {
        taskMemory.recordUserIntervention(targetEl?.selector || decision.targetSelector || firstField?.fieldName, firstField?.fieldName || firstField?.label);
      }

      // ── POST-RESUME PROTOCOL: OBSERVE -> RECONCILE -> REPLAN -> CONTINUE ──
      addMessage('system', 'User resumed — re-observing live page state…');
      agentController.beginObserving();

      let postResumeExtraction;
      try {
        const freshAnalysis = await analyzeCurrentPage();
        postResumeExtraction = freshAnalysis.extraction;
      } catch (_) {}

      const currentElements = postResumeExtraction ? postResumeExtraction.elements : extraction.elements;
      const currentUrl = postResumeExtraction ? postResumeExtraction.url : extraction.url;
      const currentPageContext = postResumeExtraction ? postResumeExtraction.pageContext : extraction.pageContext;

      // RECONCILE
      reconcilePopulatedFields(currentElements, actionHistory);
      taskMemory.reconcileWithLiveState(currentElements, currentUrl, currentPageContext);

      // REPLAN
      agentController.triggerReplanning('Human intervention completed; fresh DOM captured');
      agentController.taskManager.replan('User intervention completed', currentPageContext);

      try { agentController.submitUserInfo({}); } catch (_) {}

      const postResumeSummary = window.__BA_FormAnalyzer 
        ? await window.__BA_FormAnalyzer.analyzeForm(currentElements, privateDataStore)
        : null;

      if (postResumeSummary && postResumeSummary.formDetected && postResumeSummary.emptyFields === 0) {
        const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
        if (isExplicitFormTask) {
          agentController.waitForConfirmation();
          await handleFormCompletionGate(currentElements, task, actionHistory);
          return;
        }
      }

      addMessage('system', 'Live page reconciled — re-planning from current state…');
      await delay(SETTLE_DELAY_MS);
      continue;
    }

    // ── Local Private Store Form Fill (Complete Mode) ──────────────────────
    if (decision.action === 'fill_from_local') {
      const el = findElementByTarget(decision.targetSelector, decision.elementId, extraction.elements);
      const targetElId = el?.id ?? decision.elementId;

      if (isElementPopulated(el)) {
        console.log(`[popup] fill_from_local target (${el?.selector || decision.targetSelector}) is ALREADY populated in DOM. Skipping.`);
        actionHistory.push({
          action: 'fill',
          elementId: targetElId,
          targetSelector: el?.selector || decision.targetSelector,
          fieldName: el?.text || el?.ariaLabel || el?.placeholder,
          value: '[ALREADY_POPULATED]',
          result: { success: true, skippedAlreadyFilled: true }
        });

        const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
        if (isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.emptyFields === 0) {
          const submitEl = extraction.elements.find(e => {
            const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(e, e.selector);
            return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
          });
          if (submitEl) {
            agentController.waitForConfirmation();
            await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
            return;
          }
        }

        continue;
      }

      const match = el ? window.__BA_FieldMatcher.matchElement(el) : { matched: false, key: null };
      const hasKey = (match.matched && match.key) ? await privateDataStore.has(match.key) : false;
      const localVal = hasKey ? await privateDataStore.get(match.key) : null;
      const isActuallyAvailable = window.__BA_PrivateDataStore ? window.__BA_PrivateDataStore.isValueAvailable(localVal) : (localVal !== null && localVal !== undefined && (typeof localVal !== 'string' || localVal.trim().length > 0));

      // IF MATCHED & STORED LOCALLY (NON-EMPTY): AUTO-FILL
      if (hasKey && isActuallyAvailable) {
        addMessage('agent', `Auto-filling "${findElementLabel(extraction.elements, targetElId)}" from local private data (${match.key})…`);
        agentController.beginExecuting(decision);

        let actionResponse;
        try {
          actionResponse = await sendMessage({
            type: 'AGENT_ACTION',
            action: 'type',
            args: [targetElId, localVal]
          });
        } catch (err) {
          console.warn('[popup] fill_from_local execution error:', err);
          agentController.triggerReplanning(`Execution error: ${err.message}`);
          actionHistory.push({
            action: 'fill_from_local',
            elementId: targetElId,
            targetSelector: decision.targetSelector,
            matchedKey: match.key,
            result: { success: false, reason: err.message }
          });
          await delay(SETTLE_DELAY_MS);
          continue;
        }

        // ── Phase 7: VERIFY ACTION ──────────────────────────────────────────
        agentController.beginVerifying(decision);
        const actionData = actionResponse?.data;
        const isSuccess = actionResponse?.ok && (actionData?.success !== false);

        actionHistory.push({
          action: 'fill',
          elementId: targetElId,
          targetSelector: el?.selector || decision.targetSelector,
          matchedKey: match.key,
          value: '[FILLED_FROM_LOCAL]',
          result: actionData || { success: isSuccess }
        });

        await delay(SETTLE_DELAY_MS * 1.5);
        continue;
      }

      // IF MISSING LOCALLY: FALL BACK TO HITL
      const fallbackAction = agentBackend.buildAskUserAction(el, targetElId, decision.targetSelector);
      agentController.waitForUser(fallbackAction.fields);

      const firstField = fallbackAction.fields[0];
      const nameText = firstField?.fieldName || firstField?.label || 'required field';

      addMessage('agent', `👉 Missing local data for "${nameText}" on the webpage — please type your value directly into the highlighted field.`);

      if (targetElId != null) {
        try {
          await sendMessage({
            type: 'AGENT_ACTION',
            action: 'highlightField',
            args: [targetElId, firstField.fieldName || firstField.label, firstField.expectedValue || '']
          });
        } catch (err) {
          console.warn('[popup] Failed to highlight target element on webpage:', err);
        }
      }

      await waitForUserInput(fallbackAction.fields);

      try {
        await sendMessage({ type: 'AGENT_ACTION', action: 'clearHighlight', args: [] });
      } catch (_) {}

      agentController.beginObserving();
      let postResumeExtraction;
      try {
        const freshAnalysis = await analyzeCurrentPage();
        postResumeExtraction = freshAnalysis.extraction;
      } catch (_) {}

      const currentElements = postResumeExtraction ? postResumeExtraction.elements : extraction.elements;
      reconcilePopulatedFields(currentElements, actionHistory);

      try { agentController.submitUserInfo({}); } catch (_) {}

      const postResumeSummary = window.__BA_FormAnalyzer 
        ? await window.__BA_FormAnalyzer.analyzeForm(currentElements, privateDataStore)
        : null;

      const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
      if (isExplicitFormTask && postResumeSummary && postResumeSummary.formDetected && postResumeSummary.emptyFields === 0) {
        const submitEl = currentElements.find(e => {
          const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(e, e.selector);
          return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
        });
        if (submitEl) {
          agentController.waitForConfirmation();
          await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
          return;
        }
      }

      addMessage('system', 'Input received — re-scanning page and continuing task…');
      await delay(SETTLE_DELAY_MS);
      continue;
    }

    // ── CONSEQUENTIAL ACTION GATE CHECK ON TARGET CLICK ──────────────────────
    if (decision.action === 'click') {
      const targetEl = findElementByTarget(decision.targetSelector, decision.elementId, extraction.elements);
      const isConsequential = window.__BA_ConsequentialActionDetector?.isConsequentialElement(targetEl, decision.targetSelector, {
        pageUrl: extraction.url,
        taskInstruction: task,
        pageContext: extraction.pageContext,
        surroundingText: targetEl?.surroundingText
      });
      if (isConsequential && isConsequential.isConsequential) {
        await authorizeAndExecuteConsequential(targetEl, decision, actionHistory, taskMemory, agentController, {
          pageUrl: extraction.url,
          taskInstruction: task,
          pageContext: extraction.pageContext
        });
        return;
      }
    }

    // ── Phase 6: EXECUTE NATIVE ACTION (click / type / select / scroll) ───────
    addMessage('agent', describeAction(decision, extraction.elements));
    agentController.beginExecuting(decision);

    let actionResponse;
    try {
      actionResponse = await sendMessage({
        type: 'AGENT_ACTION',
        action: decision.action,
        args: buildActionArgs(decision)
      });
    } catch (err) {
      console.warn(`[popup] Action execution error:`, err);
      agentController.triggerReplanning(`Action execution error: ${err.message}`);
      actionHistory.push({
        action: decision.action,
        elementId: decision.elementId,
        targetSelector: decision.targetSelector,
        value: decision.action === 'type' ? '[REDACTED]' : decision.value,
        result: { success: false, reason: err.message, outcome: 'FAILED' }
      });
      consecutiveUnproductiveCount++;
      await delay(SETTLE_DELAY_MS);
      continue;
    }

    // ── Phase 7: VERIFY ACTION RESULT ─────────────────────────────────────
    agentController.beginVerifying(decision);
    const verification = window.__BA_ActionVerifier 
      ? window.__BA_ActionVerifier.verifyAction({ decision, actionResponse, stateDiff, extraction })
      : { outcome: 'SUCCEEDED', details: 'Verified', shouldReplan: false, verified: true };

    const actionData = actionResponse?.data;
    const isSuccess = actionResponse?.ok && (actionData?.success !== false);

    actionHistory.push({
      action: decision.action,
      elementId: decision.elementId,
      targetSelector: decision.targetSelector,
      value: decision.action === 'type' ? '[REDACTED]' : decision.value,
      result: actionData || { success: isSuccess, verification, outcome: verification.outcome }
    });

    agentController.taskManager.updateProgress({
      action: decision.action,
      outcome: verification.outcome,
      verified: isSuccess,
      plan: decision.plan,
      extractedData: actionData?.text ? { [decision.targetSelector || 'extracted_data']: actionData.text } : null
    });

    taskMemory.recordResult(decision, verification);
    taskMemory.updateSubgoal(agentController.taskManager.activeSubgoal?.description, decision.action === 'done' || verification.outcome === 'TASK_COMPLETED');

    if (verification.outcome === 'SUCCEEDED') {
      recoveryEngine.recordSuccess();
      consecutiveUnproductiveCount = 0;
    } else {
      consecutiveUnproductiveCount++;
      const diagnosis = recoveryEngine.diagnose({
        decision,
        targetEl: findElementByTarget(decision.targetSelector, decision.elementId, extraction.elements),
        liveElements: extraction.elements,
        pageContext: extraction.pageContext,
        actionResult: verification,
        currentUrl: extraction.url
      });
      const evalResult = recoveryEngine.evaluateNextStep(diagnosis);

      if (evalResult.shouldHalt) {
        console.warn(`[popup] Bounded failure limit reached: ${diagnosis.message}`);
        agentController.triggerReplanning(diagnosis.message);
        agentController.taskManager.replan(diagnosis.message, extraction?.pageContext);
        addMessage('system', `⚠️ Failure limit reached (${verification.outcome}). Pausing for safety.`);
        addMessage('agent', evalResult.userMessage);
        agentController.waitForUser();
        return;
      } else {
        console.warn(`[popup] Non-fatal action failure (${verification.outcome}): ${diagnosis.message}. Replanning…`);
        agentController.triggerReplanning(diagnosis.message);
        agentController.taskManager.replan(diagnosis.message, extraction?.pageContext);
      }
    }

    if (decision.action === 'scroll') {
      await delay(SETTLE_DELAY_MS + 250);
    } else {
      await delay(SETTLE_DELAY_MS);
    }
  }

  agentController.markStopped('Maximum steps reached');
  addMessage('system', `Stopped after ${MAX_AGENT_STEPS} steps to avoid an unbounded loop.`);
}

// ---------- Send button / input wiring ----------

async function handleSend() {
  if (isRunning) return;
  clearError();

  const task = els.taskInput.value.trim();
  if (!task) {
    showError('Please describe a task first.');
    return;
  }

  // If user prompt explicitly requests auto-completion / stored information, activate Complete Mode
  if (/(complete|fill).*(using|from|with).*(stored|local|my\s+info|private|profile)/i.test(task) ||
      /complete automatically/i.test(task) ||
      /auto[- ]?fill/i.test(task)) {
    setAgentMode('complete');
  }

  addMessage('user', task);
  els.taskInput.value = '';
  els.taskInput.style.height = 'auto';
  isRunning = true;
  els.sendBtn.disabled = true;
  els.taskInput.disabled = true;

  try {
    await runAgentLoop(task);
  } catch (err) {
    showError(err.message || String(err));
    agentController.markError(err);
  } finally {
    isRunning = false;
    els.sendBtn.disabled = false;
    els.taskInput.disabled = false;
    els.taskInput.focus();
  }
}

els.sendBtn.addEventListener('click', handleSend);
els.taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// Auto-adjust textarea height dynamically
els.taskInput.addEventListener('input', () => {
  els.taskInput.style.height = 'auto';
  els.taskInput.style.height = Math.min(els.taskInput.scrollHeight, 110) + 'px';
});

// Close the detached popup window when the user clicks the × button.
els.closeBtn.addEventListener('click', () => window.close());

initSettings();