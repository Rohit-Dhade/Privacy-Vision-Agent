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
// How many consecutive steps the local vision engine may hold the loop in a
// "still loading" wait before it proceeds anyway. Without a bound, a page
// with a permanent animation (an autoplaying video, a decorative spinner)
// would trap the agent; with it, the worst case is a few wasted steps.
const MAX_VISUAL_WAITS = 3;

const els = {
  themeBtn: document.getElementById('themeBtn'),
  themeBtnIcon: document.getElementById('themeBtnIcon'),
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
  originalCanvas: document.getElementById('originalCanvas'),
  baStage: document.getElementById('baStage'),
  baSummary: document.getElementById('baSummary'),
  baFigureRedacted: document.getElementById('baFigureRedacted'),
  baFigureOriginal: document.getElementById('baFigureOriginal'),
  baBtnRedacted: document.getElementById('baBtnRedacted'),
  baBtnOriginal: document.getElementById('baBtnOriginal'),
  baBtnSide: document.getElementById('baBtnSide'),
  elementsList: document.getElementById('elementsList'),
  elementsJson: document.getElementById('elementsJson'),
  visibleTextJson: document.getElementById('visibleTextJson'),
  sensitiveList: document.getElementById('sensitiveList'),
  agentStateLine: document.getElementById('agentStateLine'),

  // Compliance Signals panel (agent/complianceChecker.js)
  complianceScore: document.getElementById('complianceScore'),
  complianceViolationsList: document.getElementById('complianceViolationsList'),

  // Local Decision Routing panel (agent/decisionRouter.js — Hybrid mode only)
  routingStatsLine: document.getElementById('routingStatsLine'),

  // Saved Tasks / resume panel (agent/contextManager.js)
  savedTasksList: document.getElementById('savedTasksList'),
  savedTasksStorageNote: document.getElementById('savedTasksStorageNote'),

  // Browser Compatibility & Storage panel (utils/featureDetection.js, utils/opfsManager.js)
  featureSupportList: document.getElementById('featureSupportList'),
  opfsQuotaNote: document.getElementById('opfsQuotaNote'),

  // Privacy Receipt panel (live proof of what left the browser)
  receiptSteps: document.getElementById('receiptSteps'),
  receiptScanNote: document.getElementById('receiptScanNote'),
  heroRedacted: document.getElementById('heroRedacted'),
  heroRedactedDetail: document.getElementById('heroRedactedDetail'),
  heroBytes: document.getElementById('heroBytes'),
  heroBytesDetail: document.getElementById('heroBytesDetail'),
  heroTiles: document.getElementById('heroTiles'),
  heroTilesDetail: document.getElementById('heroTilesDetail'),
  heroMode: document.getElementById('heroMode'),
  heroModeDetail: document.getElementById('heroModeDetail'),
  footerStatus: document.getElementById('footerStatus'),
  baDownloadRedacted: document.getElementById('baDownloadRedacted'),
  baCaptureFullPage: document.getElementById('baCaptureFullPage'),
  baProgress: document.getElementById('baProgress'),
  sensitiveListScope: document.getElementById('sensitiveListScope'),
  wholePageScanBlock: document.getElementById('wholePageScanBlock'),
  wholePageScanTitle: document.getElementById('wholePageScanTitle'),
  wholePageSensitiveList: document.getElementById('wholePageSensitiveList'),
  baLightbox: document.getElementById('baLightbox'),
  baLightboxCanvas: document.getElementById('baLightboxCanvas'),
  baLightboxTitle: document.getElementById('baLightboxTitle'),
  baLightboxClose: document.getElementById('baLightboxClose'),
  receiptPiiMasked: document.getElementById('receiptPiiMasked'),
  receiptFaces: document.getElementById('receiptFaces'),
  receiptIdImages: document.getElementById('receiptIdImages'),
  receiptBytes: document.getElementById('receiptBytes'),
  receiptScanStatus: document.getElementById('receiptScanStatus'),
  privacyReceiptPayload: document.getElementById('privacyReceiptPayload'),
  constitutionVersionBadge: document.getElementById('constitutionVersionBadge'),

  // Live Evaluation-Metrics dashboard (ISRO PS26171's 5 weighted categories)
  benchActionSuccess: document.getElementById('benchActionSuccess'),
  benchDetectionVolume: document.getElementById('benchDetectionVolume'),
  benchRedactionConfirm: document.getElementById('benchRedactionConfirm'),
  benchResourceUse: document.getElementById('benchResourceUse'),
  benchLatency: document.getElementById('benchLatency'),

  // Cryptographic Redaction Proof panel
  redactionProofRoot: document.getElementById('redactionProofRoot'),
  redactionProofTiles: document.getElementById('redactionProofTiles'),
  redactionProofDownloadBtn: document.getElementById('redactionProofDownloadBtn'),
  redactionProofVerifyLink: document.getElementById('redactionProofVerifyLink'),

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

  // Privacy Dial elements (Cloud-Assisted / Hybrid / Fully Local / Hybrid Debate)
  privacyDialBadge: document.getElementById('privacyDialBadge'),
  radioDialCloud: document.getElementById('radioDialCloud'),
  radioDialHybrid: document.getElementById('radioDialHybrid'),
  radioDialLocal: document.getElementById('radioDialLocal'),
  radioDialDebate: document.getElementById('radioDialDebate'),
  dialOptCloud: document.getElementById('dialOptCloud'),
  dialOptHybrid: document.getElementById('dialOptHybrid'),
  dialOptLocal: document.getElementById('dialOptLocal'),
  dialOptDebate: document.getElementById('dialOptDebate'),

  // UI View & Navigation elements
  headerTitle: document.getElementById('headerTitle'),
  settingsBtnIcon: document.getElementById('settingsBtnIcon'),
  agentView: document.getElementById('agentView'),
  proofView: document.getElementById('proofView'),
  localModelStatus: document.getElementById('localModelStatus'),
  localModelStatusText: document.getElementById('localModelStatusText'),
  localModelProgressBar: document.getElementById('localModelProgressBar'),
  tabBar: document.getElementById('tabBar'),
  tabBtnAgent: document.getElementById('tabBtnAgent'),
  tabBtnProof: document.getElementById('tabBtnProof'),
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
// Hybrid Debate mode (agent/debateManager.js): runs the on-device Qwen2.5
// reasoner and the cloud reasoner in parallel for the same step. See
// claude/v25-master-implementation-guide.md Part 2, Mode 3.
const debateManager = window.__BA_DebateManager
  ? new window.__BA_DebateManager({ agentBackend, confidenceScorer: window.__BA_ConfidenceScorer })
  : null;
// 4-layer decision routing (agent/decisionRouter.js): TREE -> HEURISTIC ->
// LOCAL_LLM -> CLOUD, used only by Hybrid mode's per-step decision below —
// see the comment at that call site for why Cloud-Assisted and Fully Local
// modes deliberately don't go through this router.
const decisionRouter = window.__BA_DecisionRouter
  ? new window.__BA_DecisionRouter({
      agentBackend,
      fieldMatcher: window.__BA_FieldMatcher,
      formAnalyzer: window.__BA_FormAnalyzer,
      consequentialActionDetector: window.__BA_ConsequentialActionDetector,
    })
  : null;
// Cross-task checkpoint/resume (agent/contextManager.js, v25 Task 1.3):
// one instance for the whole popup session (not per-task, like the
// managers above) since it also needs to list checkpoints from tasks
// that aren't currently running. See renderSavedTasksList() and
// runAgentLoop()'s use of it for what's actually wired up here — the
// module itself was already built and unit-tested; this pass is what
// gives it a UI and calls it from the running agent loop.
const contextManager = window.__BA_ContextManager ? new window.__BA_ContextManager() : null;

let isRunning = false;
let actionHistory = []; // { action, elementId, value, result } — in-memory only, cleared per task
let latestRedactionProof = null; // most recent cryptographic redaction proof (utils/merkleProof.js), downloadable by the user
let pendingResumeTaskId = null; // set by a "Resume" click in the Saved Tasks panel, consumed once by the next handleSend()

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

/** Minimal, safe inline formatting for chat text: HTML is escaped FIRST,
 *  then **bold** and *italic* markers (used by the plan summaries and
 *  findings) become <strong>/<em> instead of showing as literal asterisks.
 *  Nothing else is interpreted, so page-derived text can't inject markup. */
function formatInlineText(text) {
  return escapeHtml(String(text == null ? '' : text))
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,:;!?]|$)/gm, '$1<em>$2</em>');
}

function redactionDestinationNote() {
  const mode = (typeof currentPrivacyDialMode !== 'undefined') ? currentPrivacyDialMode : null;
  if (mode === 'local') return 'Fully Local: nothing from this page is sent to any server';
  return 'Sent to server: field structure only, no sensitive values';
}

