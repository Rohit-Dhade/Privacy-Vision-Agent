# Privacy Vision Agent - Setup Instructions for Friends

Follow these step-by-step instructions to run this project on your system.

---

## Prerequisites
1. **Node.js**: Download and install Node.js (v18 or higher) from [nodejs.org](https://nodejs.org/).
2. **Google Chrome** (or Brave / Edge / Opera).
3. **Mistral API Key**: Sign up at [console.mistral.ai](https://console.mistral.ai/) and copy an API key.

---

## Step 1: Start the Backend Server (`Brower-Agent-Server`)

1. Open your terminal / command prompt.
2. Navigate into the backend folder:
   ```bash
   cd Brower-Agent-Server
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the environment template to create your `.env` file:
   ```bash
   cp .env.example .env
   ```
5. Open `.env` and paste your Mistral API key:
   ```env
   MISTRAL_API_KEY=your_mistral_api_key_here
   CLOUD_MODEL=pixtral-12b-2409
   vlmprovider=mistral
   ```
6. Start the server:
   ```bash
   npm run dev
   ```
   *Expected Output:* `Server is running on port 5000`

---

## Step 2: Load the Chrome Extension (`Browser-Agent`)

1. Open Chrome and go to `chrome://extensions` in your URL bar.
2. Enable **Developer mode** (top-right toggle switch).
3. Click **Load unpacked** (top-left button).
4. Select the **`Browser-Agent`** folder inside this repository.
5. Click the puzzle icon 🧩 in Chrome's toolbar and pin **Privacy Vision Agent**.

---

## Step 3: Run and Test

1. Open any webpage (or open `Browser-Agent/test/test-page.html`).
2. Click the **Privacy Vision Agent** extension icon.
3. Type a task prompt like *"Find wireless headphones"* or *"Click contact us"* and press **Send**.

Enjoy exploring the privacy-preserving vision AI agent!
