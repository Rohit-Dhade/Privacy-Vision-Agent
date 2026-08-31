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
  statusBarText: document.getElementById('statusBarText')
};

const agentController = new window.__BA_AgentController();
const agentBackend = new window.__BA_AgentBackend();
const userInputManager = new window.__BA_UserInputManager(els.userInputContainer);

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
      case 'ANALYZING_DOM':
      case 'DETECTING_PII':
      case 'CAPTURING_SCREENSHOT':
      case 'REDACTING_SCREENSHOT':
      case 'EVALUATING_READINESS':
        els.statusBarText.textContent = 'ANALYZING PAGE & PII';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'WAITING_FOR_BACKEND':
        els.statusBarText.textContent = 'CONSULTING BACKEND AGENT';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'WAITING_FOR_USER':
        els.statusBarText.textContent = 'ACTION REQUIRED — INPUT NEEDED';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'EXECUTING':
        els.statusBarText.textContent = 'EXECUTING AGENT ACTION';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'COMPLETED':
        els.statusBarText.textContent = 'TASK COMPLETED';
        els.statusDot.className = 'pv-status-dot active';
        break;
      case 'ERROR':
        els.statusBarText.textContent = 'AGENT ERROR';
        els.statusDot.className = 'pv-status-dot error';
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
  scrollToBottom();
  return card;
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

// ---------- Settings (backend endpoint) ----------

async function initSettings() {
  els.backendUrlInput.value = await agentBackend.getEndpoint();
}

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
  scrollToBottom();
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
  const el = elements.find((e) => e.id === elementId);
  if (!el) return `element #${elementId}`;
  return el.text || el.placeholder || el.ariaLabel || `${el.type} #${elementId}`;
}

function describeAction(decision, elements) {
  switch (decision.action) {
    case 'click':
      return `Clicking "${findElementLabel(elements, decision.elementId)}"…`;
    case 'type':
      return `Typing into "${findElementLabel(elements, decision.elementId)}"…`;
    case 'scroll':
      return `Scrolling ${decision.value || 'down'}…`;
    case 'wait':
      return 'Waiting for the page to settle…';
    default:
      return `Performing ${decision.action}…`;
  }
}

function buildActionArgs(decision) {
  switch (decision.action) {
    case 'click':
      return [decision.elementId];
    case 'type':
      return [decision.elementId, decision.value || ''];
    case 'scroll':
      return [decision.value === 'up' ? 'up' : 'down'];
    default:
      return [];
  }
}

// ---------- One analysis pass: extract + detect PII + screenshot + redact ----------