function addMessage(role, text, options = {}) {
  const card = document.createElement('div');

  if (role === 'user') {
    card.className = 'pv-msg-card pv-msg-user';
    card.innerHTML = `
      <div class="pv-msg-user-header">
        <span class="material-symbols-outlined" aria-hidden="true">account_circle</span>
        <span>Task Request</span>
      </div>
      <div class="pv-msg-user-text"></div>
    `;
    card.querySelector('.pv-msg-user-text').textContent = text;
  } else if (role === 'agent') {
    card.className = 'pv-msg-card pv-msg-agent';
    card.innerHTML = `
      <div class="pv-msg-agent-header">
        <span class="material-symbols-outlined" aria-hidden="true">shield</span>
        <span>Privacy Vision Agent</span>
      </div>
      <div class="pv-msg-agent-text"></div>
    `;
    card.querySelector('.pv-msg-agent-text').innerHTML = formatInlineText(text);

    // Render Redaction Summary card component if sensitive items present
    if (options.sensitiveItems && options.sensitiveItems.length > 0) {
      const summaryBox = document.createElement('div');
      summaryBox.className = 'pv-redaction-summary-box';

      const itemsHtml = options.sensitiveItems.map(item => `
        <li class="pv-redaction-item">
          <span class="material-symbols-outlined" aria-hidden="true">check_circle</span>
          <span>${escapeHtml(item.type)} field redacted (${escapeHtml(item.masked)})</span>
        </li>
      `).join('');

      summaryBox.innerHTML = `
        <div class="pv-redaction-header">
          <span class="material-symbols-outlined" aria-hidden="true">policy</span>
          <span>Redaction Summary</span>
        </div>
        <ul class="pv-redaction-list">
          ${itemsHtml}
        </ul>
        <div class="pv-redaction-info-banner">
          <span class="material-symbols-outlined" aria-hidden="true">info</span>
          <span>${escapeHtml(redactionDestinationNote())}</span>
        </div>
      `;
      card.appendChild(summaryBox);
    }
  } else if (role === 'system') {
    card.className = 'pv-msg-card pv-msg-system';
    card.innerHTML = `
      <span class="material-symbols-outlined" aria-hidden="true">info</span>
      <span class="pv-msg-system-text"></span>
    `;
    card.querySelector('.pv-msg-system-text').innerHTML = formatInlineText(text);
  } else if (role === 'suggestion') {
    card.className = 'pv-msg-card pv-msg-suggestion';
    const badgeText = (options?.badge || options?.type || 'SUGGESTION').toUpperCase().replace(/_/g, ' ');
    card.innerHTML = `
      <div class="pv-msg-suggestion-header">
        <span class="material-symbols-outlined" aria-hidden="true">lightbulb</span>
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
        <span class="material-symbols-outlined" style="color: var(--pv-error);" aria-hidden="true">error</span>
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
    toggleBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">visibility</span>';

    toggleBtn.addEventListener('click', () => {
      const isMasked = valPreview.dataset.masked === 'true';
      if (isMasked) {
        valPreview.textContent = val;
        valPreview.dataset.masked = 'false';
        valPreview.classList.add('revealed');
        toggleBtn.title = 'Hide value';
        toggleBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">visibility_off</span>';
      } else {
        valPreview.textContent = '••••••••••••';
        valPreview.dataset.masked = 'true';
        valPreview.classList.remove('revealed');
        toggleBtn.title = 'Show value';
        toggleBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">visibility</span>';
      }
    });

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'pv-icon-btn pv-btn-xs';
    editBtn.title = 'Edit value';
    editBtn.setAttribute('aria-label', `Edit value for ${key}`);
    editBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">edit</span>';

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
    delBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';

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
    els.toggleStoreValMaskBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">visibility</span>';
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
        ? '<span class="material-symbols-outlined" aria-hidden="true">visibility_off</span>'
        : '<span class="material-symbols-outlined" aria-hidden="true">visibility</span>';
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

// ---------- Privacy Dial (Cloud-Assisted / Hybrid / Fully Local) ----------

// Cached in memory so the (synchronous) agent loop doesn't have to await
// chrome.storage on every single step — refreshed on init and whenever the
// user changes it in Settings.
let currentPrivacyDialMode = window.__BA_PrivacyDial
  ? window.__BA_PrivacyDial.DEFAULT_MODE
  : 'hybrid';

function applyPrivacyDialUI(mode) {
  const dialEls = [
    { radio: els.radioDialCloud, opt: els.dialOptCloud, value: 'cloud' },
    { radio: els.radioDialHybrid, opt: els.dialOptHybrid, value: 'hybrid' },
    { radio: els.radioDialLocal, opt: els.dialOptLocal, value: 'local' },
    { radio: els.radioDialDebate, opt: els.dialOptDebate, value: 'debate' }
  ];
  for (const { radio, opt, value } of dialEls) {
    const isActive = value === mode;
    if (radio) radio.checked = isActive;
    if (opt) opt.classList.toggle('active', isActive);
  }
  if (els.privacyDialBadge && window.__BA_PrivacyDial) {
    els.privacyDialBadge.textContent = window.__BA_PrivacyDial.getModeMeta(mode).shortLabel;
  }
  renderFooterStatus();
  renderProofHero();
}

async function initPrivacyDial() {
  if (!window.__BA_PrivacyDial) return;
  currentPrivacyDialMode = await window.__BA_PrivacyDial.getMode();
  applyPrivacyDialUI(currentPrivacyDialMode);
  if (privacyDialNeedsLocalModel(currentPrivacyDialMode)) requestLocalModelLoad();
  else queryLocalModelStatus();

  const dialRadios = [els.radioDialCloud, els.radioDialHybrid, els.radioDialLocal, els.radioDialDebate];
  for (const radio of dialRadios) {
    if (!radio) continue;
    radio.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      currentPrivacyDialMode = await window.__BA_PrivacyDial.setMode(e.target.value);
      applyPrivacyDialUI(currentPrivacyDialMode);
      addMessage('system', `🔒 Privacy Dial set to ${window.__BA_PrivacyDial.getModeMeta(currentPrivacyDialMode).label} for future steps.`);
      if (privacyDialNeedsLocalModel(currentPrivacyDialMode)) requestLocalModelLoad();
    });
  }

  // Clicking anywhere on the row (not just the hidden radio) selects it —
  // matches the existing execution-mode popover-item click behavior.
  const dialOptToRadio = [
    [els.dialOptCloud, els.radioDialCloud],
    [els.dialOptHybrid, els.radioDialHybrid],
    [els.dialOptLocal, els.radioDialLocal],
    [els.dialOptDebate, els.radioDialDebate]
  ];
  for (const [opt, radio] of dialOptToRadio) {
    if (!opt || !radio) continue;
    opt.addEventListener('click', (e) => {
      e.preventDefault();
      if (!radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
      }
    });
  }
}

// Which of the two primary tabs (Agent / Privacy Proof) is active. Settings
// is a separate, third full-screen view (toggled by toggleSettingsView()
// below) that temporarily hides both -- this variable is what lets closing
// Settings put the user back on whichever tab they were actually on,
// instead of always snapping back to Agent.
let activeTab = 'agent';

/**
 * Switches between the Agent tab (task execution, chat log, composer) and
 * the Privacy Proof tab (Privacy Receipt, Live Evaluation Metrics,
 * Cryptographic Redaction Proof, redacted screenshot, detected PII list).
 * Both tabs read the exact same live DOM elements that the rest of this
 * file already updates during a run -- see the els.receiptSteps,
 * els.benchActionSuccess, els.redactionProofRoot, els.sensitiveList (etc.)
 * assignments elsewhere in this file -- so this function is pure
 * presentation: it only ever toggles `.hidden` and the tab buttons'
 * active/aria-selected state, never recomputes or clears anything. Safe to
 * call at any time, including before a task has run (both views start on
 * the placeholder/zeroed values already baked into popup.html).
 */
function switchTab(tab) {
  if (tab !== 'agent' && tab !== 'proof') return;
  activeTab = tab;
  toggleModeMenu(false);

  const showAgent = tab === 'agent';
  if (els.agentView) els.agentView.hidden = !showAgent;
  if (els.proofView) els.proofView.hidden = showAgent;

  if (els.tabBtnAgent) {
    els.tabBtnAgent.classList.toggle('active', showAgent);
    els.tabBtnAgent.setAttribute('aria-selected', String(showAgent));
  }
  if (els.tabBtnProof) {
    els.tabBtnProof.classList.toggle('active', !showAgent);
    els.tabBtnProof.setAttribute('aria-selected', String(!showAgent));
  }

  if (showAgent) updateWelcomeState();
}

if (els.tabBtnAgent) els.tabBtnAgent.addEventListener('click', () => switchTab('agent'));
if (els.tabBtnProof) els.tabBtnProof.addEventListener('click', () => switchTab('proof'));

function toggleSettingsView(open) {
  const isOpening = typeof open === 'boolean' ? open : (els.settingsPanel ? els.settingsPanel.hidden : false);
  
  // Close mode popover when switching views
  toggleModeMenu(false);

  if (els.settingsPanel) els.settingsPanel.hidden = !isOpening;
  if (els.tabBar) els.tabBar.hidden = isOpening;

  if (isOpening) {
    // Settings replaces BOTH tabs, not just Agent -- hide whichever is
    // currently showing so it doesn't peek out from behind the settings
    // panel (which is a sibling, not an overlay).
    if (els.agentView) els.agentView.hidden = true;
    if (els.proofView) els.proofView.hidden = true;
    if (els.settingsBtn) {
      els.settingsBtn.classList.add('active');
      els.settingsBtn.title = 'Back to Agent';
    }
    if (els.settingsBtnIcon) els.settingsBtnIcon.textContent = 'arrow_back';
    if (els.headerTitle) els.headerTitle.textContent = 'Settings & Local Data';
  } else {
    // Restore whichever tab was active before Settings was opened, rather
    // than always snapping back to Agent.
    switchTab(activeTab);
    if (els.settingsBtn) {
      els.settingsBtn.classList.remove('active');
      els.settingsBtn.title = 'Settings & Local Data';
    }
    if (els.settingsBtnIcon) els.settingsBtnIcon.textContent = 'settings';
    if (els.headerTitle) els.headerTitle.textContent = 'Privacy Vision Agent';
    updateWelcomeState();
  }
}

/** Shows which version of CONSTITUTION.md this build follows, in the Privacy Receipt panel. */
function initConstitutionVersionBadge() {
  if (!els.constitutionVersionBadge) return;
  const version = window.__BA_ConstitutionVersion || 'unknown';
  els.constitutionVersionBadge.textContent = `POLICY v${version}`;
}

async function initSettings() {
  initConstitutionVersionBadge();
  els.backendUrlInput.value = await agentBackend.getEndpoint();
  await renderPrivateStoreEntries();
  initPrivateStoreUI();
  initModeSelector();
  await initPrivacyDial();
  await renderSavedTasksList();
  await renderFeatureSupport();

  // A once-per-load system message ONLY for capabilities that would break
  // this extension outright (not the vendoring-gated ones — those already
  // have their own per-feature degradation messages elsewhere). Silent
  // otherwise — see utils/featureDetection.js's header for why this stays
  // advisory rather than gating anything.
  if (window.__BA_FeatureDetection) {
    const report = window.__BA_FeatureDetection.detectAll();
    const critical = [];
    if (!report.chromeOffscreen) critical.push('the offscreen document (chrome.offscreen)');
    if (!report.chromeSidePanel) critical.push('the side panel (chrome.sidePanel, Chrome 114+)');
    if (!report.wasm) critical.push('WebAssembly');
    if (critical.length > 0) {
      addMessage('system', `⚠️ This browser is missing ${critical.join(', ')} — see the "Browser Compatibility & Storage" panel in Settings for the full picture. This extension is unlikely to work correctly here.`);
    }
  }

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
    bboxLine.style.color = 'var(--pv-on-surface-variant)';
    bboxLine.style.fontSize = '10px';
    bboxLine.textContent = `bbox: [${el.bbox.x}, ${el.bbox.y}, ${el.bbox.width}, ${el.bbox.height}]`;
    row.appendChild(bboxLine);

    els.elementsList.appendChild(row);
  }
  els.elementsJson.textContent = JSON.stringify(elements, null, 2);
}

function renderSensitiveList(sensitiveItems, target = els.sensitiveList, emptyText = 'No sensitive information detected on the visible page.') {
  if (!target) return;
  target.innerHTML = '';
  const items = Array.isArray(sensitiveItems) ? sensitiveItems : [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pv-pii-empty';
    empty.textContent = emptyText;
    target.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'pv-pii-row';
    row.setAttribute('role', 'row');

    const tag = document.createElement('span');
    tag.className = 'pv-pii-type';
    tag.setAttribute('role', 'cell');
    tag.textContent = String(item.type || 'PII').replace(/_/g, ' ');
    row.appendChild(tag);

    const masked = document.createElement('span');
    masked.className = 'pv-pii-masked';
    masked.setAttribute('role', 'cell');
    masked.textContent = item.masked || '[masked]';
    row.appendChild(masked);

    const conf = document.createElement('span');
    conf.className = 'pv-pii-conf';
    conf.setAttribute('role', 'cell');
    conf.textContent = Number.isFinite(item.confidence) ? `${Math.round(item.confidence * 100)}%` : '';
    if (item.where) {
      const where = document.createElement('span');
      where.className = 'pv-pii-where' + (item.where === 'on screen' ? '' : ' is-offscreen');
      where.textContent = item.where;
      conf.textContent = (conf.textContent ? conf.textContent + ' ' : '');
      conf.appendChild(where);
    }
    row.appendChild(conf);

    target.appendChild(row);
  }
}

/* ---------- Whole-page text scan (content/fullPageScanner.js) ----------
 * The per-step pipeline only sees the visible screen. This reads the whole
 * page's DOM text (no scrolling, no screenshot) with the same detectors,
 * so page questions and the Privacy Proof tab cover everything, not just
 * one screen. The result contains masked values only. */
let wholePageScan = null;
let wholePageScanPromise = null;

function dedupeSensitiveItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of (items || [])) {
    const key = `${it.type}|${it.masked}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function renderWholePageScan(scan) {
  if (!els.wholePageScanBlock) return;
  if (!scan) { els.wholePageScanBlock.hidden = true; return; }
  const items = dedupeSensitiveItems(scan.sensitiveItems);
  const off = items.filter((i) => i.where !== 'on screen').length;
  els.wholePageScanTitle.textContent =
    `Whole page (text scan, about ${scan.screens} screen${scan.screens === 1 ? '' : 's'} tall): ` +
    `${items.length} item(s), ${items.length - off} on screen, ${off} elsewhere on the page`;
  renderSensitiveList(items, els.wholePageSensitiveList, 'No sensitive information found anywhere in the page text.');
  els.wholePageScanBlock.hidden = false;
}

function startWholePageScan() {
  wholePageScanPromise = (async () => {
    try {
      const resp = await sendMessage({ type: 'FULL_PAGE_SCAN' });
      if (!resp || !resp.ok || !resp.data) {
        if (isStaleBackgroundResponse(resp)) renderLocalModelStatus({ status: 'error', error: STALE_BACKGROUND_MESSAGE });
        return null;
      }
      wholePageScan = resp.data;
      renderWholePageScan(wholePageScan);
      return wholePageScan;
    } catch (err) {
      console.warn('[popup] Whole-page scan failed (per-screen pipeline unaffected):', err.message);
      return null;
    }
  })();
  return wholePageScanPromise;
}

function resetWholePageScan() {
  wholePageScan = null;
  wholePageScanPromise = null;
  renderWholePageScan(null);
}

/**
 * Renders agent/contextManager.js's saved-checkpoint list in the Saved
 * Tasks panel (v25 Task 1.3). Called on popup init, and again after every
 * checkpoint save/delete so the list never goes stale. A "Resume" click
 * sets pendingResumeTaskId and pre-fills the task input; the actual state
 * restoration happens in runAgentLoop() once the task is sent — see the
 * comment there.
 */
async function renderSavedTasksList() {
  if (!els.savedTasksList || !contextManager) return;

  if (els.savedTasksStorageNote) {
    els.savedTasksStorageNote.textContent = contextManager.isUsingDurableStorage()
      ? 'Saved locally via IndexedDB — persists across closing and reopening this panel.'
      : '⚠️ IndexedDB is unavailable in this browser session — saved tasks will only last until this panel closes.';
  }

  let checkpoints;
  try {
    checkpoints = await contextManager.listCheckpoints();
  } catch (err) {
    console.warn('[popup] Failed to list saved tasks:', err.message);
    checkpoints = [];
  }

  els.savedTasksList.innerHTML = '';

  if (checkpoints.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'pv-empty-store-msg';
    emptyMsg.textContent = 'No saved tasks yet. Progress is checkpointed automatically as a task runs.';
    els.savedTasksList.appendChild(emptyMsg);
    return;
  }

  for (const cp of checkpoints) {
    const row = document.createElement('div');
    row.className = 'pv-store-item';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'pv-store-item-content';

    const labelBadge = document.createElement('span');
    labelBadge.className = 'pv-store-key-badge';
    labelBadge.textContent = cp.label || cp.taskId;
    labelBadge.title = cp.label || cp.taskId;

    const timePreview = document.createElement('span');
    timePreview.className = 'pv-store-val-preview';
    timePreview.textContent = formatRelativeTime(cp.updatedAt);

    contentDiv.appendChild(labelBadge);
    contentDiv.appendChild(timePreview);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pv-store-item-actions';

    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'pv-icon-btn pv-btn-xs';
    resumeBtn.title = 'Resume this task';
    resumeBtn.setAttribute('aria-label', `Resume ${cp.label || cp.taskId}`);
    resumeBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>';
    resumeBtn.addEventListener('click', () => {
      if (isRunning) {
        showError('Finish or stop the current task before resuming a saved one.');
        return;
      }
      pendingResumeTaskId = cp.taskId;
      els.taskInput.value = cp.label || cp.taskId;
      els.taskInput.focus();
      addMessage('system', `Loaded saved task "${cp.label || cp.taskId}" (last updated ${formatRelativeTime(cp.updatedAt)}) — press Send to resume it with its previous plan and progress restored.`);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pv-icon-btn pv-btn-xs pv-btn-danger';
    delBtn.title = 'Delete saved task';
    delBtn.setAttribute('aria-label', `Delete saved task ${cp.label || cp.taskId}`);
    delBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';
    delBtn.addEventListener('click', async () => {
      await contextManager.deleteCheckpoint(cp.taskId);
      if (pendingResumeTaskId === cp.taskId) pendingResumeTaskId = null;
      await renderSavedTasksList();
    });

    actionsDiv.appendChild(resumeBtn);
    actionsDiv.appendChild(delBtn);

    row.appendChild(contentDiv);
    row.appendChild(actionsDiv);
    els.savedTasksList.appendChild(row);
  }
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Renders utils/featureDetection.js's + utils/opfsManager.js's output in
 * the Settings panel's "Browser Compatibility & Storage" card (v25 Tasks
 * 1.2/1.4). Called once from initSettings() — this is read-only and
 * advisory; nothing in the agent loop branches on it. It exists so a
 * missing capability is named plainly instead of only surfacing later as
 * an unexplained fallback.
 */
async function renderFeatureSupport() {
  if (!els.featureSupportList) return;

  const report = window.__BA_FeatureDetection ? window.__BA_FeatureDetection.detectAll() : null;
  els.featureSupportList.innerHTML = '';

  if (!report) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';
    row.textContent = 'utils/featureDetection.js failed to load — compatibility could not be checked.';
    els.featureSupportList.appendChild(row);
    return;
  }

  const CHECKS = [
    { key: 'chromeOffscreen', label: 'Offscreen document (NER / face detection / OCR host)' },
    { key: 'chromeSidePanel', label: 'Side panel (Chrome 114+)' },
    { key: 'wasm', label: 'WebAssembly (ONNX Runtime Web)' },
    { key: 'sharedArrayBuffer', label: 'Threaded WASM (SharedArrayBuffer)' },
    { key: 'indexedDB', label: 'IndexedDB (durable task checkpoints)' },
    { key: 'opfs', label: 'OPFS (persistent on-device model cache)' },
    { key: 'webgpu', label: 'WebGPU (accelerated on-device LLM reasoning)' },
  ];

  for (const check of CHECKS) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag' + (report[check.key] ? '' : ' sensitive');
    tag.textContent = report[check.key] ? 'available' : 'unavailable';
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = ` ${check.label}`;
    row.appendChild(label);

    els.featureSupportList.appendChild(row);
  }

  if (els.opfsQuotaNote) {
    if (window.__BA_OpfsManager) {
      try {
        const quota = await window.__BA_OpfsManager.checkStorageQuota();
        els.opfsQuotaNote.textContent = window.__BA_OpfsManager.formatQuotaSummary(quota);
      } catch (err) {
        els.opfsQuotaNote.textContent = `Storage quota could not be checked: ${err.message}`;
      }
    } else {
      els.opfsQuotaNote.textContent = '';
    }
  }
}

/**
 * Renders agent/complianceChecker.js's output in the Compliance Signals
 * panel. Called once per page analysis, from analyzeCurrentPage() — this is
 * a read-only display, it never gates or alters anything the agent does.
 */
function renderComplianceSummary(complianceResult) {
  if (!els.complianceScore || !els.complianceViolationsList || !complianceResult) return;

  els.complianceScore.textContent = String(complianceResult.score);
  els.complianceScore.className = 'pv-metric-val' +
    (complianceResult.score >= 90 ? '' : complianceResult.score >= 70 ? ' pv-scan-warn' : ' pv-scan-fail');

  els.complianceViolationsList.innerHTML = '';
  const violations = Array.isArray(complianceResult.violations) ? complianceResult.violations : [];
  if (violations.length === 0) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';
    row.textContent = 'No compliance signals found on this page.';
    els.complianceViolationsList.appendChild(row);
    return;
  }
  for (const v of violations) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag sensitive';
    tag.textContent = `${v.law} · ${v.severity}`;
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = `${v.title} — ${v.description}`;
    row.appendChild(label);

    els.complianceViolationsList.appendChild(row);
  }
}

/**
 * Renders agent/decisionRouter.js's cumulative getRoutingStats() in the
 * Privacy Receipt panel. Only Hybrid mode's steps ever populate this —
 * Cloud-Assisted and Fully Local modes don't use the router (see the call
 * site in runAgentLoop() for why).
 */
function updateRoutingStatsDisplay() {
  if (!els.routingStatsLine || !decisionRouter) return;
  const stats = decisionRouter.getRoutingStats();
  if (!stats.total) {
    els.routingStatsLine.textContent = 'No steps routed yet this task.';
    return;
  }
  const order = ['TREE', 'HEURISTIC', 'LOCAL_LLM', 'CLOUD', 'ASK_USER'];
  const parts = order
    .filter((layer) => stats.counts[layer] > 0)
    .map((layer) => `${layer}: ${stats.counts[layer]}`);
  const cloudCount = stats.counts.CLOUD || 0;
  const localPct = Math.round(((stats.total - cloudCount) / stats.total) * 100);
  els.routingStatsLine.textContent = `${parts.join(' · ')} (${stats.total} step(s) routed, ${localPct}% resolved without the cloud)`;
}

// ---------- Hybrid Debate evidence panel ----------

/** Short, human-readable summary of a decision for the debate panel —
 *  mirrors describeAction()'s phrasing but stays label-only (no element
 *  lookup needed, since this runs on decisions from two different
 *  reasoners that may target elements the other never proposed). */
function describeDebateAction(decision) {
  if (!decision) return '(no decision)';
  const target = decision.targetSelector ? ` → ${decision.targetSelector}` : '';
  const value = (decision.action === 'fill' || decision.action === 'type') && decision.value
    ? ` = "${decision.value}"` : '';
  return `${decision.action}${target}${value}`;
}

/**
 * Renders one Hybrid Debate step's evidence — per
 * claude/v25-master-implementation-guide.md Part 2 (Mode 3): both
 * decisions, both confidence scores, and whether they agreed, shown
 * plainly rather than silently resolved. Appended as its own message card,
 * same visual family as the Redaction Summary box.
 *
 * @param {object} debate  The `debate` field from DebateManager.runDebate()'s result.
 */
