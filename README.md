# Privacy Vision Agent

A privacy-first, vision-AI powered browser agent. It automates browser tasks using a Cloud Vision Model (Mistral AI) while **protecting user privacy** by redacting sensitive information (PII, emails, card numbers, passwords, custom input fields) directly on device *before* any screenshot leaves your computer.

---

## 🛠️ System Architecture

The project consists of two core parts:

1. **`Brower-Agent-Server`**: Node.js & Express backend server powered by Mistral AI / Vision Language Models.
2. **`Browser-Agent`**: Chromium Manifest V3 extension featuring local PII detection, redaction, and an interactive side-panel / popup UI.

---

## 📋 Prerequisites

Before setting up, make sure your computer has the following installed:

- **Node.js** (v18.0.0 or higher) - [Download Node.js](https://nodejs.org/)
- **npm** (comes with Node.js)
- **Google Chrome** (or any Chromium-based browser like Brave, Edge, Opera)
- **Mistral API Key** - [Get a free key from Mistral AI Platform](https://console.mistral.ai/)

---

## 🚀 Quick Setup Instructions

### Step 1: Set Up & Start the Backend Server

1. Open your terminal / command prompt.
2. Navigate to the backend server directory:
   ```bash
   cd Brower-Agent-Server
   ```
3. Install the required Node.js dependencies:
   ```bash
   npm install
   ```
4. Create your environment configuration file:
   - Duplicate `.env.example` and name it `.env`
   - Or run:
     ```bash
     cp .env.example .env
     ```
5. Open `.env` in any text editor and add your **Mistral API Key**:
   ```env
   MISTRAL_API_KEY=your_actual_mistral_api_key_here
   CLOUD_MODEL=pixtral-12b-2409
   vlmprovider=mistral
   ```
6. Start the backend development server:
   ```bash
   npm run dev
   ```
   *You should see:* `Server is running on port 5000`

---

### Step 2: Install the Browser Extension

1. Open Google Chrome (or your Chromium browser).
2. Go to the extensions management page by entering this URL in your address bar:
   ```text
   chrome://extensions
   ```
3. In the top-right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the **`Browser-Agent`** folder from this project directory.
6. Click the extension puzzle icon 🧩 in Chrome's top-right toolbar and **pin** the **Privacy Vision Agent**.

---

## 🎯 How to Use

1. Make sure the backend server (`Brower-Agent-Server`) is running.
2. Open any webpage in your browser (or use the built-in test page at `Browser-Agent/test/test-page.html`).
3. Click the **Privacy Vision Agent** extension icon in your browser toolbar.
4. Type your prompt or task (e.g., *"Search for wireless headphones"* or *"Fill out the registration form"*).
5. Press **Send**.
6. The agent will:
   - Analyze the active web page locally.
   - Mask sensitive information (emails, names, phone numbers) on-device.
   - Send the redacted view to the AI server.
   - Automatically click, scroll, or guide you through required form entries step-by-step!

---

## ⚙️ Extension Settings & Custom Server URL

By default, the browser extension connects to `http://localhost:5000/api/agent/step`.

If you change the port or run the server on a different host:
1. Click the **Privacy Vision Agent** extension icon.
2. Click the gear icon ⚙️ (Settings) in the top-right corner of the extension popup.
3. Update the **Backend Endpoint URL** to your server's endpoint.
4. Click **Save**.

---

## ❓ Troubleshooting & FAQs

- **Error: "Could not reach backend at http://localhost:5000/api/agent/step"**
  - Make sure `npm run dev` is actively running in the `Brower-Agent-Server` folder.
  - Verify port `5000` is not blocked or in use by another application.
  - Test if the server is up by opening `http://localhost:5000` in your browser (it should return `{"message": "Privacy Vision Agent Server is running"}`).

- **Error with Mistral API Key**
  - Check your `.env` file in `Brower-Agent-Server/.env`.
  - Make sure there are no spaces or quotes around your API key.

- **Redaction or element detection issues**
  - Refresh the webpage and re-open the extension.
  - Try testing with `Browser-Agent/test/test-page.html` for local validation.

---

## 🔒 Privacy & Security Guarantee
- All PII (Emails, Credit Cards, Phone numbers, Names) detection and screenshot redaction happen **100% locally on your machine** inside your browser.
- Only blacked-out (redacted) screenshots leave your device.
- Auto-fill/auto-submit of sensitive passwords or financial credentials is disabled for user safety.
