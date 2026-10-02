# Chrome Web Store Developer Dashboard Listing Guide

Use the exact contents below when creating or submitting your listing on the [Google Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 1. Product Details

### Title
```
Privacy Vision Agent
```

### Short Description (Max 132 characters)
```
Privacy-first vision browser agent. Detects & redacts PII and faces on-device, with local auto-fill & human-in-the-loop safety.
```

### Detailed Description (Markdown / Store format)
```markdown
Privacy Vision Agent is a privacy-first, on-device browser automation assistant designed to help you complete complex multi-step web workflows without exposing personal information or credentials to remote servers.

Whether you are completing multi-step forms, answering repetitive quizzes, or navigating web portals, Privacy Vision Agent empowers multimodal AI assistance with strict mathematical and architectural privacy guarantees.

🌟 KEY FEATURES

1. 🛡️ On-Device PII & Face Redaction:
   Before any screenshot or page data is sent for AI analysis, the extension runs local algorithmic rules, Luhn checks, ONNX Named Entity Recognition (NER), and YuNet computer vision models directly in your browser. All emails, phone numbers, addresses, credit cards, government IDs, and faces are blacked out or blurred on-device.

2. 🤖 Dual-Mode Execution:
   • Complete Automatically: Intelligently identifies required form fields and fills them from your local, browser-only Private Information Store.
   • Assist Me (Human-in-the-Loop): Guides you by highlighting input fields with a glowing spotlight and visual callouts, allowing you to enter sensitive credentials manually.

3. 🔒 Local Private Information Store:
   Store personal details (name, email, phone, address) locally in Chrome storage. These values are NEVER sent to cloud servers, VLM models, or external APIs. They are injected strictly client-side into the webpage DOM.

4. 🛑 Consequential Action Safety Gate:
   Irreversible actions (such as "Submit", "Pay Now", or "Place Order") are automatically intercepted by a client-side safety guard requiring explicit human authorization before executing.

5. 🎛️ Dynamic Privacy Dial:
   Choose your privacy level:
   • Fully Local (WebLLM / On-Device reasoning)
   • Hybrid Mode (On-device PII protection + remote VLM reasoning)
   • Cloud Mode (Local redaction + high-accuracy cloud reasoner)

PRIVACY FIRST:
• No tracking, ads, or third-party telemetry.
• Unredacted screenshots NEVER leave your machine.
• All open-source code and verifiable on-device models.
```

### Category
```
Productivity / Workflow
```
*(Alternative: Developer Tools)*

### Primary Language
```
English
```

---

## 2. Privacy Practices Tab

### Single Purpose Description
```
Privacy Vision Agent is an interactive browser automation assistant that navigates web workflows and fills forms on behalf of the user while preserving privacy through on-device PII and face redaction.
```

### Permission Justifications

#### `host_permissions: ["<all_urls>"]`
```
Privacy Vision Agent is a general-purpose browser assistant that users invoke on arbitrary, user-specified websites to automate tasks (such as completing forms or navigating workflows). Access to web origins is strictly required to inspect interactive DOM elements, capture active viewport screenshots for visual perception, and execute requested clicks or text inputs. The extension only activates when the user explicitly triggers an automation task on the current page.
```

#### `activeTab`
```
Required to inspect and interact with the currently focused tab when the user opens the side panel and issues an instruction.
```

#### `scripting`
```
Required to inject content scripts on-demand into the active tab to extract interactive element coordinates, apply visual field spotlights (HITL guide), and fill form fields.
```

#### `storage`
```
Used to persist user settings (Privacy Dial mode, custom backend endpoint) and the user's Local Private Information Store within chrome.storage.local. Stored data never leaves the browser.
```

#### `offscreen`
```
Required to create an offscreen document sandbox that runs WebAssembly and ONNX Runtime Web for local machine learning inference (YuNet face detection, PP-OCR, and Named Entity Recognition) without blocking the main browser thread or user interface.
```

#### `sidePanel`
```
Used to display the agent's chat, progress receipts, and human-in-the-loop authorization controls in Chrome's side panel, maintaining persistent guidance across multi-page navigation.
```

---

## 3. Data Usage & Declarations

Answer the Chrome Web Store questionnaire as follows:

1. **Does the extension collect Personally Identifiable Information (PII)?**
   * Select: **Yes**
   * Explanation: *Personal information entered by the user in the extension's settings (e.g. name, email, address) is stored strictly locally in `chrome.storage.local` to enable local form filling. It is never transmitted over the network or collected by the developer.*
2. **Does the extension collect Authentication Information (passwords, credentials)?**
   * Select: **No** *(Passwords are detected and redacted on-device; never collected or transmitted)*.
3. **Does the extension collect Website Content (text, images, DOM)?**
   * Select: **Yes**
   * Explanation: *The extension captures DOM element positions and sanitized, on-device redacted screenshots solely during an active user session to execute requested navigation actions.*
4. **Limited Use Compliance:**
   * Check: **I certify that my extension adheres to the Chrome Web Store Limited Use Policy.**
   * Check: **I certify that the extension does not sell user data.**
   * Check: **I certify that user data is not used for purposes unrelated to the extension's core single purpose.**
   * Check: **I certify that user data is not used for creditworthiness, lending, or advertising.**

---

## 4. Visual Assets Checklist

Before submitting, prepare these visual assets in the Developer Dashboard:
* **Store Icon:** 128x128 PNG (provided in `Browser-Agent/icons/icon128.png`).
* **Screenshots (At least 1 required, 1280x800 or 640x400 PNG/JPEG):**
  1. Side Panel interface showing task execution on a form.
  2. Visual Proof tab showing on-device PII/face redaction.
  3. Settings panel showing the Local Private Information Store.
  4. Human-in-the-loop spotlight ring on a web form.
* **Privacy Policy URL:** Host `Browser-Agent/docs/PRIVACY_POLICY.md` on your GitHub Pages or public repository URL and paste the link.