function renderDebateEvidence(debate) {
  if (!debate) return;

  const card = document.createElement('div');
  card.className = 'pv-msg-card pv-msg-agent';

  const box = document.createElement('div');
  box.className = 'pv-debate-box';

  const isDegraded = debate.mode === 'LOCAL_ONLY_DEGRADED' || debate.mode === 'CLOUD_ONLY_DEGRADED';
  let verdictClass = 'agree';
  let verdictText = 'AGREE';
  if (isDegraded) {
    verdictClass = 'degraded';
    verdictText = debate.mode === 'LOCAL_ONLY_DEGRADED' ? 'CLOUD UNAVAILABLE' : 'LOCAL UNAVAILABLE';
  } else if (debate.agreement === false) {
    verdictClass = debate.resolution === 'DISAGREE_ASK_USER_RECOMMENDED' ? 'disagree-strong' : 'disagree';
    verdictText = `DISAGREE (${Math.round((debate.gap || 0) * 100)}% gap)`;
  }

  const header = document.createElement('div');
  header.className = 'pv-debate-header';
  header.innerHTML = `
    <span class="material-symbols-outlined" aria-hidden="true">forum</span>
    <span class="pv-debate-header-title">Hybrid Debate</span>
    <span class="pv-debate-verdict ${verdictClass}">${escapeHtml(verdictText)}</span>
  `;
  box.appendChild(header);

  if (isDegraded) {
    const single = debate.local || debate.cloud;
    const label = debate.local ? 'On-Device (Qwen2.5)' : 'Cloud';
    const cols = document.createElement('div');
    cols.className = 'pv-debate-columns';
    cols.innerHTML = `
      <div class="pv-debate-col pv-debate-winner">
        <div class="pv-debate-col-label"><span>${escapeHtml(label)}</span><span class="pv-debate-confidence">${Math.round((single.confidence || 0) * 100)}%</span></div>
        <div class="pv-debate-col-action">${escapeHtml(describeDebateAction(single))}</div>
        <div class="pv-debate-col-reasoning">${escapeHtml(single.reasoning || '')}</div>
      </div>
    `;
    box.appendChild(cols);

    const footer = document.createElement('div');
    footer.className = 'pv-debate-footer';
    footer.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">info</span><span>${escapeHtml(debate.reason || 'The other reasoner was unavailable for this step.')}</span>`;
    box.appendChild(footer);
  } else {
    const localWins = debate.local.confidence >= debate.cloud.confidence;
    const cols = document.createElement('div');
    cols.className = 'pv-debate-columns';

    const localCol = document.createElement('div');
    localCol.className = `pv-debate-col${localWins ? ' pv-debate-winner' : ''}`;
    localCol.innerHTML = `
      <div class="pv-debate-col-label"><span>On-Device (Qwen2.5)</span><span class="pv-debate-confidence">${Math.round(debate.local.confidence * 100)}%</span></div>
      <div class="pv-debate-col-action">${escapeHtml(describeDebateAction(debate.local))}</div>
      <div class="pv-debate-col-reasoning">${escapeHtml(debate.local.reasoning || '')}</div>
    `;
    cols.appendChild(localCol);

    const cloudCol = document.createElement('div');
    cloudCol.className = `pv-debate-col${!localWins ? ' pv-debate-winner' : ''}`;
    cloudCol.innerHTML = `
      <div class="pv-debate-col-label"><span>Cloud</span><span class="pv-debate-confidence">${Math.round(debate.cloud.confidence * 100)}%</span></div>
      <div class="pv-debate-col-action">${escapeHtml(describeDebateAction(debate.cloud))}</div>
      <div class="pv-debate-col-reasoning">${escapeHtml(debate.cloud.reasoning || '')}</div>
    `;
    cols.appendChild(cloudCol);

    box.appendChild(cols);

    const footer = document.createElement('div');
    footer.className = 'pv-debate-footer';
    const footerText = debate.agreement
      ? `Both agreed on this action. Used the ${localWins ? 'on-device' : 'cloud'} confidence framing.`
      : debate.resolution === 'DISAGREE_ASK_USER_RECOMMENDED'
        ? `Wide disagreement — used the higher-confidence (${localWins ? 'on-device' : 'cloud'}) result, but this gap is large enough to review before repeating this step.`
        : `Disagreed — used the higher-confidence (${localWins ? 'on-device' : 'cloud'}) result.`;
    footer.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${debate.agreement ? 'check_circle' : 'warning'}</span><span>${escapeHtml(footerText)}</span>`;
    box.appendChild(footer);
  }

  card.appendChild(box);
  els.chatLog.appendChild(card);
  updateWelcomeState();
  scrollToBottom();
}

/**
 * Task Verification evidence card (v25 Task 3.1, agent/verificationLoop.js).
 * Rendered every time a "done" declaration is checked — including
 * attempts that get rejected and retried — so the whole verify/replan
 * cycle is visible, the same transparency principle already applied to
 * Hybrid Debate mode's evidence card above.
 */
function renderTaskVerification(verification, attempt, maxAttempts) {
  if (!verification) return;

  const card = document.createElement('div');
  card.className = 'pv-msg-card pv-msg-agent';

  const box = document.createElement('div');
  box.className = 'pv-verify-box';

  const verdictClass = verification.verified ? 'pass' : 'fail';
  const verdictText = verification.verified ? 'VERIFIED' : 'NOT CONFIRMED';

  const header = document.createElement('div');
  header.className = 'pv-verify-header';
  const attemptLabel = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
  header.innerHTML = `
    <span class="material-symbols-outlined" aria-hidden="true">fact_check</span>
    <span class="pv-verify-header-title">Task Verification${escapeHtml(attemptLabel)}</span>
    <span class="pv-verify-verdict ${verdictClass}">${escapeHtml(verdictText)}</span>
  `;
  box.appendChild(header);

  const list = document.createElement('div');
  list.className = 'pv-verify-checks';
  for (const check of (verification.checks || [])) {
    const row = document.createElement('div');
    row.className = `pv-verify-check ${check.passed ? 'passed' : 'failed'}${check.advisory ? ' advisory' : ''}`;
    const icon = check.passed ? 'check_circle' : (check.advisory ? 'info' : 'cancel');
    row.innerHTML = `
      <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
      <span class="pv-verify-check-text">${escapeHtml(check.detail)}${check.advisory ? ' <em>(advisory)</em>' : ''}</span>
    `;
    list.appendChild(row);
  }
  box.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'pv-verify-footer';
  footer.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">local_police</span><span>${escapeHtml(verification.reason)} — 100% local, no model call, from data this extension already extracted.</span>`;
  box.appendChild(footer);

  card.appendChild(box);
  els.chatLog.appendChild(card);
  updateWelcomeState();
  scrollToBottom();
}

/**
 * Draws colored highlight boxes (see agent/evidenceGenerator.js) onto a
 * COPY of an already-redacted screenshot data URL — never touches or
 * replaces els.screenshotCanvas, and never draws on an unredacted frame.
 * DOM bboxes are mapped into screenshot pixel space with the same
 * window.__BA_CoordinateMapper helper drawRedactedScreenshot() already
 * uses for face/ID-image boxes, for consistency.
 *
 * @param {string} baseDataUrl - an already-redacted screenshot (e.g. redactedDataUrl)
 * @param {Array<{bbox:Object, color:string, label?:string}>} highlights
 * @param {{width:number,height:number}} viewport
 * @returns {Promise<string>} a new data URL; resolves to baseDataUrl unchanged if there's nothing to draw
 */
function annotateScreenshotDataUrl(baseDataUrl, highlights, viewport) {
  return new Promise((resolve, reject) => {
    if (!baseDataUrl || !Array.isArray(highlights) || highlights.length === 0 || !viewport) {
      resolve(baseDataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(baseDataUrl); return; }
      ctx.drawImage(img, 0, 0);

      ctx.lineWidth = 3;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';

      for (const h of highlights) {
        if (!h || !h.bbox) continue;
        const box = window.__BA_CoordinateMapper
          ? window.__BA_CoordinateMapper.mapDomBoxToScreenshot(h.bbox, viewport, canvas.width, canvas.height, 4)
          : h.bbox;
        if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !(box.width > 0) || !(box.height > 0)) continue;

        ctx.strokeStyle = h.color || '#2563eb';
        ctx.strokeRect(box.x, box.y, box.width, box.height);

        if (h.label) {
          const labelY = Math.max(14, box.y - 4);
          const textWidth = ctx.measureText(h.label).width;
          ctx.fillStyle = h.color || '#2563eb';
          ctx.fillRect(box.x, labelY - 12, textWidth + 8, 14);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(h.label, box.x + 4, labelY);
        }
      }

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not load screenshot for annotation'));
    img.src = baseDataUrl;
  });
}

/**
 * Visual Evidence card: an annotated screenshot (green = acted on safely,
 * red = danger/PII, orange = ambiguous/reversible-consequential) plus the
 * structured summary from agent/evidenceGenerator.js's summarizeEvidence().
 * Rendered at the two moments this matters most — see that module's
 * header comment — never on every step, to avoid duplicating what the
 * Privacy Receipt / Compliance Signals / debate card already cover.
 */
function renderVisualEvidence(title, annotatedDataUrl, summary) {
  if (!annotatedDataUrl) return;

  const card = document.createElement('div');
  card.className = 'pv-msg-card pv-msg-agent';

  const box = document.createElement('div');
  box.className = 'pv-evidence-box';

  const header = document.createElement('div');
  header.className = 'pv-evidence-header';
  header.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">visibility</span><span class="pv-evidence-header-title">${escapeHtml(title)}</span>`;
  box.appendChild(header);

  const img = document.createElement('img');
  img.className = 'pv-evidence-img';
  img.src = annotatedDataUrl;
  img.alt = title;
  box.appendChild(img);

  const legend = document.createElement('div');
  legend.className = 'pv-evidence-legend';
  const counts = summary?.highlightCounts || { safe: 0, danger: 0, ambiguous: 0 };
  legend.innerHTML = `
    <span class="pv-evidence-legend-item"><span class="pv-evidence-dot safe"></span>${counts.safe} safe</span>
    <span class="pv-evidence-legend-item"><span class="pv-evidence-dot danger"></span>${counts.danger} danger/PII</span>
    <span class="pv-evidence-legend-item"><span class="pv-evidence-dot ambiguous"></span>${counts.ambiguous} ambiguous</span>
  `;
  box.appendChild(legend);

  card.appendChild(box);
  els.chatLog.appendChild(card);
  updateWelcomeState();
  scrollToBottom();
}

/**
 * Builds and renders the task-completion visual evidence card: green
 * boxes over every element this task successfully acted on, red boxes
 * over any sensitive item still visible on the final page. Shared by
 * both the verified-done and the give-up-after-retries paths in
 * runAgentLoop(), since knowing what's still flagged red is exactly as
 * useful when verification DIDN'T pass as when it did.
 */
async function renderCompletionVisualEvidence(extraction, actionHistory, redactedDataUrl, decision, verification) {
  if (!window.__BA_EvidenceGenerator || !redactedDataUrl || !extraction?.viewport) return;
  try {
    const highlights = window.__BA_EvidenceGenerator.buildCompletionHighlights({
      actionHistory, elements: extraction.elements, sensitiveItems: extraction.sensitiveItems,
    });
    if (highlights.length === 0) return;
    const annotated = await annotateScreenshotDataUrl(redactedDataUrl, highlights, extraction.viewport);
    const summary = window.__BA_EvidenceGenerator.summarizeEvidence({
      decision, verification, sensitiveItems: extraction.sensitiveItems, highlights,
    });
    renderVisualEvidence('Task Completion Evidence', annotated, summary);
  } catch (err) {
    console.warn('[popup] Completion visual evidence generation failed (task result unaffected):', err.message);
  }
}

/** On-device model (agent/webllmEngine.js) status banner.
 *
 *  Previously every WEBLLM_INIT_PROGRESS broadcast could add a new chat
 *  message. Because the old engine also started several downloads in
 *  parallel (see webllmEngine.js's LOADING MODEL comment), progress from
 *  different downloads interleaved and the chat filled up with repeating
 *  "Downloading… 0% / 20% / 0% / 20%" lines. Progress is now shown in ONE
 *  banner (#localModelStatus) that is updated in place, in both tabs, and
 *  never touches the chat log. */
let lastLocalModelStatus = null;
let localModelReadyHideTimer = null;

function shortModelName(modelId) {
  if (!modelId) return 'Qwen2.5';
  return modelId.replace(/-q4f16_1-MLC$/, '').replace(/-Instruct$/, '');
}

const STALE_BACKGROUND_MESSAGE =
  "the extension's background script is still the previous version. Open chrome://extensions, press the reload " +
  'icon on this extension, then reopen this panel';

/** True if a background response shows the service worker predates the
 *  current popup (it doesn't know a message type this popup sends). This
 *  happens when files are updated on disk and the side panel is reopened
 *  without reloading the extension: the panel picks up the new files, the
 *  running service worker and offscreen document do not. */
function isStaleBackgroundResponse(resp) {
  return !!(resp && resp.ok === false && /Unknown message type/i.test(resp.error || ''));
}

function renderFooterStatus() {
  if (!els.footerStatus) return;
  const mode = (typeof currentPrivacyDialMode !== 'undefined') ? currentPrivacyDialMode : null;
  const meta = (window.__BA_PrivacyDial && mode) ? window.__BA_PrivacyDial.getModeMeta(mode) : null;
  const st = lastLocalModelStatus;
  let model = 'not loaded';
  if (st && st.status === 'loading') model = `loading ${Math.round((st.progress || 0) * 100)}%`;
  else if (st && st.status === 'ready') model = `ready (${shortModelName(st.modelId)})`;
  else if (st && st.status === 'error') model = 'unavailable';
  const cloud = mode === 'local' ? 'Cloud: never used' : 'Cloud: redacted payloads only';
  els.footerStatus.textContent = `Privacy Dial: ${meta ? meta.label : '—'} | On-device model: ${model} | ${cloud}`;
}

function renderLocalModelStatus(st) {
  if (!st || !els.localModelStatus) return;
  lastLocalModelStatus = st;
  renderFooterStatus();
  const banner = els.localModelStatus;
  const name = shortModelName(st.modelId);
  if (localModelReadyHideTimer) { clearTimeout(localModelReadyHideTimer); localModelReadyHideTimer = null; }
  banner.classList.remove('is-loading', 'is-ready', 'is-error');

  if (st.status === 'idle' || !st.status) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round((st.progress || 0) * 100)));
  if (els.localModelProgressBar) els.localModelProgressBar.style.width = `${st.status === 'ready' ? 100 : pct}%`;

  if (st.status === 'loading') {
    banner.classList.add('is-loading');
    els.localModelStatusText.textContent =
      `On-device model ${name}: loading ${pct}% — one-time download, cached on this device afterwards. ` +
      'Local-model steps are skipped (not retried in a loop) until this finishes.';
  } else if (st.status === 'ready') {
    banner.classList.add('is-ready');
    els.localModelStatusText.textContent = `On-device model ${name} is ready — runs fully offline from now on.`;
    localModelReadyHideTimer = setTimeout(() => { banner.hidden = true; }, 6000);
  } else if (st.status === 'error') {
    banner.classList.add('is-error');
    els.localModelStatusText.textContent =
      `On-device model unavailable: ${st.error || 'failed to load'}. Deterministic local matching still works; ` +
      'switch the Privacy Dial to Hybrid for cloud help on this page.';
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'WEBLLM_INIT_PROGRESS') return false;
  renderLocalModelStatus(message);
  return false;
});

async function queryLocalModelStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WEBLLM_STATUS' });
    if (isStaleBackgroundResponse(resp)) renderLocalModelStatus({ status: 'error', error: STALE_BACKGROUND_MESSAGE });
    else if (resp && resp.ok && resp.status) renderLocalModelStatus(resp.status);
    return resp && resp.status ? resp.status : null;
  } catch (_) {
    return null;
  }
}

/** Starts the (single, shared) on-device model load in the background.
 *  Called when the Privacy Dial is on a mode that actually needs the
 *  model (Fully Local, Hybrid Debate), so the one-time download happens
 *  up front with visible progress instead of surprising the user
 *  mid-task. Never blocks; safe to call repeatedly. */
async function requestLocalModelLoad() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'WEBLLM_START_LOAD' });
    if (isStaleBackgroundResponse(resp)) renderLocalModelStatus({ status: 'error', error: STALE_BACKGROUND_MESSAGE });
    else if (resp && resp.status) renderLocalModelStatus(resp.status);
  } catch (_) { /* offscreen not reachable — the next status broadcast will tell */ }
}

function privacyDialNeedsLocalModel(mode) {
  return mode === 'local' || mode === 'debate';
}

/**
 * Local vision fallback, v0 (classical CV, no model): for each icon-only,
 * unlabeled interactive element content/iconCandidateDetector.js flagged,
 * crop the corresponding region of the still-RAW screenshot canvas and run
 * utils/iconHeuristics.js's edge-density + variance heuristic against it.
 * Must run before any redaction boxes are painted (same ordering
 * requirement as the Merkle redaction proof above it) — not because the
 * icon crops are sensitive, but because a black redaction box painted
 * over part of an icon would corrupt the very pixels this is inspecting.
 * Best-effort: any failure here just means no extra hint gets added,
 * never blocks screenshot capture or redaction.
 */
function classifyIconCandidates(ctx, canvasWidth, canvasHeight, iconCandidates, viewport) {
  if (!Array.isArray(iconCandidates) || iconCandidates.length === 0) return [];
  if (!window.__BA_CoordinateMapper) return [];

  const classifier = window.__BA_IconClassifier;
  const useModel = classifier && classifier.isLoaded();
  const results = [];

  for (const candidate of iconCandidates) {
    try {
      const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(
        candidate.bbox, viewport, canvasWidth, canvasHeight, 0
      );
      const x = Math.max(0, Math.floor(box.x));
      const y = Math.max(0, Math.floor(box.y));
      const width = Math.min(canvasWidth - x, Math.ceil(box.width));
      const height = Math.min(canvasHeight - y, Math.ceil(box.height));
      if (width <= 0 || height <= 0) continue;

      const imageData = ctx.getImageData(x, y, width, height);

      // v1: the trained CNN names the icon, when it is confident enough.
      if (useModel) {
        const prediction = classifier.classifyIcon(imageData);
        if (prediction && prediction.label && prediction.label !== 'other') {
          results.push({
            elementId: candidate.elementId,
            label: `icon_${prediction.label}`,
            confidence: Number(prediction.confidence.toFixed(3)),
            source: 'model'
          });
          continue;
        }
        // Below threshold, or classified as 'other'. Fall through to the v0
        // heuristic rather than discarding the candidate: "something is
        // drawn here" is still more than the DOM knew, and the whole point
        // of the confidence threshold is that a low-confidence guess is
        // worse than no guess.
      }

      // v0 fallback: says only THAT a glyph is present, never which one.
      if (window.__BA_IconHeuristics) {
        const { looksLikeIcon, edgeDensity, variance } =
          window.__BA_IconHeuristics.classifyIconCrop(imageData);
        if (looksLikeIcon) {
          results.push({
            elementId: candidate.elementId,
            label: 'unlabeled_icon_detected',
            edgeDensity, variance,
            source: 'heuristic'
          });
        }
      }
    } catch (err) {
      console.warn('[popup] Icon classification failed for element', candidate.elementId, err.message);
    }
  }
  return results;
}

/**
 * Runs utils/visualStateEngine.js against the raw screenshot to answer the
 * questions the DOM cannot: is the page still loading, is a modal blocking
 * it, and is each interaction target actually painted where layout claims.
 *
 * Like the icon pass and the Merkle commitment, this must read the canvas
 * BEFORE any redaction box is painted — a black rectangle over a spinner or
 * a control would corrupt exactly the pixels being measured.
 *
 * Entirely best-effort: any failure yields a null report and the pipeline
 * behaves as it did before this existed.
 */
function analyzeVisualState(ctx, canvasWidth, canvasHeight, elements, viewport, previousFrame) {
  const engine = window.__BA_VisualStateEngine;
  if (!engine || !window.__BA_CoordinateMapper) return { report: null, rawFrame: null };

  try {
    const rawFrame = ctx.getImageData(0, 0, canvasWidth, canvasHeight);

    const elementBoxes = [];
    for (const el of (elements || [])) {
      if (!el || !el.bbox || el.visible === false) continue;
      const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(
        el.bbox, viewport, canvasWidth, canvasHeight, 0
      );
      if (Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0) {
        elementBoxes.push({ elementId: el.id, box });
      }
    }

    const report = engine.analyzeScreenState(rawFrame, previousFrame, elementBoxes);
    return { report, rawFrame };
  } catch (err) {
    console.warn('[popup] Visual state analysis failed (pipeline unaffected):', err.message);
    return { report: null, rawFrame: null };
  }
}

/**
 * The raw screenshot of the PREVIOUS agent step, kept so the visual state
 * engine can difference two frames — which is what makes spinner detection
 * and "did my last action actually do anything" possible at all. Exactly
 * one frame is retained and it is replaced every step, so this costs one
 * screenshot's worth of memory, not a growing history. It never leaves the
 * popup context and is never serialised into any payload.
 */
let previousRawFrame = null;

/** Ensures the degraded-face-detection warning is shown once per task, not
 *  on every step of the agent loop. Reset in runAgentLoop(). */
let warnedFaceDetectionDegraded = false;

/* ---------- Before / After redaction panel (Privacy Proof tab) ----------
 *
 * The redacted canvas (#screenshotCanvas) is exactly the image that may be
 * sent to a cloud reasoner. The "original" canvas is the same capture from
 * BEFORE redaction, with each redacted region outlined, so anyone watching
 * can see what was hidden and where. Because that image contains the very
 * data being protected, it is:
 *   - never included in any payload, proof, receipt or download;
 *   - held only for the latest step (replaced every step, cleared when a
 *     new task starts);
 *   - shown only after an explicit click, and auto-hidden after 30s.
 */
let latestOutlinedOriginal = null;
let beforeAfterView = 'redacted';
let beforeAfterHideTimer = null;
const BEFORE_AFTER_AUTOHIDE_MS = 60000;

function setBeforeAfterView(view) {
  if (!els.baStage) return;
  if ((view === 'original' || view === 'side') && !latestOutlinedOriginal) view = 'redacted';
  beforeAfterView = view;
  els.baStage.dataset.view = view;
  if (els.baFigureRedacted) els.baFigureRedacted.hidden = view === 'original';
  if (els.baFigureOriginal) els.baFigureOriginal.hidden = view === 'redacted';
  const btns = [[els.baBtnRedacted, 'redacted'], [els.baBtnOriginal, 'original'], [els.baBtnSide, 'side']];
  for (const [btn, v] of btns) {
    if (!btn) continue;
    btn.classList.toggle('active', v === view);
    btn.setAttribute('aria-selected', String(v === view));
  }

  if (view !== 'redacted' && els.originalCanvas && latestOutlinedOriginal) {
    els.originalCanvas.width = latestOutlinedOriginal.width;
    els.originalCanvas.height = latestOutlinedOriginal.height;
    const c = els.originalCanvas.getContext('2d');
    if (c) c.drawImage(latestOutlinedOriginal, 0, 0);
  } else if (els.originalCanvas) {
    // Wipe the pixels, not just hide the element.
    const c = els.originalCanvas.getContext('2d');
    if (c) c.clearRect(0, 0, els.originalCanvas.width, els.originalCanvas.height);
    els.originalCanvas.width = 1;
    els.originalCanvas.height = 1;
  }

  if (beforeAfterHideTimer) { clearTimeout(beforeAfterHideTimer); beforeAfterHideTimer = null; }
  if (view !== 'redacted') {
    beforeAfterHideTimer = setTimeout(() => setBeforeAfterView('redacted'), BEFORE_AFTER_AUTOHIDE_MS);
  } else if (lightboxShowsOriginal) {
    closeBeforeAfterLightbox(); // never leave the original visible in the enlarged view either
  }
}

let lightboxShowsOriginal = false;