async function analyzeCurrentPage() {
  agentController.beginPageAnalysis();

  const response = await sendMessage({
    type: 'ANALYZE_PAGE'
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Page analysis failed.");
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

// ---------- Main agent loop ----------

async function runAgentLoop(task) {
  agentController.startTask(task);
  actionHistory = [];
  agentBackend.resetSession();

  addMessage('agent', "Got it — analyzing the current page with local privacy scan.");

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    addMessage('system', step === 0 ? 'Analyzing page & redacting PII…' : `Step ${step + 1}: Re-checking page state…`);

    let extraction, redactedDataUrl;
    try {
      ({ extraction, redactedDataUrl } = await analyzeCurrentPage());
    } catch (err) {
      agentController.markError(err);
      showError(`Page analysis failed: ${err.message}`);
      return;
    }

    addMessage(
      'agent',
      `Identified ${extraction.counts.interactiveElements} interactive elements and ${extraction.counts.sensitiveItems} sensitive item(s).`,
      { sensitiveItems: extraction.sensitiveItems }
    );

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
      });
    } catch (err) {
      agentController.markError(err);
      showError(err.message);
      return;
    }

    if (decision.action === 'done') {
      addMessage('agent', '🎉 All task steps completed! Please review your page entries.');
      agentController.markCompleted();
      return;
    }

    if (decision.action === 'notify_submit') {
      addMessage('agent', '🎉 All form fields have been filled and verified successfully!');
      addMessage('system', decision.message || 'For your security, auto-submit is disabled — please review the page and click Submit when ready.');
      agentController.markCompleted();
      return;
    }

    if (decision.action === 'wait') {
      addMessage('system', 'Backend requested wait — allowing page to settle…');
      await delay(SETTLE_DELAY_MS * 2);
      actionHistory.push({ action: 'wait', result: 'waited' });
      continue;
    }

    if (decision.action === 'ask_user') {
      if (!decision.fields || decision.fields.length === 0) {
        showError('Backend requested user input but provided no fields.');
        agentController.markError(new Error('ask_user with no fields'));
        return;
      }

      // Guard: only transition if we're not already in WAITING_FOR_USER
      try { agentController.markWaitingForUser(); } catch (_) {}

      const firstField = decision.fields[0];
      let targetElId = firstField.elementId;
      if (targetElId == null && firstField.targetSelector) {
        const matched = extraction.elements.find(e => e.selector === firstField.targetSelector);
        if (matched) targetElId = matched.id;
      }

      const nameText = firstField?.fieldName || 'required field';
      addMessage('agent', `👉 Pointing to ${nameText} on the webpage — please type your value directly into the highlighted field.`);

      // Highlight target element on webpage with animated callout guide
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

      // Wait for user to click "I've Typed This Value — Resume Agent"
      await waitForUserInput(decision.fields);

      // Clear on-page highlight guide
      try {
        await sendMessage({ type: 'AGENT_ACTION', action: 'clearHighlight', args: [] });
      } catch (_) {}

      // ── CRITICAL: push a history entry for EVERY requested field so
      // the backend sees that this step was completed by the user and
      // does NOT re-issue the same ask_user action on the next iteration.
      for (const field of decision.fields) {
        actionHistory.push({
          action: 'user_filled',
          elementId: field.elementId ?? targetElId,
          targetSelector: field.targetSelector || field.key,
          fieldName: field.fieldName || field.label,
          result: { success: true, filledByUser: true }
        });
      }

      // Safely transition state back; submitUserInfo also stores collected info
      try { agentController.submitUserInfo({}); } catch (_) {}

      addMessage('system', 'Input received — re-scanning page and continuing task…');
      // Extra settle time: let the page process the value before next analysis
      await delay(SETTLE_DELAY_MS * 1.5);
      continue; // ← restart the for-loop → re-analyze → send next decision
    }

    // click / type / scroll
    addMessage('agent', describeAction(decision, extraction.elements));
    agentController.markExecuting();

    let actionResponse;
    try {
      actionResponse = await sendMessage({
        type: 'AGENT_ACTION',
        action: decision.action,
        args: buildActionArgs(decision)
      });
    } catch (err) {
      console.warn(`[popup] Action execution error:`, err);
      actionHistory.push({
        action: decision.action,
        elementId: decision.elementId,
        value: decision.action === 'type' ? '[REDACTED]' : decision.value,
        result: { success: false, reason: err.message }
      });
      await delay(SETTLE_DELAY_MS);
      continue;
    }

    const actionData = actionResponse?.data;
    const isSuccess = actionResponse?.ok && (actionData?.success !== false);

    actionHistory.push({
      action: decision.action,
      elementId: decision.elementId,
      value: decision.action === 'type' ? '[REDACTED]' : decision.value,
      result: actionData || { success: isSuccess }
    });

    if (!isSuccess) {
      console.warn(`[popup] Action ${decision.action} on element #${decision.elementId} unconfirmed:`, actionData?.reason || actionResponse?.error);
    }

    await delay(SETTLE_DELAY_MS);
  }

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

  addMessage('user', task);
  els.taskInput.value = '';
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

// Close the detached popup window when the user clicks the × button.
els.closeBtn.addEventListener('click', () => window.close());

initSettings();