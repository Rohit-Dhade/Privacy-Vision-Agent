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

    clear() {
      this.container.innerHTML = '';
    }
  }

  root.__BA_UserInputManager = UserInputManager;
})(window);