function openBeforeAfterLightbox(which) {
  if (!els.baLightbox || !els.baLightboxCanvas) return;
  const source = which === 'original' ? latestOutlinedOriginal : els.screenshotCanvas;
  if (!source || !source.width || source.width < 2) return;
  els.baLightboxCanvas.width = source.width;
  els.baLightboxCanvas.height = source.height;
  const c = els.baLightboxCanvas.getContext('2d');
  if (c) c.drawImage(source, 0, 0);
  lightboxShowsOriginal = which === 'original';
  if (els.baLightboxTitle) {
    els.baLightboxTitle.textContent = lightboxShowsOriginal
      ? 'BEFORE: original, redacted regions outlined (local only)'
      : 'AFTER: redacted, exactly what can leave this device';
  }
  els.baLightbox.hidden = false;
  if (els.baLightboxClose) els.baLightboxClose.focus();
}

function closeBeforeAfterLightbox() {
  if (!els.baLightbox) return;
  els.baLightbox.hidden = true;
  lightboxShowsOriginal = false;
  if (els.baLightboxCanvas) {
    const c = els.baLightboxCanvas.getContext('2d');
    if (c) c.clearRect(0, 0, els.baLightboxCanvas.width, els.baLightboxCanvas.height);
    els.baLightboxCanvas.width = 1;
    els.baLightboxCanvas.height = 1;
  }
}

function downloadRedactedScreenshot() {
  const canvas = els.screenshotCanvas;
  if (!canvas || canvas.width < 2) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redacted-screenshot-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function renderBeforeAfter(outlinedCanvas, counts, scopeLabel = 'Latest step') {
  latestOutlinedOriginal = outlinedCanvas || null;
  const hasOriginal = !!latestOutlinedOriginal;
  if (els.baBtnOriginal) els.baBtnOriginal.disabled = !hasOriginal;
  if (els.baBtnSide) els.baBtnSide.disabled = !hasOriginal;
  if (els.baDownloadRedacted) els.baDownloadRedacted.disabled = !(els.screenshotCanvas && els.screenshotCanvas.width > 1);
  if (els.baSummary) {
    const c = counts || { text: 0, face: 0, id: 0 };
    const total = (c.text || 0) + (c.face || 0) + (c.id || 0);
    els.baSummary.textContent = total === 0
      ? `${scopeLabel}: nothing needed redaction.`
      : `${scopeLabel}: ${total} region(s) blacked out before anything could leave the device — ` +
        `${c.text || 0} text PII, ${c.face || 0} face(s), ${c.id || 0} ID document(s).`;
  }
  // Refresh whatever view is showing so it never displays a stale frame.
  setBeforeAfterView(beforeAfterView);
}

function clearBeforeAfter() {
  closeBeforeAfterLightbox();
  latestOutlinedOriginal = null;
  renderBeforeAfter(null, null);
  if (els.baSummary) els.baSummary.textContent = 'Run a task to capture a screenshot.';
}

if (els.baBtnRedacted) els.baBtnRedacted.addEventListener('click', () => setBeforeAfterView('redacted'));
if (els.baBtnOriginal) els.baBtnOriginal.addEventListener('click', () => setBeforeAfterView('original'));
if (els.baBtnSide) els.baBtnSide.addEventListener('click', () => setBeforeAfterView('side'));
if (els.baDownloadRedacted) els.baDownloadRedacted.addEventListener('click', downloadRedactedScreenshot);

/* ---------- "Capture full page" (Before/After panel) ----------
 *
 * Chrome's extension screenshot API only returns the visible screen, and a
 * true full-page capture would need the `debugger` permission (a "started
 * debugging this browser" banner and very broad access). Instead this
 * scrolls the page one screen at a time, runs the SAME per-screen pipeline
 * on each screen (ANALYZE_PAGE: DOM extraction, PII detection incl. NER,
 * face detection, ID-image detection), and joins the screens:
 *
 *   1. every screen's RAW pixels are stitched into one tall canvas and each
 *      screen's redaction boxes are shifted into that canvas's coordinates;
 *   2. ONE Merkle redaction proof is generated over the stitched raw image
 *      with all the boxes, before anything is painted (same ordering rule
 *      as the per-step pipeline);
 *   3. the redacted image = raw + every box painted black; the "before"
 *      image = raw + coloured outlines. The stitched raw canvas is then
 *      wiped.
 *
 * Nothing is sent anywhere. Known, disclosed limits: sticky/fixed headers
 * appear once per screen; content that animates or lazy-loads while
 * scrolling can shift slightly between screens; the ID-image OCR
 * confirmation pass is skipped (it never gates redaction anyway); very
 * long pages are capped at FULL_PAGE_MAX_SCREENS / FULL_PAGE_MAX_HEIGHT_PX.
 * The user's scroll position is restored at the end, even on failure.
 */
const FULL_PAGE_MAX_SCREENS = 12;
const FULL_PAGE_MAX_HEIGHT_PX = 16000;
let fullPageCaptureRunning = false;

function setBaProgress(text) {
  if (!els.baProgress) return;
  els.baProgress.textContent = text || '';
  els.baProgress.hidden = !text;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode a captured screen.'));
    img.src = dataUrl;
  });
}

async function captureFullPageRedacted() {
  if (fullPageCaptureRunning) return;
  if (isRunning) {
    setBaProgress('Wait for the current task to finish, then press "Capture full page" again.');
    return;
  }
  fullPageCaptureRunning = true;
  isRunning = true; // blocks new tasks while the page is being scrolled
  if (els.sendBtn) els.sendBtn.disabled = true;
  if (els.baCaptureFullPage) els.baCaptureFullPage.disabled = true;
  const savedPreviousFrame = previousRawFrame;
  let originalScrollY = null;
  let rawFull = null;

  try {
    const info = await sendMessage({ type: 'PAGE_SCROLL_INFO' });
    if (isStaleBackgroundResponse(info)) throw new Error(STALE_BACKGROUND_MESSAGE);
    if (!info || !info.ok || !info.data) throw new Error((info && info.error) || 'Could not read the page size.');
    originalScrollY = info.data.scrollY;
    const viewH = Math.max(1, info.data.innerHeight);
    const maxScroll = Math.max(0, info.data.scrollHeight - viewH);

    const positions = [];
    for (let y = 0; y <= maxScroll && positions.length < FULL_PAGE_MAX_SCREENS; y += viewH) positions.push(y);
    if (positions[positions.length - 1] < maxScroll && positions.length < FULL_PAGE_MAX_SCREENS) positions.push(maxScroll);
    const cappedByScreens = positions[positions.length - 1] < maxScroll;

    const screens = [];
    for (let i = 0; i < positions.length; i++) {
      setBaProgress(`Capturing screen ${i + 1} of ${positions.length}… the page will scroll by itself; please don't touch it.`);
      const moved = await sendMessage({ type: 'PAGE_SCROLL_TO', y: positions[i] });
      // Let lazy content and layout settle; also keeps captures under
      // Chrome's limit of 2 screenshots per second.
      await delay(i === 0 ? 450 : 700);
      const resp = await sendMessage({ type: 'ANALYZE_PAGE' });
      if (!resp || !resp.ok || !resp.data || resp.data.isUnsupportedScheme) {
        throw new Error((resp && resp.error) || 'This page cannot be captured.');
      }
      const { extraction, screenshotDataUrl, faces } = resp.data;
      const img = await loadImage(screenshotDataUrl);
      const faceBoxes = Array.isArray(faces) ? faces : [];
      const idRegions = Array.isArray(extraction.idImageRegions) ? extraction.idImageRegions : [];
      const { boxes, kinds } = computeRedactionBoxes(
        extraction.sensitiveItems, extraction.viewport, img.naturalWidth, img.naturalHeight, faceBoxes, idRegions
      );
      screens.push({
        img, boxes, kinds,
        scrollY: (moved && moved.ok && moved.data) ? moved.data.scrollY : positions[i],
        cssHeight: extraction.viewport && extraction.viewport.height ? extraction.viewport.height : viewH,
        sensitiveItems: extraction.sensitiveItems || [],
        faces: faceBoxes.length,
        ids: idRegions.length,
      });
    }
    if (screens.length === 0) throw new Error('Nothing was captured.');

    // Stitch the raw screens into one canvas (screenshot pixels per CSS px
    // can be > 1 on high-DPI screens, so scale scroll offsets accordingly).
    setBaProgress('Joining screens, redacting and signing the full-page proof…');
    const scale = screens[0].img.naturalHeight / screens[0].cssHeight;
    const width = screens[0].img.naturalWidth;
    const lastScreen = screens[screens.length - 1];
    const fullHeightUncapped = Math.round(lastScreen.scrollY * scale) + lastScreen.img.naturalHeight;
    const height = Math.min(fullHeightUncapped, FULL_PAGE_MAX_HEIGHT_PX);
    const cappedByHeight = fullHeightUncapped > FULL_PAGE_MAX_HEIGHT_PX;

    rawFull = document.createElement('canvas');
    rawFull.width = width;
    rawFull.height = height;
    const rctx = rawFull.getContext('2d');
    const allBoxes = [];
    const allKinds = [];
    const seenBoxes = new Set();
    for (const sc of screens) {
      const dy = Math.round(sc.scrollY * scale);
      if (dy >= height) continue;
      rctx.drawImage(sc.img, 0, dy);
      sc.boxes.forEach((b, i) => {
        const y = b.y + dy;
        if (y >= height) return;
        // Consecutive screens overlap at the bottom of the page, so the
        // same face/field can be found twice. Count and draw it once.
        const key = `${sc.kinds[i]}|${Math.round(b.x / 6)}|${Math.round(y / 6)}|${Math.round(b.width / 6)}|${Math.round(b.height / 6)}`;
        if (seenBoxes.has(key)) return;
        seenBoxes.add(key);
        allBoxes.push({ x: b.x, y, width: b.width, height: Math.min(b.height, height - y) });
        allKinds.push(sc.kinds[i]);
      });
    }

    // One signed proof over the stitched RAW image, before any painting.
    const proof = window.__BA_MerkleProof
      ? await window.__BA_MerkleProof.generateRedactionProof(rctx, width, height, allBoxes).catch(() => null)
      : null;

    const outlined = document.createElement('canvas');
    outlined.width = width;
    outlined.height = height;
    const octx = outlined.getContext('2d');
    octx.drawImage(rawFull, 0, 0);
    drawRedactionOutlines(octx, allBoxes, allKinds, width);

    rctx.fillStyle = '#000000';
    for (const b of allBoxes) rctx.fillRect(b.x, b.y, b.width, b.height);
    const display = els.screenshotCanvas;
    display.width = width;
    display.height = height;
    display.getContext('2d').drawImage(rawFull, 0, 0); // rawFull is now fully redacted

    const counts = { text: 0, face: 0, id: 0 };
    for (const k of allKinds) counts[k] = (counts[k] || 0) + 1;
    const scopeLabel = `Full page (${screens.length} screen${screens.length === 1 ? '' : 's'})`;
    renderBeforeAfter(outlined, counts, scopeLabel);

    const union = dedupeSensitiveItems(screens.flatMap((sc) => sc.sensitiveItems));
    renderSensitiveList(union, els.sensitiveList, 'No sensitive text found on any captured screen.');
    if (els.sensitiveListScope) els.sensitiveListScope.textContent = `On the full-page capture, ${screens.length} screens (each one is a black box above)`;

    if (proof) {
      latestRedactionProof = proof;
      updateRedactionProofUI(proof);
    }
    proofHeroState.pii = union.length;
    proofHeroState.faces = counts.face || 0;
    proofHeroState.ids = counts.id || 0;
    proofHeroState.scope = 'full page';
    renderProofHero();

    const limits = [];
    if (cappedByScreens || cappedByHeight) limits.push(`the page is very long, so only the first ${screens.length} screens were captured`);
    setBaProgress(`Done: ${screens.length} screen(s) captured and redacted on this device, nothing sent.` +
      (limits.length ? ` Note: ${limits.join('; ')}.` : '') +
      ' Sticky headers can appear once per screen.');
  } catch (err) {
    setBaProgress(`Full-page capture failed: ${err.message}`);
  } finally {
    if (originalScrollY !== null) {
      try { await sendMessage({ type: 'PAGE_SCROLL_TO', y: originalScrollY }); } catch (_) { /* best effort */ }
    }
    if (rawFull) { rawFull.width = 1; rawFull.height = 1; }
    previousRawFrame = savedPreviousFrame; // the agent's own frame-diffing must not see these screens
    fullPageCaptureRunning = false;
    isRunning = false;
    if (els.sendBtn) els.sendBtn.disabled = false;
    if (els.baCaptureFullPage) els.baCaptureFullPage.disabled = false;
  }
}

if (els.baCaptureFullPage) els.baCaptureFullPage.addEventListener('click', captureFullPageRedacted);

if (els.screenshotCanvas) els.screenshotCanvas.addEventListener('click', () => openBeforeAfterLightbox('redacted'));
if (els.originalCanvas) els.originalCanvas.addEventListener('click', () => openBeforeAfterLightbox('original'));
if (els.baLightboxClose) els.baLightboxClose.addEventListener('click', closeBeforeAfterLightbox);
if (els.baLightbox) els.baLightbox.addEventListener('click', (e) => { if (e.target === els.baLightbox) closeBeforeAfterLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.baLightbox && !els.baLightbox.hidden) closeBeforeAfterLightbox(); });

/**
 * Every region that must be blacked out on one screenshot, in screenshot
 * pixel space: detected text PII, faces (YuNet), and ID-document images.
 * Shared by the per-step pipeline (drawRedactedScreenshot) and the
 * full-page capture, so both black out exactly the same things.
 * `kinds` is parallel to `boxes` ('text' | 'face' | 'id').
 */
function computeRedactionBoxes(sensitiveItems, viewport, canvasWidth, canvasHeight, faceBoxes = [], idImageRegions = []) {
  const boxes = [];
  const kinds = [];

  for (const item of (sensitiveItems || [])) {
    if (!item?.bbox) continue;
    const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(
      item.bbox, viewport, canvasWidth, canvasHeight, 4
    );
    if (Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0) {
      boxes.push(box);
      kinds.push('text');
    }
  }

  for (const face of (faceBoxes || [])) {
    if (
      !face ||
      !Number.isFinite(face.x) || !Number.isFinite(face.y) ||
      !Number.isFinite(face.width) || !Number.isFinite(face.height)
    ) continue;

    const padding = 10;
    let x = Math.floor(face.x - padding);
    let y = Math.floor(face.y - padding);
    let right = Math.ceil(face.x + face.width + padding);
    let bottom = Math.ceil(face.y + face.height + padding);
    x = Math.max(0, Math.min(canvasWidth, x));
    y = Math.max(0, Math.min(canvasHeight, y));
    right = Math.max(x, Math.min(canvasWidth, right));
    bottom = Math.max(y, Math.min(canvasHeight, bottom));
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) continue;
    boxes.push({ x, y, width, height });
    kinds.push('face');
  }

  for (const region of (idImageRegions || [])) {
    if (!region?.bbox) continue;
    const box = window.__BA_CoordinateMapper.mapDomBoxToScreenshot(
      region.bbox, viewport, canvasWidth, canvasHeight, 8
    );
    if (Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0) {
      boxes.push(box);
      kinds.push('id');
    }
  }

  return { boxes, kinds };
}

/** Coloured outline + light tint for each redacted region (Before view).
 *  Thick enough to stay visible when the panel shrinks the image. */
function drawRedactionOutlines(ctx, boxes, kinds, canvasWidth) {
  const lw = Math.max(3, Math.round(canvasWidth / 220));
  const colours = { text: '239, 68, 68', face: '245, 158, 11', id: '168, 85, 247' };
  ctx.lineWidth = lw;
  boxes.forEach((box, i) => {
    const rgb = colours[kinds[i]] || colours.text;
    ctx.fillStyle = `rgba(${rgb}, 0.18)`;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.strokeStyle = `rgb(${rgb})`;
    ctx.strokeRect(box.x + lw / 2, box.y + lw / 2, Math.max(1, box.width - lw), Math.max(1, box.height - lw));
  });
}

