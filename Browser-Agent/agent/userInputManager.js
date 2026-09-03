/**
 * agent/userInputManager.js
 *
 * Renders the "On-Page Visual Guide" notification in the extension sidebar,
 * instructing the user to type their sensitive value directly into the
 * animated highlighted field on the web page.
 */
(function (root) {
  class UserInputManager {
    /**
     * @param {HTMLElement} container - element to render the notice into
     */
    constructor(container) {
      this.container = container;
      this.onSubmit = null; // () => void
    }

    /** @param {Array<{key:string,label:string,type:string,fieldName:string,expectedValue:string,selectorText:string}>} fields */
    renderForm(fields, onSubmit) {
      this.onSubmit = onSubmit;
      this.container.innerHTML = ''; // safe: DOM APIs used below

      const field = fields[0] || {};

      const wrap = document.createElement('div');
      wrap.className = 'ba-field-wrapper';
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '8px';
      wrap.style.padding = '12px';
      wrap.style.border = '1.5px solid var(--pv-primary-container)';
      wrap.style.borderRadius = 'var(--pv-radius)';
      wrap.style.backgroundColor = 'var(--pv-surface-bright)';
      wrap.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)';

      // Header Banner
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.style.fontSize = '20px';
      icon.style.color = 'var(--pv-primary)';
      icon.textContent = 'ads_click';
      header.appendChild(icon);

      const title = document.createElement('span');
      title.style.fontWeight = '700';
      title.style.fontSize = '13px';
      title.style.color = 'var(--pv-primary)';
      title.textContent = `Fill "${field.fieldName || field.label || 'Field'}" on Page`;
      header.appendChild(title);

      wrap.appendChild(header);

      // On-page animation notice
      const noticeBox = document.createElement('div');
      noticeBox.style.fontSize = '12px';
      noticeBox.style.color = 'var(--pv-on-surface)';
      noticeBox.style.lineHeight = '1.4';
      noticeBox.style.backgroundColor = 'var(--pv-surface-container-low)';
      noticeBox.style.padding = '8px 10px';
      noticeBox.style.borderRadius = '4px';

      noticeBox.innerHTML = `
        <div style="font-weight:600; margin-bottom:2px; color:var(--pv-primary-container);">
          👉 Look at the webpage tab
        </div>
        <div>An animated tooltip & glowing pulse is pointing to the <strong>${field.fieldName || 'field'}</strong> on the webpage. Type your value directly into the input box on the page.</div>
      `;
      wrap.appendChild(noticeBox);

      if (field.expectedValue) {
        const expectedBox = document.createElement('div');
        expectedBox.style.fontSize = '11.5px';
        expectedBox.style.color = 'var(--pv-on-surface-variant)';
        expectedBox.innerHTML = `💡 <strong>Expected:</strong> ${field.expectedValue}`;
        wrap.appendChild(expectedBox);
      }

      // Resume Button
      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.textContent = "I've Typed This Value — Resume Agent";
      continueBtn.className = 'pv-btn pv-btn-primary';
      continueBtn.style.width = '100%';
      continueBtn.style.marginTop = '4px';

      continueBtn.addEventListener('click', () => {
        if (typeof this.onSubmit === 'function') this.onSubmit({});
      });

      wrap.appendChild(continueBtn);
      this.container.appendChild(wrap);
    }

    /**
     * Renders the Pre-Submit / Human Authorization Gate for consequential actions.
     * @param {{
     *   title?: string,
     *   subtitle?: string,
     *   promptMessage: string,
     *   actionLabel: string,
     *   actionType?: 'PAYMENT' | 'SUBMIT' | 'WORKFLOW_CONTINUE' | string,
     *   cancelLabel?: string
     * }} options
     * @param {(confirmed: boolean) => void} onDecision
     */
    renderConfirmation(options, onDecision) {
      this.container.innerHTML = '';

      const {
        title = 'Human Authorization Required',
        promptMessage,
        actionLabel = 'Execute Action',
        actionType = 'SUBMIT',
        cancelLabel = 'Pause Here / Do Not Click'
      } = options;

      const isPayment = actionType === 'PAYMENT';

      const wrap = document.createElement('div');
      wrap.className = 'ba-confirmation-wrapper';
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';
      wrap.style.padding = '12px';
      wrap.style.border = isPayment
        ? '1.5px solid #d93025'
        : '1.5px solid var(--pv-primary-container)';
      wrap.style.borderRadius = 'var(--pv-radius)';
      wrap.style.backgroundColor = 'var(--pv-surface-bright)';
      wrap.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';

      // Header Banner
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.style.fontSize = '20px';
      icon.style.color = isPayment ? '#d93025' : 'var(--pv-primary)';
      icon.textContent = isPayment ? 'credit_card' : 'verified_user';
      header.appendChild(icon);

      const titleEl = document.createElement('span');
      titleEl.style.fontWeight = '700';
      titleEl.style.fontSize = '13px';
      titleEl.style.color = isPayment ? '#d93025' : 'var(--pv-primary)';
      titleEl.textContent = title;
      header.appendChild(titleEl);

      wrap.appendChild(header);

      // Description Box
      const descBox = document.createElement('div');
      descBox.style.fontSize = '12px';
      descBox.style.color = 'var(--pv-on-surface)';
      descBox.style.lineHeight = '1.45';
      descBox.style.backgroundColor = 'var(--pv-surface-container-low)';
      descBox.style.padding = '8px 10px';
      descBox.style.borderRadius = '4px';
      descBox.innerHTML = `
        <div style="font-weight:600; margin-bottom:4px; color:${isPayment ? '#b31412' : 'var(--pv-primary-container)'};">
          ${isPayment ? '⚠️ Financial Transaction Authorization' : '👉 Review & Authorize Action'}
        </div>
        <div>${promptMessage}</div>
      `;
      wrap.appendChild(descBox);

      // Action Buttons Container
      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.flexDirection = 'column';
      btnRow.style.gap = '6px';
      btnRow.style.marginTop = '4px';

      // Confirm Button
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'pv-btn pv-btn-primary';
      if (isPayment) {
        confirmBtn.style.backgroundColor = '#d93025';
        confirmBtn.style.borderColor = '#d93025';
      }
      confirmBtn.style.width = '100%';
      confirmBtn.textContent = `Yes, Click "${actionLabel}"`;
      confirmBtn.addEventListener('click', () => {
        if (typeof onDecision === 'function') onDecision(true);
      });
      btnRow.appendChild(confirmBtn);

      // Cancel / Stop Button
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'pv-btn pv-btn-secondary';
      cancelBtn.style.width = '100%';
      cancelBtn.textContent = cancelLabel;
      cancelBtn.addEventListener('click', () => {
        if (typeof onDecision === 'function') onDecision(false);
      });
      btnRow.appendChild(cancelBtn);

      wrap.appendChild(btnRow);
      this.container.appendChild(wrap);
    }

    /**
     * Generalized Human-in-the-Loop request rendering for arbitrary browser tasks.
     * Guaranteed to display the 4 required sections:
     * 1. Why the agent is blocked.
     * 2. What the user needs to do.
     * 3. What the agent will do afterward.
     * 4. The current target/context.
     *
     * @param {{
     *   category?: string,
     *   title?: string,
     *   whyBlocked: string,
     *   userActionRequired: string,
     *   nextStepPlan: string,
     *   targetContext: string,
     *   choices?: string[],
     *   needsTextInput?: boolean
     * }} options
     * @param {(response: { resumed: boolean, text?: string, choice?: string }) => void} onDecision
     */
    renderHitlRequest(options, onDecision) {
      this.container.innerHTML = '';

      const {
        category = 'USER_INTERVENTION',
        title,
        whyBlocked,
        userActionRequired,
        nextStepPlan,
        targetContext,
        choices = [],
        needsTextInput = false
      } = options;

      const wrap = document.createElement('div');
      wrap.className = 'ba-hitl-wrapper';
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';
      wrap.style.padding = '12px';
      wrap.style.border = '1.5px solid var(--pv-primary-container)';
      wrap.style.borderRadius = 'var(--pv-radius)';
      wrap.style.backgroundColor = 'var(--pv-surface-bright)';
      wrap.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';

      // Header Banner
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.style.fontSize = '20px';
      icon.style.color = 'var(--pv-primary)';

      const iconsByCategory = {
        AUTHENTICATION: 'vpn_key',
        CAPTCHA: 'smart_toy',
        SENSITIVE_CREDENTIAL: 'lock',
        AMBIGUOUS_DECISION: 'help',
        PERMISSION: 'security',
        CLARIFICATION: 'chat',
        APPROVAL: 'verified_user',
        OUTSIDE_AUTHORITY: 'shield',
        MISSING_INFO: 'edit_note'
      };
      icon.textContent = iconsByCategory[category] || 'person_alert';
      header.appendChild(icon);

      const titleEl = document.createElement('span');
      titleEl.style.fontWeight = '700';
      titleEl.style.fontSize = '13px';
      titleEl.style.color = 'var(--pv-primary)';
      titleEl.textContent = title || `Human Guidance: ${category.replace(/_/g, ' ')}`;
      header.appendChild(titleEl);

      wrap.appendChild(header);

      // 4 Structured Sections
      const bodyBox = document.createElement('div');
      bodyBox.style.display = 'flex';
      bodyBox.style.flexDirection = 'column';
      bodyBox.style.gap = '8px';
      bodyBox.style.fontSize = '12px';
      bodyBox.style.lineHeight = '1.45';

      // 1. Why blocked
      const whyDiv = document.createElement('div');
      whyDiv.style.backgroundColor = 'var(--pv-surface-container-low)';
      whyDiv.style.padding = '8px 10px';
      whyDiv.style.borderRadius = '4px';
      whyDiv.innerHTML = `<strong>⚠️ Reason:</strong> ${whyBlocked}`;
      bodyBox.appendChild(whyDiv);

      // 2. What user needs to do
      const actionDiv = document.createElement('div');
      actionDiv.style.backgroundColor = 'var(--pv-surface-container-low)';
      actionDiv.style.padding = '8px 10px';
      actionDiv.style.borderRadius = '4px';
      actionDiv.innerHTML = `<strong>👉 What you need to do:</strong> ${userActionRequired}`;
      bodyBox.appendChild(actionDiv);

      // 3. Target context
      if (targetContext) {
        const targetDiv = document.createElement('div');
        targetDiv.style.fontSize = '11.5px';
        targetDiv.style.color = 'var(--pv-on-surface-variant)';
        targetDiv.innerHTML = `📍 <strong>Context / Target:</strong> <code>${targetContext}</code>`;
        bodyBox.appendChild(targetDiv);
      }

      // 4. What agent does afterward
      if (nextStepPlan) {
        const nextDiv = document.createElement('div');
        nextDiv.style.fontSize = '11.5px';
        nextDiv.style.color = 'var(--pv-on-surface-variant)';
        nextDiv.innerHTML = `🤖 <strong>Afterward:</strong> ${nextStepPlan}`;
        bodyBox.appendChild(nextDiv);
      }

      wrap.appendChild(bodyBox);

      // Choices or text input if provided
      let selectedChoice = null;
      if (Array.isArray(choices) && choices.length > 0) {
        const choiceContainer = document.createElement('div');
        choiceContainer.style.display = 'flex';
        choiceContainer.style.flexDirection = 'column';
        choiceContainer.style.gap = '6px';
        choiceContainer.style.marginTop = '4px';

        choices.forEach(ch => {
          const chBtn = document.createElement('button');
          chBtn.type = 'button';
          chBtn.className = 'pv-btn pv-btn-secondary';
          chBtn.textContent = ch;
          chBtn.addEventListener('click', () => {
            if (typeof onDecision === 'function') {
              onDecision({ resumed: true, choice: ch });
            }
          });
          choiceContainer.appendChild(chBtn);
        });
        wrap.appendChild(choiceContainer);
      }

      let textInputEl = null;
      if (needsTextInput) {
        textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.className = 'pv-input';
        textInputEl.placeholder = 'Type clarification or value…';
        textInputEl.style.width = '100%';
        textInputEl.style.marginTop = '4px';
        wrap.appendChild(textInputEl);
      }

      // Resume button
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'pv-btn pv-btn-primary';
      resumeBtn.style.width = '100%';
      resumeBtn.style.marginTop = '6px';
      resumeBtn.textContent = "I've Done This — Resume Agent";
      resumeBtn.addEventListener('click', () => {
        if (typeof onDecision === 'function') {
          onDecision({
            resumed: true,
            text: textInputEl ? textInputEl.value.trim() : undefined,
            choice: selectedChoice || undefined
          });
        }
      });
      wrap.appendChild(resumeBtn);

      this.container.appendChild(wrap);
    }

    clear() {
      this.container.innerHTML = '';
    }
  }

  root.__BA_UserInputManager = UserInputManager;
})(window);
