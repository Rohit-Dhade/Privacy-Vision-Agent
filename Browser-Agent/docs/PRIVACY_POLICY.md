# Privacy Policy for Privacy Vision Agent

**Last Updated: October 2026**

This Privacy Policy describes how the **Privacy Vision Agent** Chrome Extension ("the Extension", "we", "us", or "our") handles user information, data processing, and privacy boundaries. We are committed to a strict **privacy-first, on-device perception** architecture.

---

## 1. Single Purpose & Core Functionality

Privacy Vision Agent is a privacy-preserving visual browser assistant designed to help users navigate web pages, complete complex workflows, and fill forms without exposing sensitive personal credentials, identities, or confidential information to remote artificial intelligence models or cloud servers.

---

## 2. Information We Process & How It Is Handled

### A. Webpage DOM Elements and Visual Perception
* **What is processed:** The Extension extracts interactive DOM elements (buttons, links, form inputs) and captures viewport screenshots of the currently active tab solely in response to explicit user instructions.
* **Where it is processed:** All initial perception, optical character recognition (OCR), named entity recognition (NER), and computer vision models (face detection) execute **strictly on-device within the user's browser** (via WebAssembly and ONNX Runtime Web).

### B. On-Device Personally Identifiable Information (PII) Protection
* **On-Device Detection:** The Extension inspects page text and input fields using local algorithmic rules (including Luhn checks for payment cards), regular expressions, and local transformer models to identify:
  * Names, email addresses, phone numbers
  * Passwords, PINs, and authentication credentials
  * Government identification numbers (PAN, Aadhaar, SSN, etc.)
  * Credit/Debit card numbers
  * Human faces in photographs and uploaded ID documents
* **Mandatory On-Device Redaction:** Before any visual or semantic data is transmitted to an AI reasoning model, all detected sensitive regions are redacted (blacked out or blurred) on-device. **Unredacted screenshots and raw sensitive data never leave your browser.**

### C. Local Private Information Store
* The Extension includes a local storage feature allowing users to store common form values (e.g., name, phone number, address) to enable automatic form filling.
* **Strict Storage Boundary:** This information is saved exclusively in the browser's local sandbox (`chrome.storage.local`).
* **Zero Cloud Transmission:** Values stored in the local private information store are **NEVER** transmitted over the network, included in cloud prompts, sent to the remote backend, or logged in server telemetry. When completing forms, the Extension injects these values directly into the webpage DOM locally on the client machine.

### D. Outbound Network Requests
* **Fully Local Mode:** If configured in Fully Local mode, no network requests are made. All reasoning and actions execute entirely on-device.
* **Hybrid / Cloud Modes:** When enabled, the Extension communicates solely with the backend endpoint configured by the user (or default backend). The payload contains:
  * A pre-redacted DOM skeleton (with sensitive fields masked as redaction tags, e.g., `REDACTED_PASSWORD`).
  * A client-side redacted screenshot with all sensitive regions obscured.
  * Ephemeral action history without sensitive values.
* The Extension does not connect to any tracking, advertising, or unauthorized third-party telemetry services.

---

## 3. Chrome Permissions & Why They Are Required

* **`activeTab` & `scripting`:** Used to interact with and inspect interactive elements on the currently active tab when you trigger the assistant.
* **`storage` (`chrome.storage.local`):** Used to persist user preferences (Privacy Dial settings, custom backend URL) and the local private information store securely within your browser.
* **`offscreen`:** Used to host an offscreen HTML document that runs the client-side ONNX Runtime WebAssembly models for local face and entity detection without blocking user interface responsiveness.
* **`sidePanel`:** Used to render the assistant interface in Chrome's dedicated side panel, ensuring persistent visibility across multi-step page navigations.
* **`host_permissions: ["<all_urls>"]`:** Required because Privacy Vision Agent is a general-purpose automation assistant that users invoke on arbitrary, user-specified websites. The Extension only activates on sites where the user explicitly initiates a task.

---

## 4. Data Sharing & Third-Party Disclosure

* **No Data Selling:** We do not sell, rent, monetize, or trade any personal data or browsing activity.
* **No Tracking/Analytics:** The Extension does not bundle analytics trackers, fingerprinting libraries, or advertising SDKs.
* **No Cloud Storage of Sensitive Data:** Neither we nor our backend services store or log your personal credentials or sensitive values.

---

## 5. User Control & Data Retention

* **Data Ownership:** You retain full ownership and control of all information entered into the Extension.
* **Clearing Stored Data:** You can view, modify, or permanently delete all entries in your Local Private Information Store at any time via the Extension's **Settings (⚙️)** panel.
* **Uninstalling:** Uninstalling the Extension immediately deletes all locally stored data, preferences, and cached models from your device.

---

## 6. Compliance with Chrome Web Store Policies

Privacy Vision Agent adheres to the [Google Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program_policies/), including:
* Strict compliance with the **Limited Use Policy**.
* Adherence to the **Manifest V3 Remote Code Prohibition** (all runtime dependencies and inference code are bundled locally).
* Proportional and transparent use of Chrome API permissions.

---

## 7. Contact Information

If you have questions, feedback, or security concerns regarding this Privacy Policy or the Extension's data handling practices, please open an issue on our GitHub repository:
https://github.com/Rohit-Dhade/Privacy-Vision-Agent