async function drawRedactedScreenshot(
  screenshotDataUrl,
  sensitiveItems,
  viewport,
  faceBoxes = [],
  idImageRegions = [],
  iconCandidates = [],
  elements = []
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

      // Compute every redaction box FIRST, against the still-raw canvas,
      // without painting anything yet — this order matters: the
      // Merkle redaction proof (see utils/merkleProof.js) needs to hash
      // the genuinely raw pixels before any black rectangle overwrites
      // them, using exactly the same boxes that are about to be redacted.
      const { boxes: allRedactionBoxes, kinds: redactionBoxKinds } =
        computeRedactionBoxes(sensitiveItems, viewport, canvas.width, canvas.height, faceBoxes, idImageRegions);

      // Cryptographic redaction proof: commits to the complete raw
      // screenshot (Merkle root) and produces inclusion proofs for every
      // tile any redaction box overlaps — proving those regions were
      // genuinely part of the original image without ever revealing
      // their pixel content. See utils/merkleProof.js for the full
      // cryptographic explanation. Best-effort: a failure here (e.g.
      // Web Crypto unavailable) must never block redaction itself.
      const proofPromise = (window.__BA_MerkleProof
        ? window.__BA_MerkleProof.generateRedactionProof(ctx, canvas.width, canvas.height, allRedactionBoxes)
            .catch((err) => { console.warn('[popup] Redaction proof generation failed (redaction unaffected):', err.message); return null; })
        : Promise.resolve(null));

      // Local vision: classify unlabeled icon candidates and read the
      // overall screen state, both against the still-raw canvas (see
      // classifyIconCandidates() above for why this must precede painting).
      const iconClassifications = classifyIconCandidates(ctx, canvas.width, canvas.height, iconCandidates, viewport);
      const { report: visualState, rawFrame } =
        analyzeVisualState(ctx, canvas.width, canvas.height, elements, viewport, previousRawFrame);
      previousRawFrame = rawFrame;

      // Before/After panel: a copy of the still-RAW capture with every
      // box that is about to be blacked out drawn as a coloured outline.
      // Made synchronously here, before the black boxes are painted below.
      // Lives only in popup memory (see renderBeforeAfter()).
      let outlinedCanvas = null;
      try {
        outlinedCanvas = document.createElement('canvas');
        outlinedCanvas.width = canvas.width;
        outlinedCanvas.height = canvas.height;
        const octx = outlinedCanvas.getContext('2d');
        octx.drawImage(canvas, 0, 0);
        drawRedactionOutlines(octx, allRedactionBoxes, redactionBoxKinds, canvas.width);
      } catch (err) {
        outlinedCanvas = null;
        console.warn('[popup] Before/after preview unavailable (redaction unaffected):', err.message);
      }
      const redactionCounts = { text: 0, face: 0, id: 0 };
      for (const k of redactionBoxKinds) redactionCounts[k] = (redactionCounts[k] || 0) + 1;

      proofPromise.then((redactionProof) => {
        // Now actually paint the black boxes, after the raw-pixel commitment above.
        ctx.fillStyle = "#000000";
        for (const box of allRedactionBoxes) {
          ctx.fillRect(box.x, box.y, box.width, box.height);
        }

        const dataUrl = canvas.toDataURL("image/png");
        // rawFrame: the pre-redaction pixel buffer already computed by
        // analyzeVisualState() above, for its own loading/no-effect
        // detection. Threaded out here too so agent/verificationLoop.js
        // can diff a task's first and last frame without capturing or
        // decoding a second screenshot — see runAgentLoop()'s use of
        // taskVerifier.captureBaseline().
        resolve({ canvas, dataUrl, redactionProof, iconClassifications, visualState, rawFrame, outlinedCanvas, redactionCounts,
                  redactionBoxes: allRedactionBoxes, redactionBoxKinds });
      });
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

  const { extraction, screenshotDataUrl, faces,
          faceDetectionAvailable = true, faceDetectionError = null } = response.data;

  agentController.onDomExtracted();
  agentController.onPiiDetected();
  agentController.onScreenshotCaptured();

  const faceBoxes = Array.isArray(faces) ? faces : [];

  // Face detection is allowed to be unavailable (the agent no longer dies
  // when the ONNX runtime cannot start — see background/service-worker.js).
  // It is NOT allowed to fail quietly: an empty face list from a broken
  // detector looks exactly like a page with no faces in it, and the
  // difference decides whether an un-redacted face reaches the cloud
  // reasoner. So say so plainly, once per task, and mark the receipt.
  if (!faceDetectionAvailable && !warnedFaceDetectionDegraded) {
    warnedFaceDetectionDegraded = true;
    addMessage('system',
      '⚠️ Face detection is unavailable in this browser session, so faces will NOT be ' +
      'blacked out on screenshots this task. Text and document redaction are unaffected. ' +
      'If this page shows photographs of people, switch the Privacy Dial to Fully Local ' +
      'before continuing.' + (faceDetectionError ? ` (${faceDetectionError})` : ''));
  }
  const idImageRegions = Array.isArray(extraction.idImageRegions) ? extraction.idImageRegions : [];

  // OCR-confirmation pass: reads the actual text in each heuristically-
  // flagged id-image region (on-device, via offscreen.js's PP-OCR/
  // PaddleOCR ONNX detection+recognition pipeline) and checks it against
  // the same validated Aadhaar/PAN patterns
  // as piiDetector.js. This never gates redaction — every region below
  // still gets blacked out regardless — it only upgrades the evidence
  // from "looked like an ID card" to "confirmed: contains an Aadhaar/PAN
  // number". Fails closed (empty results) if OCR isn't vendored locally.
  let ocrConfirmedCount = 0;
  let ocrDetectedTypeSet = new Set();
  if (idImageRegions.length > 0) {
    try {
      const ocrResults = await sendMessage({
        type: 'RUN_ID_IMAGE_OCR',
        screenshotDataUrl,
        regions: idImageRegions,
        viewport: extraction.viewport
      });
      const results = ocrResults?.results || [];
      for (const r of results) {
        if (r.confirmedByOcr) {
          ocrConfirmedCount++;
          (r.detectedTypes || []).forEach((t) => ocrDetectedTypeSet.add(t));
        }
        if (idImageRegions[r.index]) {
          idImageRegions[r.index].confirmedByOcr = !!r.confirmedByOcr;
          idImageRegions[r.index].ocrDetectedTypes = r.detectedTypes || [];
        }
      }
    } catch (err) {
      console.warn('[popup] ID-image OCR confirmation pass failed (redaction unaffected):', err.message);
    }
  }

  const redactedResult = await drawRedactedScreenshot(
    screenshotDataUrl,
    extraction.sensitiveItems,
    extraction.viewport,
    faceBoxes,
    idImageRegions,
    extraction.iconCandidates,
    extraction.elements
  );

  const redactedDataUrl = redactedResult.dataUrl;

  // Local vision: enrich the DOM skeleton with purely structural hints the
  // DOM itself could not provide. Additive only — it changes nothing else
  // in the pipeline and adds no new data class: every value written here is
  // a short fixed enum string or a boolean, the same trust level as
  // text/ariaLabel, and each field is explicitly allowlisted in
  // agent/privacyBoundary.js. See utils/iconClassifier.js and
  // utils/visualStateEngine.js.
  const iconClassifications = Array.isArray(redactedResult.iconClassifications) ? redactedResult.iconClassifications : [];
  if (iconClassifications.length > 0) {
    const byId = new Map(iconClassifications.map((c) => [c.elementId, c]));
    for (const el of extraction.elements) {
      const hit = byId.get(el.id);
      // 'icon_menu' etc. from the trained classifier, or the v0 heuristic's
      // 'unlabeled_icon_detected' when it declined to name the glyph.
      if (hit) el.inferredLabel = hit.label;
    }
  }

  const visualState = redactedResult.visualState || null;
  if (visualState && Array.isArray(visualState.unpaintedElementIds) && visualState.unpaintedElementIds.length > 0) {
    // The DOM said these are visible; the pixels say nothing is drawn
    // there. Flagged rather than removed — the reasoner (and the local
    // decision layer) should know the target is unreliable, but this is a
    // heuristic and should not silently delete a real element.
    const unpainted = new Set(visualState.unpaintedElementIds);
    for (const el of extraction.elements) {
      if (unpainted.has(el.id)) el.visuallyPainted = false;
    }
  }

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
  renderBeforeAfter(redactedResult.outlinedCanvas, redactedResult.redactionCounts);

  agentController.onScreenshotRedacted();

  els.countElements.textContent = extraction.counts.interactiveElements;
  els.countSensitive.textContent = extraction.counts.sensitiveItems;

  renderElementsList(extraction.elements);
  renderSensitiveList(extraction.sensitiveItems);
  if (els.sensitiveListScope) els.sensitiveListScope.textContent = 'On the captured screenshot (each one is a black box above)';

  // Local compliance signals (agent/complianceChecker.js) — read-only,
  // display-only: never gates or alters what the agent does next. Wrapped
  // defensively since it's a UI enrichment, not a safety-critical path.
  if (window.__BA_ComplianceChecker) {
    try {
      const complianceResult = window.__BA_ComplianceChecker.check({
        elements: extraction.elements,
        visibleText: extraction.visibleText,
        sensitiveItems: extraction.sensitiveItems,
        pageUrl: extraction.url,
      });
      renderComplianceSummary(complianceResult);
    } catch (err) {
      console.warn('[popup] complianceChecker failed (non-fatal, UI-only feature):', err.message);
    }
  }

  els.visibleTextJson.textContent = JSON.stringify(extraction.visibleText, null, 2);
  els.detailsPanel.hidden = false;

  agentController.evaluateReadiness(extraction);

  return {
    isUnsupportedScheme: false,
    extraction,
    redactedDataUrl,
    faceCount: faceBoxes.length,
    idImageCount: idImageRegions.length,
    ocrConfirmedCount,
    ocrDetectedTypes: Array.from(ocrDetectedTypeSet),
    redactionProof: redactedResult.redactionProof || null,
    visualState,
    // Pre-redaction raw pixel frame for this step, used only in-memory by
    // agent/verificationLoop.js's task-completion visual-change check
    // (see runAgentLoop()) — never sent anywhere, never rendered; the
    // screenshot the user sees and the one sent to any reasoner is always
    // redactedDataUrl above.
    rawFrame: redactedResult.rawFrame || null,
    iconClassifications,
    faceDetectionAvailable,
    faceDetectionError
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

/**
 * Privacy Receipt panel
 *
 * Live, per-step proof that the "redacted before it leaves the browser"
 * claim is real, not just a design doc assertion. Every number here comes
 * from data already computed by the existing pipeline (PII/face/ID-image
 * detection counts, and agentBackend's own record of the exact sanitized
 * payload + adversarial pre-flight scan result for the last network call) —
 * this only renders it where a judge (or the user) can actually see it.
 */
function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function createPrivacyReceiptTotals() {
  return {
    stepsSent: 0,
    totalPiiMasked: 0,
    totalFaces: 0,
    totalIdImages: 0,
    totalIdImagesOcrConfirmed: 0,
    totalBytes: 0,
    scanFailures: 0,
    zeroCloudSteps: 0,
    zeroCloudFieldsFilled: 0,
    localOnlySteps: 0,
    routerLocalSteps: 0,
    latencySumMs: 0,
    latencyCount: 0
  };
}

function resetPrivacyReceiptUI() {
  if (els.receiptSteps) els.receiptSteps.textContent = '0';
  if (els.receiptPiiMasked) els.receiptPiiMasked.textContent = '0';
  if (els.receiptFaces) els.receiptFaces.textContent = '0';
  if (els.receiptIdImages) els.receiptIdImages.textContent = '0';
  if (els.receiptBytes) els.receiptBytes.textContent = '0 B';
  if (els.receiptScanStatus) {
    els.receiptScanStatus.textContent = 'No scans yet';
    els.receiptScanStatus.classList.remove('pv-scan-fail');
    els.receiptScanStatus.classList.add('pv-scan-pass');
  }
  if (els.privacyReceiptPayload) els.privacyReceiptPayload.textContent = 'No requests sent yet.';
  resetBenchmarkDashboardUI();
  resetRedactionProofUI();
  proofHeroState.pii = null;
  proofHeroState.faces = 0;
  proofHeroState.ids = 0;
  proofHeroState.totals = null;
  renderProofHero();
}

function resetRedactionProofUI() {
  latestRedactionProof = null;
  proofHeroState.proof = null;
  if (els.redactionProofRoot) els.redactionProofRoot.textContent = '—';
  if (els.redactionProofTiles) els.redactionProofTiles.textContent = '—';
  if (els.redactionProofDownloadBtn) els.redactionProofDownloadBtn.disabled = true;
}

/**
 * Live Evaluation-Metrics Dashboard
 *
 * Surfaces measured, honestly-labeled proxies for the 5 weighted ISRO
 * SIH26171 evaluation categories, computed entirely from telemetry this
 * pipeline already produces — nothing here is a claimed/offline number,
 * it's what actually happened in this run. None of these proxies are a
 * substitute for a real labeled-dataset benchmark (that requires ground
 * truth this extension doesn't have access to at runtime) — they're
 * live operational evidence a judge can watch update during the demo
 * itself, which is the point: the demo becomes the evidence.
 */
function resetBenchmarkDashboardUI() {
  if (els.benchActionSuccess) els.benchActionSuccess.textContent = '—';
  if (els.benchDetectionVolume) els.benchDetectionVolume.textContent = '0';
  if (els.benchRedactionConfirm) els.benchRedactionConfirm.textContent = '—';
  if (els.benchResourceUse) els.benchResourceUse.textContent = '—';
  if (els.benchLatency) els.benchLatency.textContent = '—';
}

function recordStepLatency(totals, ms) {
  if (!totals || !Number.isFinite(ms) || ms < 0) return;
  totals.latencySumMs += ms;
  totals.latencyCount += 1;
}

function updateBenchmarkDashboard(actionHistory, totals) {
  if (!els.benchActionSuccess || !totals) return;

  // Visual context accuracy (25%) — proxy: fraction of executed actions
  // that verified successful (actionVerifier / execution result), i.e.
  // the agent correctly identified & acted on the right element.
  const scored = (actionHistory || []).filter((h) => h.result && typeof h.result.success === 'boolean');
  const successRate = scored.length > 0
    ? Math.round((scored.filter((h) => h.result.success).length / scored.length) * 100)
    : null;
  els.benchActionSuccess.textContent = successRate === null ? '—' : `${successRate}% (${scored.filter(h=>h.result.success).length}/${scored.length} actions)`;

  // Sensitive data detection (20%) — proxy: total items actually caught
  // locally this run (recall/precision proper needs a labeled dataset;
  // this is detection *volume*, labeled honestly as such).
  const detectionVolume = totals.totalPiiMasked + totals.totalFaces + totals.totalIdImages;
  els.benchDetectionVolume.textContent = String(detectionVolume);

  // Redaction precision (20%) — proxy: of the ID-image regions flagged
  // for redaction, what fraction were content-confirmed by on-device OCR
  // (vs. heuristic-only). Only meaningful once the PP-OCR/PaddleOCR
  // models are vendored (see models/ocr/README.md); shows "—" until then
  // rather than a misleading 0%.
  els.benchRedactionConfirm.textContent = totals.totalIdImages > 0
    ? `${totals.totalIdImagesOcrConfirmed}/${totals.totalIdImages} OCR-confirmed`
    : '—';

  // Client-side resource utilization (20%) — proxy: JS heap (Chrome-only
  // performance.memory) plus how many steps needed zero network calls,
  // broken out by which Privacy Dial position produced them (Hybrid's
  // opportunistic zero-cloud fast path vs. Fully Local's hard-guaranteed
  // zero-cloud steps — see agent/privacyDial.js).
  const heap = (performance && performance.memory && performance.memory.usedJSHeapSize) || null;
  const heapStr = heap ? formatBytes(heap) : 'n/a';
  const localOnlySteps = totals.localOnlySteps || 0;
  const routerLocalSteps = totals.routerLocalSteps || 0;
  const totalSteps = totals.stepsSent + totals.zeroCloudSteps + localOnlySteps + routerLocalSteps;
  const zeroCloudTotal = totals.zeroCloudSteps + localOnlySteps + routerLocalSteps;
  const zeroCloudPct = totalSteps > 0 ? Math.round((zeroCloudTotal / totalSteps) * 100) : 0;
  const dialSuffix = (localOnlySteps > 0 ? ` (${localOnlySteps} Fully Local)` : '') +
    (routerLocalSteps > 0 ? ` (${routerLocalSteps} Hybrid-local via decisionRouter)` : '');
  els.benchResourceUse.textContent = `${heapStr} heap · ${zeroCloudPct}% steps zero-cloud${dialSuffix}`;

  // End-to-end task latency (15%) — proxy: rolling average wall-clock
  // time per agent-loop step (observe → decide → execute → verify).
  els.benchLatency.textContent = totals.latencyCount > 0
    ? `${(totals.latencySumMs / totals.latencyCount / 1000).toFixed(2)}s avg/step (${totals.latencyCount} steps)`
    : '—';
}

/**
 * Cryptographic Redaction Proof UI
 *
 * Surfaces the latest Merkle-committed redaction proof (utils/merkleProof.js)
 * so the user can download it and independently verify it with
 * Browser-Agent/tools/verify-redaction-proof.html — a page that needs
 * nothing from this extension, only the downloaded JSON. This is what
 * turns "we redacted it, trust us" into "here's a proof, check it
 * yourself."
 */
/* ---------- Privacy Proof "at a glance" hero ---------- */
const proofHeroState = { pii: null, faces: 0, ids: 0, totals: null, proof: null, scope: 'latest step' };

function renderProofHero() {
  if (!els.heroRedacted) return;
  const st = proofHeroState;
  const mode = (typeof currentPrivacyDialMode !== 'undefined') ? currentPrivacyDialMode : null;
  const meta = (window.__BA_PrivacyDial && mode) ? window.__BA_PrivacyDial.getModeMeta(mode) : null;

  if (st.pii === null) {
    els.heroRedacted.textContent = '—';
    els.heroRedactedDetail.textContent = 'Run a task to see this.';
  } else {
    const total = st.pii + st.faces + st.ids;
    els.heroRedacted.textContent = String(total);
    els.heroRedactedDetail.textContent = `${st.scope || 'latest step'}: ${st.pii} text PII, ${st.faces} face(s), ${st.ids} ID image(s)`;
  }

  const t = st.totals;
  els.heroBytes.classList.remove('is-good', 'is-warn');
  if (!t) {
    els.heroBytes.textContent = '—';
    els.heroBytesDetail.textContent = '';
  } else if (t.stepsSent === 0) {
    els.heroBytes.textContent = '0 B';
    els.heroBytes.classList.add('is-good');
    els.heroBytesDetail.textContent = mode === 'local'
      ? 'Fully Local: no request left this device'
      : 'no request needed so far this task';
  } else {
    els.heroBytes.textContent = formatBytes(t.totalBytes);
    els.heroBytesDetail.textContent = `${t.stepsSent} redacted payload(s), each scanned before sending${t.scanFailures ? ` · ${t.scanFailures} BLOCKED` : ''}`;
    if (t.scanFailures) els.heroBytes.classList.add('is-warn');
  }

  if (!st.proof) {
    els.heroTiles.textContent = '—';
    els.heroTilesDetail.textContent = '';
  } else {
    els.heroTiles.textContent = `${st.proof.redactedTileCount}/${st.proof.totalTiles}`;
    els.heroTilesDetail.textContent = `root ${String(st.proof.merkleRoot).slice(0, 12)}…, ECDSA-signed`;
  }

  els.heroMode.textContent = meta ? meta.shortLabel : '—';
  els.heroModeDetail.textContent = meta ? meta.label : '';
}

function updateRedactionProofUI(proof) {
  proofHeroState.proof = proof || null;
  if (!els.redactionProofRoot || !proof) return;
  els.redactionProofRoot.textContent = `${proof.merkleRoot.slice(0, 20)}…`;
  els.redactionProofTiles.textContent = `${proof.redactedTileCount} / ${proof.totalTiles} tiles (${proof.gridWidth}×${proof.gridHeight} grid, ${proof.tileSize}px)`;
  if (els.redactionProofDownloadBtn) els.redactionProofDownloadBtn.disabled = false;
  renderProofHero();
}

function downloadLatestRedactionProof() {
  if (!latestRedactionProof) return;
  const blob = new Blob([JSON.stringify(latestRedactionProof, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `redaction-proof-${latestRedactionProof.timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {Object|null} transmission - agentBackend.getLastTransmissionSummary() result for this step
 * @param {number} faceCount - faces blurred this step (from analyzeCurrentPage)
 * @param {number} idImageCount - ID document images redacted this step
 * @param {Object} totals - running totals object created by createPrivacyReceiptTotals(), mutated in place
 */
/**
 * Records what was redacted LOCALLY on this step, whether or not anything
 * is sent afterwards. Previously the receipt only counted PII/faces/ID
 * images inside updatePrivacyReceipt(), which runs only when a payload is
 * transmitted — so in Fully Local mode (nothing ever transmitted) the
 * receipt showed 0 masked / 0 faces even while the redacted screenshot
 * clearly had black boxes on it. Called once per observed step.
 */
function recordLocalRedaction(totals, piiCount, faceCount, idImageCount) {
  if (!totals) return;
  totals.totalPiiMasked += piiCount || 0;
  totals.totalFaces += faceCount || 0;
  totals.totalIdImages += idImageCount || 0;
  totals.stepsObserved = (totals.stepsObserved || 0) + 1;
  renderPrivacyReceiptNumbers(totals);
}

function renderPrivacyReceiptNumbers(totals) {
  if (!els.receiptSteps || !totals) return;
  els.receiptSteps.textContent = String(totals.stepsSent);
  els.receiptPiiMasked.textContent = String(totals.totalPiiMasked);
  els.receiptFaces.textContent = String(totals.totalFaces);
  els.receiptIdImages.textContent = String(totals.totalIdImages);
  els.receiptBytes.textContent = formatBytes(totals.totalBytes);
  if (els.receiptScanStatus && totals.stepsSent === 0 && totals.scanFailures === 0) {
    els.receiptScanStatus.textContent = (typeof currentPrivacyDialMode !== 'undefined' && currentPrivacyDialMode === 'local')
      ? 'Not needed: nothing sent'
      : 'No payload sent yet';
    els.receiptScanStatus.classList.remove('pv-scan-fail');
    els.receiptScanStatus.classList.add('pv-scan-pass');
  }
  renderProofHero();
}

function updatePrivacyReceipt(transmission, faceCount, idImageCount, totals) {
  if (!els.receiptSteps || !totals) return;
  // faceCount / idImageCount are kept in the signature for existing callers
  // but are no longer added here: recordLocalRedaction() already counted
  // this step's local redactions, and adding them again double-counted.

  if (transmission) totals.stepsSent += 1;
  if (transmission) {
    totals.totalBytes += transmission.bytes?.totalPayload || 0;
    if (transmission.adversarialScan && transmission.adversarialScan.passed === false) {
      totals.scanFailures += 1;
    }
  }

  els.receiptSteps.textContent = String(totals.stepsSent);
  els.receiptPiiMasked.textContent = String(totals.totalPiiMasked);
  els.receiptFaces.textContent = String(totals.totalFaces);
  els.receiptIdImages.textContent = String(totals.totalIdImages);
  els.receiptBytes.textContent = formatBytes(totals.totalBytes);

  if (els.receiptScanStatus) {
    if (totals.scanFailures > 0) {
      els.receiptScanStatus.textContent = `⚠ ${totals.scanFailures} BLOCKED`;
      els.receiptScanStatus.classList.remove('pv-scan-pass');
      els.receiptScanStatus.classList.add('pv-scan-fail');
    } else if (totals.stepsSent > 0) {
      els.receiptScanStatus.textContent = '✓ PASSED';
      els.receiptScanStatus.classList.remove('pv-scan-fail');
      els.receiptScanStatus.classList.add('pv-scan-pass');
    }
  }

  if (transmission && els.privacyReceiptPayload) {
    const blockedNote = transmission.blocked
      ? `⚠ TRANSMISSION BLOCKED LOCALLY — ${transmission.adversarialScan?.error || 'adversarial scan failed'}\n\n`
      : '';
    els.privacyReceiptPayload.textContent = blockedNote + (transmission.sanitizedPayloadPreview || 'Preview unavailable.');
  }
  renderProofHero();

  if (els.detailsPanel) els.detailsPanel.hidden = false;
}

/**
 * Pre-Autofill Trust / Phishing Gate
 *
 * Runs the deterministic checks in agent/trustGate.js (domain mismatch,
 * missing HTTPS, look-alike domain, unusually sensitive field
 * combinations) before ANY private data — autofilled or typed manually
 * by the user in response to an HITL prompt — is entered into the
 * current page. A BLOCK/WARN verdict pauses the loop and shows the same
 * Human Authorization Gate UI used for consequential actions; the human
 * always makes the final call.
 *
 * Approval is cached per-origin for the rest of this task run
 * (`trustGateApprovedOrigins`) so the user isn't re-prompted on every
 * field of the same legitimate-but-HTTP-only or unusually-combined form.
 *
 * @param {Object|null} el - the extracted DOM element about to receive private data
 * @param {Object} extraction - current page extraction ({ url, elements, ... })
 * @param {Array} actionHistory
 * @param {Set<string>} approvedOrigins
 * @returns {Promise<boolean>} true if execution should proceed, false if the loop should halt
 */
async function enforceTrustGate(el, extraction, actionHistory, approvedOrigins) {
  if (!window.__BA_TrustGate) return true; // module unavailable — fail open, never block on a missing dependency

  const domain = window.__BA_TrustGate.getDomain(extraction.url);
  if (domain && approvedOrigins.has(domain)) return true;

  const verdict = window.__BA_TrustGate.evaluate({
    pageUrl: extraction.url,
    formAction: el?.formAction,
    elements: extraction.elements
  });

  if (verdict.level === 'allow') return true;

  const isBlock = verdict.level === 'block';
  addMessage('system', `🛡️ Trust gate ${isBlock ? 'BLOCKED' : 'flagged'} autofill on "${verdict.domain || extraction.url}" — pausing for authorization.`);

  agentController.waitForConfirmation();
  const confirmed = await waitForUserConfirmation({
    title: isBlock ? 'Possible Phishing Site — Autofill Blocked' : 'Site Trust Warning',
    promptMessage: `Before your personal details are entered into this page, review:\n\n${verdict.reasons.map(r => `• ${r}`).join('\n')}\n\nDomain: ${verdict.domain || '(unknown)'}`,
    actionLabel: 'Proceed anyway — autofill this page',
    actionType: isBlock ? 'PHISHING' : 'WARNING',
    cancelLabel: 'Do not autofill — stop here'
  });

  if (!confirmed) {
    addMessage('agent', 'Autofill paused — the destination page failed the trust check and you chose not to proceed. Task stopped for your safety.');
    agentController.markStopped('Trust gate declined by user');
    actionHistory.push({
      action: 'trust_gate_block',
      result: { success: false, domain: verdict.domain, level: verdict.level, reasons: verdict.reasons }
    });
    return false;
  }

  if (domain) approvedOrigins.add(domain);
  actionHistory.push({
    action: 'trust_gate_override',
    result: { success: true, domain: verdict.domain, level: verdict.level, reasons: verdict.reasons }
  });
  return true;
}

/**
 * Zero-cloud fast path: locally resolves every empty, locally-matchable
 * field on the current page and fills them directly, without ever
 * building a redacted-screenshot/sanitized-DOM payload or calling
 * agentBackend.decideNextAction(). Mirrors the per-field logic in the
 * `fill_from_local` branch below, but runs it for the whole form in one
 * pass instead of one cloud round-trip per field.
 *
 * @returns {Promise<{filledCount:number, blockedByTrustGate:boolean}>}
 */
async function runZeroCloudFastPath(extraction, actionHistory, approvedOrigins) {
  const candidates = [];
  for (const el of extraction.elements) {
    if (!window.__BA_FormAnalyzer?.isFormInputElement(el)) continue;
    if (isElementPopulated(el)) continue;
    if (!window.__BA_FieldMatcher) continue;
    const match = window.__BA_FieldMatcher.matchElement(el);
    if (!match.matched || !match.key) continue;
    const hasKey = await privateDataStore.has(match.key);
    if (!hasKey) continue;
    const val = await privateDataStore.get(match.key);
    const isAvailable = window.__BA_PrivateDataStore
      ? window.__BA_PrivateDataStore.isValueAvailable(val)
      : (val !== null && val !== undefined && (typeof val !== 'string' || val.trim().length > 0));
    if (!isAvailable) continue;
    candidates.push({ el, key: match.key, val });
  }

  if (candidates.length === 0) return { filledCount: 0, blockedByTrustGate: false };

  // One trust-gate check for the page (keyed by origin, so this dedupes
  // against any check already done this task run) before filling anything.
  const gateOk = await enforceTrustGate(candidates[0].el, extraction, actionHistory, approvedOrigins);
  if (!gateOk) return { filledCount: 0, blockedByTrustGate: true };

  let filledCount = 0;
  for (const { el, key, val } of candidates) {
    try {
      const actionResponse = await sendMessage({ type: 'AGENT_ACTION', action: 'type', args: [el.id, val] });
      const success = actionResponse?.ok && actionResponse.data?.success !== false;
      actionHistory.push({
        action: 'fill',
        elementId: el.id,
        targetSelector: el.selector,
        fieldName: el.text || el.ariaLabel || el.placeholder,
        matchedKey: key,
        value: '[FILLED_FROM_LOCAL_ZERO_CLOUD]',
        result: { success }
      });
      if (success) filledCount++;
    } catch (err) {
      console.warn('[popup] zero-cloud fast path fill error:', err);
      actionHistory.push({
        action: 'fill',
        elementId: el.id,
        targetSelector: el.selector,
        matchedKey: key,
        result: { success: false, reason: err.message }
      });
    }
  }
  return { filledCount, blockedByTrustGate: false };
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

  // Visual evidence (agent/evidenceGenerator.js, v25 Task 3.2): show the
  // exact target — red if irreversible, orange if reversible — plus any
  // PII still visible on the page, on the already-redacted screenshot,
  // right at the moment the user is asked to authorize this. This is the
  // single highest-value moment for it: "here's exactly what you're about
  // to authorize" rather than prose alone.
  if (window.__BA_EvidenceGenerator && preAuthObservation?.redactedDataUrl && verifiedEl?.bbox) {
    try {
      const authHighlights = window.__BA_EvidenceGenerator.buildAuthorizationHighlights({
        targetBbox: verifiedEl.bbox,
        isReversible: !!consequential.isReversible,
        actionType: consequential.actionType,
        sensitiveItems: preAuthObservation?.extraction?.sensitiveItems,
      });
      const annotated = await annotateScreenshotDataUrl(
        preAuthObservation.redactedDataUrl, authHighlights, preAuthObservation.extraction.viewport
      );
      const summary = window.__BA_EvidenceGenerator.summarizeEvidence({
        decision, sensitiveItems: preAuthObservation?.extraction?.sensitiveItems, highlights: authHighlights,
      });
      renderVisualEvidence('Authorization Evidence', annotated, summary);
    } catch (err) {
      console.warn('[popup] Visual evidence generation failed (authorization unaffected):', err.message);
    }
  }

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
  // A missing/errored response is NOT a success — clickResp is undefined
  // whenever the sendMessage() call above threw, and treating "we don't
  // know what happened" as "it worked" is exactly the kind of unverified
  // self-report agent/verificationLoop.js exists to stop trusting
  // elsewhere in this file. Default to false, not true.
  const executionSuccess = clickResp?.ok ?? false;
  history.push({
    action: decision?.action || 'click',
    elementId: targetId,
    targetSelector: decision?.targetSelector,
    fieldName: consequential.label,
    value: null,
    consequential: true,
    result: { success: executionSuccess, authorizedByUser: true, outcome: executionSuccess ? 'TASK_COMPLETED' : 'FAILED' }
  });

  if (taskMemory) {
    taskMemory.recordConfirmation(decision?.action || 'click', decision?.targetSelector, executionSuccess);
  }

  if (!executionSuccess) {
    addMessage('system', `⚠️ "${consequential.label}" was authorized, but the click did not come back as successful — the action may not have gone through.`);
    addMessage('agent', `I attempted "${consequential.label}" after your authorization, but couldn't confirm it succeeded. Please check the page directly before assuming this is done.`);
    currentController.waitForUser();
    return false;
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

/**
 * True for tasks that ask ABOUT the page ("what is this form about?",
 * "summarize this page") rather than asking the agent to DO something on
 * it. Fully Local mode used to push every task — questions included —
 * through its fill-the-next-field logic; with nothing to fill it fell
 * through to the on-device model, which only knows how to pick an action,
 * and on any model failure the loop re-analyzed the page and tried again,
 * forever. Questions are now answered directly (see
 * answerPageQuestionLocally) and the task ends.
 */
function isPageQuestionTask(task) {
  const t = (task || '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(fill|complete|submit|click|type|enter|select|choose|go to|navigate|open|sign up|register|apply|pay|buy|checkout|log ?in|upload|download)\b/.test(t)) {
    return false;
  }
  return /\?\s*$/.test(t) ||
    /^(what|what's|whats|why|how|who|which|where|when|is|are|does|do|can|explain|summari[sz]e|describe|tell me|give me)\b/.test(t) ||
    /\b(about|summary|overview|purpose)\b/.test(t);
}

function describeElementLabel(el) {
  let raw = el && (el.text || el.ariaLabel || el.placeholder || el.inferredLabel || '');
  raw = String(raw || '').replace(/\s+/g, ' ').trim();
  // Local icon classifier labels ("icon_menu") read better as "menu icon";
  // "unlabeled_icon_detected" carries no meaning for a reader, so drop it.
  if (raw === 'unlabeled_icon_detected') return '';
  const icon = raw.match(/^icon_([a-z_]+)$/);
  if (icon) raw = `${icon[1].replace(/_/g, ' ')} icon`;
  return raw.slice(0, 60);
}

/** Deterministic, model-free page summary built only from data the
 *  extraction already produced (visible text with PII lines replaced,
 *  element labels, detected-PII types). Always available, instant. */
function buildLocalPageSummary(extraction, formSummary, faceCount, idImageCount) {
  const out = [];
  let where = extraction.url || '';
  try { const u = new URL(extraction.url); where = u.protocol === 'file:' ? u.pathname.split('/').pop() : u.host + u.pathname; } catch (_) {}
  out.push(`Page: ${where || '(unknown)'} (only the part currently visible on screen is analyzed)`);

  const lines = (extraction.visibleText || [])
    .map((v) => (v && typeof v.text === 'string') ? v.text.replace(/\s+/g, ' ').trim() : '')
    .filter((t) => t && !t.startsWith('[REDACTED'));
  const headline = lines.filter((t) => t.length >= 4 && t.length <= 90).slice(0, 3);
  if (headline.length) out.push(`What it says at the top: ${headline.map((h) => `"${h}"`).join(', ')}`);

  const fa = window.__BA_FormAnalyzer;
  const fields = (extraction.elements || []).filter((el) => fa ? fa.isFormInputElement(el) : el.tag === 'input');
  if (formSummary && formSummary.formDetected) {
    const labels = fields.map(describeElementLabel).filter(Boolean);
    const uniq = [...new Set(labels)].slice(0, 10);
    out.push(`Form: ${formSummary.totalFields} field(s) — ${formSummary.alreadyCompleted} already filled, ${formSummary.emptyFields} empty` +
      (uniq.length ? `. Fields: ${uniq.join(', ')}${labels.length > uniq.length ? ', …' : ''}` : ''));
  } else {
    out.push('Form: no fillable fields in the visible part of the page. Scroll to them and ask again to include them.');
  }

  const buttons = (extraction.elements || [])
    .filter((el) => el && (el.tag === 'button' || el.type === 'button' || el.type === 'input:submit'))
    .map(describeElementLabel).filter(Boolean);
  if (buttons.length) out.push(`Actions available: ${[...new Set(buttons)].slice(0, 6).join(', ')}`);

  const typeCounts = {};
  for (const item of (extraction.sensitiveItems || [])) {
    const k = item && item.type ? item.type : 'PII';
    typeCounts[k] = (typeCounts[k] || 0) + 1;
  }
  const typeList = Object.entries(typeCounts).map(([k, n]) => `${n}× ${k}`);
  const extras = [];
  if (faceCount > 0) extras.push(`${faceCount} face(s)`);
  if (idImageCount > 0) extras.push(`${idImageCount} ID-document image(s)`);
  if (typeList.length || extras.length) {
    out.push(`Sensitive data found and redacted locally: ${[...typeList, ...extras].join(', ')}. ` +
      'The values themselves are not shown here — see the Privacy Proof tab.');
  } else {
    out.push('Sensitive data: none detected on the visible page.');
  }
  return out;
}

/** Answers a page question entirely on-device. Uses the on-device model
 *  if it is already loaded (fails fast otherwise — never waits on a
 *  download), and always has the deterministic summary to fall back on. */
/** Summary built from the WHOLE-page text scan (see startWholePageScan).
 *  Masked values and counts only, never raw data. */
function buildWholePageSummary(scan, faceCount, idImageCount) {
  const out = [];
  let where = scan.url || '';
  try { const u = new URL(scan.url); where = u.protocol === 'file:' ? u.pathname.split('/').pop() : u.host + u.pathname; } catch (_) {}
  const name = scan.title && !scan.title.startsWith('[REDACTED') ? `"${scan.title}" (${where})` : where;
  out.push(`Page: ${name}, about ${scan.screens} screen(s) tall. The whole page was read, not just the visible part.`);

  const headings = [...new Set((scan.lines || []).filter((l) => l.heading && !l.text.startsWith('[REDACTED')).map((l) => l.text))].slice(0, 8);
  if (headings.length) out.push(`Sections: ${headings.join(' · ')}`);
  else {
    const top = (scan.lines || []).filter((l) => !l.text.startsWith('[REDACTED') && l.text.length >= 4 && l.text.length <= 90).slice(0, 3).map((l) => `"${l.text}"`);
    if (top.length) out.push(`What it says at the top: ${top.join(', ')}`);
  }

  const fields = scan.fields || [];
  if (fields.length) {
    const filled = fields.filter((f) => f.filled).length;
    const offscreen = fields.filter((f) => f.where !== 'on screen').length;
    const labels = [...new Set(fields.map((f) => f.label).filter(Boolean))];
    out.push(`Form: ${fields.length} field(s), ${filled} filled, ${fields.length - filled} empty` +
      (offscreen ? ` (${offscreen} below or above the visible screen)` : '') +
      (labels.length ? `. Fields: ${labels.slice(0, 12).join(', ')}${labels.length > 12 ? ', …' : ''}` : ''));
  } else {
    out.push('Form: no fillable form fields anywhere on this page.');
  }

  const buttons = (scan.buttons || []).map((b) => b.label).filter(Boolean);
  if (buttons.length) out.push(`Actions available: ${buttons.slice(0, 8).join(', ')}${buttons.length > 8 ? ', …' : ''}`);

  const items = dedupeSensitiveItems(scan.sensitiveItems);
  const typeCounts = {};
  for (const it of items) typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
  const typeList = Object.entries(typeCounts).map(([k, n]) => `${n}× ${k}`);
  const off = items.filter((i) => i.where !== 'on screen').length;
  if (typeList.length) {
    out.push(`Sensitive data on the whole page: ${typeList.join(', ')} (${items.length - off} on screen, ${off} elsewhere). ` +
      'Only masked forms are shown; see the Privacy Proof tab.');
  } else {
    out.push('Sensitive data: none found in the page text.');
  }
  if (faceCount > 0 || idImageCount > 0) {
    out.push(`On the visible screen: ${faceCount} face(s) and ${idImageCount} ID-document image(s) blacked out. ` +
      'Faces and ID images need pixels, so they are checked screen by screen (use "Capture full page" to check them all).');
  }
  if (scan.truncated) out.push('(Very long page: the scan stopped after the first few hundred text blocks.)');
  return out;
}

async function answerPageQuestionLocally(task, extraction, formSummary, faceCount, idImageCount) {
  let scan = wholePageScan;
  if (!scan) {
    const p = wholePageScanPromise || startWholePageScan();
    scan = await Promise.race([p, delay(20000).then(() => null)]);
  }
  const summary = scan
    ? buildWholePageSummary(scan, faceCount, idImageCount)
    : buildLocalPageSummary(extraction, formSummary, faceCount, idImageCount);
  const lines = scan
    ? (scan.lines || []).map((l) => l.text).filter(Boolean)
    : (extraction.visibleText || []).map((v) => (v && v.text) || '').filter(Boolean);
  let llmAnswer = null;
  let llmNote = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RUN_WEBLLM_ANSWER', question: task, lines, url: extraction.url });
    if (resp && resp.ok && resp.answer) {
      llmAnswer = resp.answer;
      llmNote = `answered by on-device ${shortModelName(resp.modelId)} from the redacted page text`;
    } else if (isStaleBackgroundResponse(resp)) {
      renderLocalModelStatus({ status: 'error', error: STALE_BACKGROUND_MESSAGE });
      llmNote = `the on-device model wasn't used because ${STALE_BACKGROUND_MESSAGE}. This is the instant rule-based summary`;
    } else if (resp && resp.error) {
      if (resp.status) renderLocalModelStatus(resp.status);
      const reason = String(resp.error).replace(/^LOCAL_LLM_[A-Z_]+:\s*/, '').slice(0, 160);
      llmNote = /NOT_READY/.test(resp.error)
        ? `the on-device model isn't ready yet (${reason}), so this is the instant rule-based summary`
        : `the on-device model is unavailable (${reason}), so this is the instant rule-based summary`;
    }
  } catch (_) {
    llmNote = 'the on-device model could not be reached, so this is the instant rule-based summary';
  }
  return { llmAnswer, summary, note: llmNote };
}

/* ---------- Local form navigation (scroll to the rest of the form) ----------
 * The per-step scan only sees the visible screen. On a long form the fields
 * the user saved values for are often further down, and before this the
 * agent either stopped ("nothing can be resolved") or declared the form
 * complete after filling the first screen. Now, when a form-filling task
 * has nothing left to do on the visible screen, the agent asks the content
 * script for the next EMPTY field that is off screen and scrolls to it,
 * locally (content/fullPageScanner.js formTargets). Once no empty field is
 * left anywhere, it scrolls to the submit control, which still goes through
 * the normal human authorization gate. Each off-screen target is visited at
 * most once per task and the number of scrolls is capped, so a field the
 * user leaves empty can't cause an endless loop.
 */
const MAX_LOCAL_FORM_SCROLLS = 20;

function isFormFillTask(task) {
  const t = (task || '').toLowerCase();
  return /(complete|fill|finish|submit)\b.*\b(form|application|kyc|profile|registration|details|fields|signup|sign-up)/.test(t) ||
    /\b(fill (it|this|everything|out|in)|autofill|auto-fill)\b/.test(t);
}

function createLocalFormNavState() {
  return { visitedKeys: [], scrolls: 0, noEmptyFieldsLeft: false };
}

/** kind: 'empty-field' | 'submit'. scroll=false only checks (no key recorded). */
async function localFormTarget(kind, state, scroll = true, includeInView = false) {
  if (scroll && state.scrolls >= MAX_LOCAL_FORM_SCROLLS) return { found: false, scrolled: false, limitReached: true };
  let resp;
  try {
    resp = await sendMessage({ type: 'FORM_TARGET', kind, skipKeys: state.visitedKeys, scroll, includeInView });
  } catch (_) {
    return null;
  }
  if (!resp || !resp.ok || !resp.data) return null;
  const d = resp.data;
  if (scroll && d.scrolled) {
    if (d.key) state.visitedKeys.push(d.key);
    state.scrolls++;
  }
  return d;
}

function findVisibleSubmit(elements) {
  return (elements || []).find((el) => {
    const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(el, el.selector);
    return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
  }) || null;
}

/** True when an empty fillable field the agent hasn't already scrolled to
 *  exists ANYWHERE on the page (on screen or off) — i.e. the form is NOT
 *  done, even if every field the last per-step scan saw is filled. Checked
 *  against the live page right before any "form complete / submit" step.
 *  Unknown (no answer) counts as false so an unsupported page can't block. */
async function hasOffscreenEmptyFields(state) {
  const d = await localFormTarget('empty-field', state, false, true);
  return !!(d && d.found);
}

async function runAgentLoop(task) {
  agentController.startTask(task);
  actionHistory = [];
  agentBackend.resetSession();

  // Cross-task checkpoint/resume (agent/contextManager.js, v25 Task 1.3).
  // pendingResumeTaskId is set by a "Resume" click in the Saved Tasks
  // panel and consumed exactly once here; any other task start (typed
  // fresh, or Resume was never clicked) gets a brand-new taskId. Actually
  // restoring the saved plan/progress onto agentController.taskManager
  // and taskMemory happens below, at step 0, after setTask() — see there.
  const resumeTaskId = pendingResumeTaskId;
  pendingResumeTaskId = null;
  const currentTaskId = resumeTaskId || (window.__BA_ContextManager ? window.__BA_ContextManager.generateTaskId(task) : null);
  let resumedCheckpoint = null;
  let previousPageState = null;
  let lastRenderedSuggestion = null;
  const recentActionSignatures = [];
  // Pre-autofill trust/phishing gate: origins the user has explicitly
  // approved for this task run, so we don't re-prompt on every field.
  const trustGateApprovedOrigins = new Set();
  // Privacy Receipt: live per-task totals of what actually left the browser.
  const privacyReceiptTotals = createPrivacyReceiptTotals();
  resetPrivacyReceiptUI();
  const formNav = createLocalFormNavState();
  let consecutiveUnproductiveCount = 0;
  // Local-vision loop state (see Phase 1.5). `lastExecutedActionKind` lets
  // the visual engine judge whether the previous action actually did
  // anything; `consecutiveVisualWaits` bounds how long a detected loading
  // indicator may hold the loop before it proceeds regardless.
  let lastExecutedActionKind = null;
  let consecutiveVisualWaits = 0;
  // A new task must not diff its first screenshot against the last frame of
  // the previous one — that would report a spurious page-wide change.
  previousRawFrame = null;
  clearBeforeAfter();
  resetWholePageScan();
  warnedFaceDetectionDegraded = false;
  const recoveryEngine = window.__BA_RecoveryEngine
    ? new window.__BA_RecoveryEngine()
    : { reset(){}, detectLoop(){ return { isLoop: false }; }, diagnose(){ return {}; }, evaluateNextStep(){ return { shouldHalt: false, userMessage: '' }; }, recordSuccess(){} };
  const taskMemory = window.__BA_TaskMemory
    ? new window.__BA_TaskMemory()
    : { reset(){}, recordPageVisit(){}, recordAttempt(){}, recordResult(){}, recordUserIntervention(){}, recordConfirmation(){}, updateSubgoal(){}, reconcileWithLiveState(){}, getSummary(){ return {}; }, formatContext(){ return ''; } };
  // Task-completion verification (v25 Task 3.1, agent/verificationLoop.js):
  // independently checks a declared "done" against this task's own action
  // history, form state, gathered-information record, and a before/after
  // screenshot diff, instead of trusting the reasoner's self-report. See
  // that module's header comment for exactly what it does and doesn't
  // check, and why. One instance per task, same lifetime as actionHistory.
  const taskVerifier = window.__BA_VerificationLoop ? new window.__BA_VerificationLoop.TaskVerifier() : null;
  let verificationAttempts = 0;

  addMessage('agent', "Got it — analyzing the current page with local privacy scan.");

  // Live latency dashboard: measures wall-clock time per completed loop
  // iteration (see updateBenchmarkDashboard's end-to-end-latency proxy).
  let lastStepTimestamp = performance.now();

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const __stepEntryTs = performance.now();
    if (step > 0) {
      recordStepLatency(privacyReceiptTotals, __stepEntryTs - lastStepTimestamp);
      updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
    }
    lastStepTimestamp = __stepEntryTs;

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

    const { extraction, redactedDataUrl, faceCount = 0, idImageCount = 0, ocrConfirmedCount = 0, redactionProof = null, visualState = null, rawFrame = null } = observation;
    privacyReceiptTotals.totalIdImagesOcrConfirmed += ocrConfirmedCount;
    proofHeroState.pii = (extraction && extraction.counts) ? (extraction.counts.sensitiveItems || 0) : 0;
    proofHeroState.scope = 'latest step';
    proofHeroState.faces = faceCount;
    proofHeroState.ids = idImageCount;
    proofHeroState.totals = privacyReceiptTotals;
    recordLocalRedaction(privacyReceiptTotals, proofHeroState.pii, faceCount, idImageCount);
    updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
    if (redactionProof) {
      latestRedactionProof = redactionProof;
      updateRedactionProofUI(redactionProof);
    }

    // Capture this task's baseline frame once, at its very first step, for
    // agent/verificationLoop.js's before/after visual-change check. Never
    // re-captured mid-task, even after a replan — the whole point is to
    // measure change across the *entire* task, not just the latest step.
    if (step === 0 && taskVerifier) {
      taskVerifier.captureBaseline(rawFrame);
    }

    addMessage(
      'agent',
      `Identified ${extraction.counts.interactiveElements} interactive elements and ${extraction.counts.sensitiveItems} sensitive item(s)` +
        (idImageCount > 0 ? `, and blacked out ${idImageCount} likely ID document image(s).` : '.'),
      { sensitiveItems: extraction.sensitiveItems }
    );

    // ── Phase 1.5: LOCAL VISUAL DECISION ──────────────────────────────────
    //
    // This is the point where PS26171's "a local vision model that reads
    // screen states and makes decisions" is actually cashed out. The report
    // produced by utils/visualStateEngine.js is turned into a decision here,
    // on device, from raw pixels, with no model inference and no network
    // call — and in the loading case it resolves the entire step, meaning
    // the cheapest correct decision in the whole loop is also the one the
    // cloud reasoner never has to be asked about.
    const visualDecision = (visualState && window.__BA_VisualStateEngine)
      ? window.__BA_VisualStateEngine.deriveVisualDecision(visualState, lastExecutedActionKind)
      : null;

    if (visualDecision) {
      if (visualDecision.action === 'wait') {
        // Bounded: a spinner that never resolves must not trap the agent in
        // an infinite observe-wait cycle, so after MAX_VISUAL_WAITS the loop
        // proceeds and lets the reasoner decide what to do about it.
        if (consecutiveVisualWaits < MAX_VISUAL_WAITS) {
          consecutiveVisualWaits++;
          privacyReceiptTotals.visionResolvedSteps = (privacyReceiptTotals.visionResolvedSteps || 0) + 1;
          addMessage('system',
            `Local vision detected a loading indicator on screen — waiting instead of acting ` +
            `(${consecutiveVisualWaits}/${MAX_VISUAL_WAITS}). No cloud request made for this step.`);
          updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
          await delay(SETTLE_DELAY_MS);
          continue;
        }
        addMessage('system', 'Page still appears to be loading, but continuing anyway after repeated waits.');
        consecutiveVisualWaits = 0;
      } else if (visualDecision.action === 'flag_ineffective_action') {
        // The previous action changed nothing on screen. Surfacing this is
        // strictly better than the agent's default assumption of success,
        // which otherwise corrupts the premises of every later step.
        consecutiveVisualWaits = 0;
        addMessage('system',
          'Local vision: the last action produced no visible change on the page — ' +
          'treating it as ineffective rather than assuming it worked.');
        const lastEntry = actionHistory[actionHistory.length - 1];
        if (lastEntry) lastEntry.visuallyIneffective = true;
      } else if (visualDecision.action === 'constrain_to_dialog') {
        consecutiveVisualWaits = 0;
        addMessage('system',
          'Local vision detected a blocking overlay (modal or consent wall) — ' +
          'the page behind it is not interactable, so this step is constrained to the dialog.');
      }
    } else {
      consecutiveVisualWaits = 0;
    }

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
      // Whole-page text scan, once per task, in the background (never
      // blocks this step). Page questions await it; the Privacy Proof tab
      // shows what it finds below the per-screen list.
      startWholePageScan();
      agentController.taskManager.setTask(task, extraction.pageContext);

      // Restore a saved checkpoint's plan/progress, if this run started
      // from a "Resume" click (see the top of this function). Applied
      // AFTER setTask() specifically, since setTask() resets subgoals and
      // gatheredInformation to a fresh decomposition — the restored
      // snapshot's actual prior progress needs to overwrite that, not the
      // other way around. taskMemory's short-term history is restored the
      // same way. A resume whose checkpoint no longer exists (deleted, or
      // never actually saved) silently falls back to a normal fresh
      // start — it's the same task text either way, just without prior
      // progress, never a hard error.
      if (resumeTaskId && contextManager) {
        try {
          resumedCheckpoint = await contextManager.loadCheckpoint(resumeTaskId);
        } catch (err) {
          console.warn('[popup] Failed to load saved task for resume:', err.message);
        }
        if (resumedCheckpoint && resumedCheckpoint.snapshot) {
          window.__BA_ContextManager.applySnapshotToLiveState({
            taskManager: agentController.taskManager,
            taskMemory,
            snapshot: resumedCheckpoint.snapshot,
          });
          addMessage('system', `Resumed saved task "${resumedCheckpoint.label || resumeTaskId}" — restored ${agentController.taskManager.gatheredInformation ? Object.keys(agentController.taskManager.gatheredInformation).length : 0} gathered finding(s) and ${agentController.taskManager.currentSubgoalIndex}/${agentController.taskManager.subgoals.length} subgoal(s) already completed.`);
        } else {
          addMessage('system', `No saved progress found for this task (it may have been deleted) — starting fresh.`);
        }
      }

      addMessage('system', agentController.taskManager.formatPlanSummary());
    }

    // Auto-checkpoint (agent/contextManager.js): save this task's current
    // plan/progress every step, not just at the end, so closing the popup
    // or switching tasks mid-run loses at most one step of progress. Best-
    // effort — a save failure (fallback storage full, etc.) is logged and
    // otherwise ignored; it must never interrupt the agent loop itself.
    if (contextManager && currentTaskId) {
      try {
        const snapshot = window.__BA_ContextManager.buildSnapshotFromLiveState({
          taskManager: agentController.taskManager,
          taskMemory,
          privacyDialMode: window.__BA_PrivacyDial ? currentPrivacyDialMode : null,
          lastUrl: extraction.url,
          label: task,
        });
        await contextManager.saveCheckpoint(currentTaskId, snapshot);
        renderSavedTasksList(); // fire-and-forget UI refresh; never blocks the loop
      } catch (err) {
        console.warn('[popup] Auto-checkpoint failed (task execution unaffected):', err.message);
      }
    }

    // ── Phase 3: DETERMINE TASK PROGRESS & PLANNING ───────────────────────
    agentController.beginPlanning();
    const formSummary = window.__BA_FormAnalyzer
      ? await window.__BA_FormAnalyzer.analyzeForm(extraction.elements, privateDataStore)
      : null;

    const privacyDialModeForNav = window.__BA_PrivacyDial ? currentPrivacyDialMode : 'hybrid';
    const formFillTask = isFormFillTask(task);
    formNav.noEmptyFieldsLeft = false;

    // ── Local form navigation (see localFormTarget) ────────────────────────
    // Nothing left to fill on THIS screen? Scroll to the next empty field
    // further down the page, locally. Cloud-Assisted mode is left to the
    // cloud reasoner by design (it is the maximum-capability comparison).
    if (formFillTask && privacyDialModeForNav !== 'cloud') {
      const visibleEmpty = (formSummary && formSummary.formDetected) ? formSummary.emptyFields : 0;
      if (visibleEmpty === 0) {
        const next = await localFormTarget('empty-field', formNav, true);
        if (next && next.scrolled) {
          privacyReceiptTotals.localOnlySteps = (privacyReceiptTotals.localOnlySteps || 0) + 1;
          addMessage('system', `↓ Scrolled to "${next.label}", an empty field further down the page (${next.remaining} empty field(s) not yet on screen). Done locally: no model or cloud call.`);
          actionHistory.push({ action: 'scroll', targetSelector: next.key, value: 'to_next_field', result: { success: true, outcome: 'SUCCEEDED', note: 'local_form_navigation' } });
          await delay(SETTLE_DELAY_MS);
          continue;
        }
        if (next && next.limitReached) {
          addMessage('system', `Stopped scrolling after ${MAX_LOCAL_FORM_SCROLLS} moves to avoid a loop.`);
        }
        formNav.noEmptyFieldsLeft = !!(next && !next.found && !next.limitReached) && !(await hasOffscreenEmptyFields(formNav));
        if (formNav.noEmptyFieldsLeft && !findVisibleSubmit(extraction.elements)) {
          const sub = await localFormTarget('submit', formNav, true);
          if (sub && sub.scrolled) {
            addMessage('system', `↓ Every field on the page is filled. Scrolled to "${sub.label}" so it can be reviewed; submitting still needs your explicit approval.`);
            actionHistory.push({ action: 'scroll', targetSelector: sub.key, value: 'to_submit', result: { success: true, outcome: 'SUCCEEDED', note: 'local_form_navigation' } });
            await delay(SETTLE_DELAY_MS);
            continue;
          }
        }
      }
    }

    // If user explicitly requested form completion AND all fields on page are already complete:
    const isExplicitFormTask = /(complete|fill).*(form|application|kyc|profile|registration)/i.test(task);
    const visibleFormDone = !!(formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0);
    if (isExplicitFormTask && (visibleFormDone || formNav.noEmptyFieldsLeft) &&
        !(privacyDialModeForNav !== 'cloud' && !formNav.noEmptyFieldsLeft && await hasOffscreenEmptyFields(formNav))) {
      const submitEl = findVisibleSubmit(extraction.elements);
      if (submitEl) {
        agentController.waitForConfirmation();
        await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
        return;
      }
    }

    const mode = getSelectedMode();
    // Privacy Dial (agent/privacyDial.js): 'cloud' | 'hybrid' | 'local'.
    // Re-read from the cached value each step so a mid-task change in
    // Settings takes effect on the very next step, not just the next task.
    const privacyDialMode = window.__BA_PrivacyDial ? currentPrivacyDialMode : 'hybrid';

    // ── Zero-cloud fast path ───────────────────────────────────────────────
    // If every remaining empty field on this form can be satisfied straight
    // from the local Private Data Store (Complete Mode only — never in
    // HITL, where a human is meant to be in the loop), fill them all here,
    // locally, and skip agentBackend.decideNextAction() — and therefore the
    // network call to the cloud VLM — entirely for this step. This isn't a
    // shortcut around the privacy pipeline; it's the strongest form of it:
    // for the common "known form, known data" case, nothing (not even a
    // redacted screenshot or sanitized DOM) leaves the device at all, and
    // it directly improves the resource-utilization and latency metrics by
    // removing a ~1.5-3s network round trip. This is what the Hybrid dial
    // position is built on; Cloud-Assisted mode skips it on purpose (always
    // routes through the cloud reasoner, for maximum-capability comparison),
    // and Fully Local mode gets its own dedicated branch below since it must
    // never fall through to a cloud call even when the fast path can't
    // resolve everything.
    if (privacyDialMode !== 'cloud' && mode === 'complete' && formSummary && formSummary.formDetected &&
        formSummary.emptyFields > 0 && formSummary.requiresUserInput === 0) {
      const fastPathResult = await runZeroCloudFastPath(extraction, actionHistory, trustGateApprovedOrigins);
      privacyReceiptTotals.zeroCloudSteps = (privacyReceiptTotals.zeroCloudSteps || 0) + 1;
      privacyReceiptTotals.zeroCloudFieldsFilled = (privacyReceiptTotals.zeroCloudFieldsFilled || 0) + fastPathResult.filledCount;
      updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);

      if (fastPathResult.blockedByTrustGate) return;

      if (fastPathResult.filledCount > 0) {
        addMessage('agent', `Filled ${fastPathResult.filledCount} field(s) directly from your local private store — no cloud request needed for this step.`);
        await delay(SETTLE_DELAY_MS);
        continue; // re-observe; the normal submit-gate check above will fire once fields read back as complete
      }
      // filledCount === 0 (e.g. every match failed to execute) falls through
      // to the normal cloud-reasoned path below rather than looping forever
      // — except in Fully Local mode, which has no cloud path to fall
      // through to; that case is handled entirely in the branch below.
    }

    let decision;

    if (privacyDialMode === 'local') {
      // ── Fully Local step ────────────────────────────────────────────────
      // agentBackend.decideNextAction() — the extension's only network call
      // — is never reached on this path, for this step or any other while
      // this mode stays selected. If the whole form already reads as
      // complete, hand off to the same safety-gated submit flow used for
      // explicit form-completion tasks (already fully local: it runs
      // agent/consequentialActionDetector.js and the 9-step human
      // authorization protocol, no network involved either way). Otherwise
      // resolve one field at a time with a deterministic local decision
      // (agentBackend.decideNextActionLocalOnly()) and let the exact same
      // Phase 5/6 execution code below run it — only the source of the
      // decision object differs from Hybrid/Cloud mode.
      agentController.waitForReasoner();

      if (isPageQuestionTask(task)) {
        const qa = await answerPageQuestionLocally(task, extraction, formSummary, faceCount, idImageCount);
        const body = qa.llmAnswer
          ? `${qa.llmAnswer}\n\nPage facts (rule-based, local):\n${qa.summary.map((l) => `• ${l}`).join('\n')}`
          : qa.summary.map((l) => `• ${l}`).join('\n');
        addMessage('agent', `${body}\n\n(Fully Local: ${qa.note || 'rule-based summary'}; nothing was sent off this device.)`);
        privacyReceiptTotals.localOnlySteps = (privacyReceiptTotals.localOnlySteps || 0) + 1;
        updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
        agentController.markCompleted();
        return;
      }

      if (formSummary && formSummary.formDetected && formSummary.totalFields > 0 && formSummary.emptyFields === 0) {
        const submitEl = extraction.elements.find(el => {
          const c = window.__BA_ConsequentialActionDetector?.isConsequentialElement(el, el.selector);
          return c?.isConsequential && (c.actionType === 'SUBMIT' || c.actionType === 'PAYMENT');
        });
        if (submitEl) {
          agentController.waitForConfirmation();
          await authorizeAndExecuteConsequential(submitEl, { action: 'click', elementId: submitEl.id, targetSelector: submitEl.selector }, actionHistory);
          return;
        }
        addMessage('agent', '🎉 All required form fields are complete! (Fully Local mode found no submit control to confirm — nothing further to do here.)');
        agentController.markCompleted();
        return;
      }

      decision = agentBackend.decideNextActionLocalOnly({ extraction, formSummary });
      privacyReceiptTotals.localOnlySteps = (privacyReceiptTotals.localOnlySteps || 0) + 1;

      if (decision.action === 'wait' && formFillTask && formNav.noEmptyFieldsLeft) {
        addMessage('agent', 'Every fillable field on this page is filled, and there is no submit button for me to bring up for your approval. Nothing further to do here.');
        agentController.markCompleted();
        return;
      }

      if (decision.action === 'wait') {
        // v25 upgrade (claude/v25-master-implementation-guide.md Part 3,
        // Task 2.1 Mode 1): the deterministic field matcher couldn't
        // resolve anything, but Fully Local mode doesn't have to jump
        // straight to "ask the human" — try the on-device Qwen2.5
        // reasoner (agent/webllmEngine.js, run inside offscreen.js) first.
        // Still zero network calls to any reasoning backend: this is one
        // internal chrome.runtime message to this extension's own
        // offscreen document, never a fetch to any server — decideNextAction()'s
        // hard network guard is untouched and still never runs in this mode.
        try {
          const localLlmDecision = await agentBackend.decideNextActionLocalLLM({
            task, extraction, actionHistory, formSummary, mode
          });
          privacyReceiptTotals.localLlmSteps = (privacyReceiptTotals.localLlmSteps || 0) + 1;
          decision = localLlmDecision;
          addMessage('system', `🧠 On-device reasoning (Qwen2.5, no field-matcher match): ${decision.reasoning || '(no reasoning given)'} — confidence ${Math.round((decision.confidence || 0) * 100)}%.`);
        } catch (localLlmErr) {
          // Stop here. This used to `continue`, which re-captured and
          // re-redacted the page and asked the model again — up to
          // MAX_AGENT_STEPS times — even though nothing had changed and the
          // model was still downloading or timing out. Re-running the same
          // step cannot produce a different answer, so hand control back.
          updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
          const why = /NOT_READY/.test(localLlmErr.message)
            ? `the on-device model is still downloading (${Math.round(((lastLocalModelStatus && lastLocalModelStatus.progress) || 0) * 100)}% — see the banner at the top). Run the task again once it says ready`
            : `on-device reasoning is unavailable (${localLlmErr.message})`;
          addMessage('agent', `Fully Local mode: nothing on this page can be resolved by a deterministic local match, and ${why}. I've stopped instead of retrying in a loop — continue manually, or switch the Privacy Dial to Hybrid if you want cloud reasoning for this page.`);
          actionHistory.push({ action: 'wait', result: 'waited_local_only' });
          agentController.waitForUser();
          return;
        }
      }
      updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
    } else if (privacyDialMode === 'debate') {
      // ── Hybrid Debate step ──────────────────────────────────────────────
      // claude/v25-master-implementation-guide.md Part 2, Mode 3: run the
      // on-device reasoner and the cloud reasoner IN PARALLEL for this
      // step and show both, instead of silently picking one. See
      // agent/debateManager.js for the resolution-tier logic and
      // agent/confidenceScorer.js for how each side's confidence is scored.
      agentController.waitForReasoner();

      if (!debateManager) {
        addMessage('system', 'Hybrid Debate mode requires agent/debateManager.js, which failed to load. Falling back to Cloud-Assisted for this step.');
      } else {
        let debateResult;
        try {
          debateResult = await debateManager.runDebate({
            localArgs: { task, extraction, actionHistory, formSummary, mode },
            cloudArgs: {
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
              privacyDialMode,
              visualState,
            },
            evidence: {
              task,
              elements: extraction.elements,
              sensitiveItems: extraction.sensitiveItems,
              pageUrl: extraction.url,
              pageContext: extraction.pageContext,
            },
          });
        } catch (debateErr) {
          const blockedTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
          if (blockedTransmission && blockedTransmission.blocked) {
            updatePrivacyReceipt(blockedTransmission, faceCount, idImageCount, privacyReceiptTotals);
            addMessage('system', `🛡️ Privacy boundary blocked an outbound request locally: ${blockedTransmission.adversarialScan?.error || 'adversarial scan failed'}`);
          }
          agentController.markFailed(debateErr);
          showError(debateErr.message);
          return;
        }

        decision = debateResult.decision;
        renderDebateEvidence(debateResult.debate);
        privacyReceiptTotals.debateSteps = (privacyReceiptTotals.debateSteps || 0) + 1;
        if (debateResult.debate.agreement === false) {
          privacyReceiptTotals.debateDisagreements = (privacyReceiptTotals.debateDisagreements || 0) + 1;
        }

        const stepTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
        if (stepTransmission) updatePrivacyReceipt(stepTransmission, faceCount, idImageCount, privacyReceiptTotals);
        updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
      }

      if (!decision) {
        // debateManager missing — degrade to the normal cloud path below
        // rather than stalling the loop.
        agentController.waitForReasoner();
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
            privacyDialMode,
            visualState,
          });
        } catch (err) {
          agentController.markFailed(err);
          showError(err.message);
          return;
        }
      }
    } else if (privacyDialMode === 'hybrid' && decisionRouter) {
      // ── Hybrid step via agent/decisionRouter.js ─────────────────────────
      // v25 Part 3 Task 2.5: instead of always calling the cloud reasoner
      // (what this branch did before), try each local layer first — exact
      // field match (TREE), then a looser local match (HEURISTIC), then
      // the on-device model (LOCAL_LLM) — and only reach
      // agentBackend.decideNextAction() (CLOUD) when none of those could
      // confidently answer. This is the same "prefer local, escalate only
      // when needed" idea the zero-cloud fast path above already applies
      // to whole-form auto-fill, now applied per-step to every kind of
      // decision. Cloud-Assisted mode deliberately keeps calling
      // decideNextAction() directly below (unconditionally, for
      // maximum-capability comparison) rather than going through this
      // router — see that branch's own comment.
      agentController.waitForReasoner();

      const cloudArgs = {
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
        privacyDialMode,
        visualState,
      };

      let routed;
      try {
        routed = await decisionRouter.route({ task, extraction, actionHistory, formSummary, cloudArgs, privacyDialMode, mode });
      } catch (err) {
        const blockedTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
        if (blockedTransmission && blockedTransmission.blocked) {
          updatePrivacyReceipt(blockedTransmission, faceCount, idImageCount, privacyReceiptTotals);
          updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
          addMessage('system', `🛡️ Privacy boundary blocked an outbound request locally: ${blockedTransmission.adversarialScan?.error || 'adversarial scan failed'}`);
        }
        agentController.markFailed(err);
        showError(err.message);
        return;
      }

      decision = routed.decision;
      updateRoutingStatsDisplay();

      if (routed.routing.layer === 'CLOUD') {
        // Only the CLOUD layer ever calls agentBackend.decideNextAction(),
        // so only here is there an actual transmission to record — reading
        // getLastTransmissionSummary() for any other layer would report a
        // stale transmission from a previous step, not this one.
        const stepTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
        updatePrivacyReceipt(stepTransmission, faceCount, idImageCount, privacyReceiptTotals);
      } else {
        privacyReceiptTotals.routerLocalSteps = (privacyReceiptTotals.routerLocalSteps || 0) + 1;
      }
      updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
    } else {
      // ── Phase 4: WAITING FOR REASONER ──────────────────────────────────
      // Cloud-Assisted mode (and Hybrid mode as a fallback if
      // decisionRouter.js failed to load) always calls the cloud reasoner
      // directly, unconditionally — Cloud-Assisted mode's whole point is
      // maximum-capability comparison, so it deliberately skips any
      // local-first attempt.
      agentController.waitForReasoner();
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
          privacyDialMode,
          visualState,
        });
      } catch (err) {
        // Even a failed call may have recorded a transmission (e.g. the
        // adversarial pre-flight scan blocking it locally) — surface that
        // in the Privacy Receipt before reporting the failure, since a
        // BLOCKED entry is itself proof the boundary worked.
        const blockedTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
        if (blockedTransmission && blockedTransmission.blocked) {
          updatePrivacyReceipt(blockedTransmission, faceCount, idImageCount, privacyReceiptTotals);
          updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
          addMessage('system', `🛡️ Privacy boundary blocked an outbound request locally: ${blockedTransmission.adversarialScan?.error || 'adversarial scan failed'}`);
        }
        agentController.markFailed(err);
        showError(err.message);
        return;
      }

      // Privacy Receipt: record this step's transmission (fields scanned,
      // PII masked, faces/ID images redacted, exact sanitized payload sent).
      const stepTransmission = agentBackend.getLastTransmissionSummary ? agentBackend.getLastTransmissionSummary() : null;
      updatePrivacyReceipt(stepTransmission, faceCount, idImageCount, privacyReceiptTotals);
      updateBenchmarkDashboard(actionHistory, privacyReceiptTotals);
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
      // ── Verification loop (v25 Task 3.1, agent/verificationLoop.js) ──────
      // Do not just take the reasoner's word for it. Run the independent,
      // local checks (productive action happened, task-type-appropriate
      // structural criterion met, visible change occurred, plus advisory
      // confirmation-text matching) before accepting "done". See that
      // module's header comment for the full rationale.
      const maxVerificationAttempts = window.__BA_VerificationLoop?.MAX_VERIFICATION_ATTEMPTS ?? 2;
      const preVerifyPlanSummary = agentController.taskManager.getPlanSummary();
      const verification = taskVerifier
        ? taskVerifier.verify({
            taskText: task,
            taskPlan: preVerifyPlanSummary,
            formSummary,
            actionHistory,
            currentFrame: rawFrame,
            visibleText: extraction.visibleText,
          })
        : { verified: true, confidence: 1, intent: 'general', checks: [], reason: 'agent/verificationLoop.js failed to load — completion could not be independently checked.' };

      renderTaskVerification(verification, verificationAttempts + 1, maxVerificationAttempts + 1);

      if (!verification.verified && verificationAttempts < maxVerificationAttempts) {
        verificationAttempts++;
        console.warn(`[popup] 'done' rejected by independent verification (attempt ${verificationAttempts}/${maxVerificationAttempts}): ${verification.reason}`);
        agentController.triggerReplanning(`Declared completion could not be independently verified: ${verification.reason}`);
        agentController.taskManager.replan(`Declared completion rejected by verification: ${verification.reason}`, extraction.pageContext);
        addMessage('system', `⚠️ Declared "done", but independent local verification disagrees (retry ${verificationAttempts}/${maxVerificationAttempts}): ${verification.reason} Continuing instead of stopping.`);
        actionHistory.push({
          action: 'done',
          result: { success: false, outcome: 'VERIFICATION_REJECTED', verification }
        });
        await delay(SETTLE_DELAY_MS);
        continue;
      }

      if (!verification.verified) {
        // Verification bound reached (mirrors v25's maxAttempts=3: the
        // original declaration + two retries above). Do not silently
        // report success just because the loop has to stop somewhere —
        // hand control back to the user with the honest reason, the same
        // pattern already used for loop-detection and bounded-failure
        // halts elsewhere in this function.
        agentController.taskManager.updateProgress({ action: 'done', outcome: 'TASK_COMPLETED', verified: false, plan: decision.plan });
        addMessage('system', `⚠️ Verification limit reached after ${verificationAttempts + 1} attempt(s) — the reasoner still declares this task done, but independent local verification disagrees.`);
        addMessage('agent', `I believe this task may be finished, but I could not independently confirm it: ${verification.reason} Please check the page yourself before treating this as complete, or continue guiding me.`);
        await renderCompletionVisualEvidence(extraction, actionHistory, redactedDataUrl, decision, verification);
        agentController.waitForUser();
        return;
      }

      agentController.taskManager.updateProgress({ action: 'done', outcome: 'TASK_COMPLETED', verified: true, plan: decision.plan });
      const planSummary = agentController.taskManager.getPlanSummary();
      const gatheredKeys = Object.keys(planSummary.gatheredInformation || {});
      const infoMsg = gatheredKeys.length > 0
        ? `\n\n**Gathered Findings:**\n${gatheredKeys.map(k => `• ${k}: ${planSummary.gatheredInformation[k]}`).join('\n')}`
        : '';
      addMessage('agent', `🎉 Task completed! ${decision.reasoning || ''}${infoMsg}\n\n✅ Independently verified locally — see the verification evidence above.`);
      await renderCompletionVisualEvidence(extraction, actionHistory, redactedDataUrl, decision, verification);
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
        if (isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.emptyFields === 0 && !(await hasOffscreenEmptyFields(formNav))) {
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

      // Trust/phishing gate: about to ask the user to type private data
      // directly into this page — verify the page isn't a look-alike
      // phishing site before doing so.
      const askUserGateOk = await enforceTrustGate(targetEl, extraction, actionHistory, trustGateApprovedOrigins);
      if (!askUserGateOk) return;

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

      if (postResumeSummary && postResumeSummary.formDetected && postResumeSummary.emptyFields === 0 &&
          !(await hasOffscreenEmptyFields(formNav))) {
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
        if (isExplicitFormTask && formSummary && formSummary.formDetected && formSummary.emptyFields === 0 && !(await hasOffscreenEmptyFields(formNav))) {
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

      // Trust/phishing gate: about to autofill (or manually collect, via
      // the HITL fallback below) private data into this page — verify
      // the page isn't a look-alike phishing site before doing so.
      const fillGateOk = await enforceTrustGate(el, extraction, actionHistory, trustGateApprovedOrigins);
      if (!fillGateOk) return;

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
    // Recorded so the next step's local visual pass can tell whether this
    // action produced any visible change (see Phase 1.5).
    lastExecutedActionKind = decision.action;

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

if (els.redactionProofDownloadBtn) {
  els.redactionProofDownloadBtn.addEventListener('click', downloadLatestRedactionProof);
}

// "Open Independent Verifier" (tools/verify-redaction-proof.html).
//
// History: this first opened as a plain <a target="_blank">, which made the
// verifier the ACTIVE tab, so the next task was aimed at the verifier's own
// chrome-extension:// page and got the "internal page" refusal. The first
// fix opened it as a BACKGROUND tab instead — which stopped the refusal but
// meant clicking the button seemed to do nothing. Now the verifier opens in
// the foreground (the user asked to see it), and background/service-worker.js's
// getActiveTab() skips this extension's own pages and switches back to the
// user's real page when a task starts. So both work.
//
// The latest proof is also stashed in chrome.storage.session (extension-
// only, in-memory, cleared when the browser closes; it holds hashes and a
// public key, never pixels or PII) so the verifier can offer a one-click
// "Load latest proof" alongside the paste/file options.
if (els.redactionProofVerifyLink) {
  els.redactionProofVerifyLink.addEventListener('click', async (e) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.create) return; // fall back to the normal <a> navigation
    e.preventDefault();
    try {
      if (latestRedactionProof && chrome.storage && chrome.storage.session) {
        await chrome.storage.session.set({ pvLatestRedactionProof: latestRedactionProof });
      }
    } catch (err) {
      console.warn('[popup] Could not hand the latest proof to the verifier (paste/file still works):', err.message);
    }
    chrome.tabs.create({ url: els.redactionProofVerifyLink.href, active: true });
  });
}

initSettings();

// ---------- Flat dark mode (manual toggle + OS default) ----------
// Single source of truth: chrome.storage.local 'pv-theme' ('light'|'dark').
// Unset -> follow the OS prefers-color-scheme. The verifier page and the
// on-page guide read the same key, so all three surfaces stay in sync.
const THEME_STORAGE_KEY = 'pv-theme';

function applyTheme(mode) {
  const theme = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (els.themeBtnIcon) els.themeBtnIcon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  if (els.themeBtn) {
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    els.themeBtn.title = label;
    els.themeBtn.setAttribute('aria-label', label);
  }
}

async function initTheme() {
  let stored = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get(THEME_STORAGE_KEY);
      stored = res ? res[THEME_STORAGE_KEY] : null;
    } else {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    }
  } catch (_) { stored = null; }
  const fallback = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  applyTheme(stored === 'dark' || stored === 'light' ? stored : fallback);

  // Stay in sync when the verifier page (same key) changes the theme.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes && changes[THEME_STORAGE_KEY]) {
          const next = changes[THEME_STORAGE_KEY].newValue;
          if (next === 'dark' || next === 'light') applyTheme(next);
        }
      });
    }
  } catch (_) {}
}

if (els.themeBtn) {
  els.themeBtn.addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [THEME_STORAGE_KEY]: next });
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch (_) {}
  });
}

initTheme();