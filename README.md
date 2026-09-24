<p align="center">
  <img src="Browser-Agent/icons/icon128.png" alt="Privacy Vision Agent" width="96" height="96" />
</p>

<h1 align="center">Privacy Vision Agent</h1>

<p align="center">
  <strong>On-Device Visual Perception for Privacy-Preserving Browser Automation</strong>
</p>

<p align="center">
  <a href="#-architecture"><img src="https://img.shields.io/badge/Architecture-Dual--Tier-blueviolet?style=for-the-badge" alt="Architecture" /></a>
  <a href="#-privacy-guarantees"><img src="https://img.shields.io/badge/Privacy-Zero--Leak-00c853?style=for-the-badge" alt="Privacy" /></a>
  <a href="#-benchmark-results"><img src="https://img.shields.io/badge/Benchmark-100%25%20F1-ff6f00?style=for-the-badge" alt="Benchmark" /></a>
  <a href="https://github.com/Rohit-Dhade/Privacy-Vision-Agent"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  <em>A Chrome Extension that lets Vision-Language Models navigate the web on your behalf —<br/>while mathematically guaranteeing your personal data never leaves your device.</em>
</p>

---

## 🧠 The Problem

Modern AI browser agents are powerful — they can see your screen, read forms, and click buttons. But to do this, they **send your entire screen** — passwords, Aadhaar numbers, bank details, faces — to cloud servers. Every screenshot is a privacy liability.

> **The core question:** *Can an AI agent complete a KYC form, book a ticket, or fill a government application — without ever seeing your real data?*

**Privacy Vision Agent proves the answer is yes.**

---

## 💡 The Innovation

We built a system where:

| What Happens | Where It Happens |
|:---|:---|
| 🔍 PII Detection (emails, cards, Aadhaar, passports, faces) | **Your browser** — regex, Luhn/Verhoeff checksums, ONNX NER, YuNet face detection |
| ⬛ Screenshot Redaction (solid black boxes over all PII) | **Your browser** — canvas rendering, pixel-level |
| 🤖 AI Reasoning ("click this button", "fill this field") | **Cloud VLM** — but it only ever sees the **redacted** screenshot |
| 📝 Sensitive Data Entry (name, phone, address) | **Your browser** — from a local-only encrypted store, never transmitted |
| 🔐 Cryptographic Proof of Redaction | **Your browser** — Merkle tree commitment, independently verifiable |

**The AI never sees your data. It doesn't need to. It works with structure, not secrets.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ON-DEVICE EXTENSION TIER                           │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │ Side Panel  │  │ Privacy Dial │  │ Consequential Action Gate  │    │
│  │ (popup.js)  │  │  4 Positions │  │ 9-Step Auth Protocol       │    │
│  └──────┬──────┘  └──────┬───────┘  └────────────┬───────────────┘    │
│         │                │                       │                    │
│  ┌──────▼────────────────▼───────────────────────▼───────────────┐    │
│  │              AGENT CORE (26 modules)                          │    │
│  │  fieldMatcher · formAnalyzer · stateDiffEngine                │    │
│  │  trustGate · privacyBoundary · debateManager                  │    │
│  │  webllmEngine (Qwen2.5) · recoveryEngine                     │    │
│  └──────┬────────────────────────────────────────────────────────┘    │
│         │                                                             │
│  ┌──────▼────────────────────────────────────────────────────────┐    │
│  │              PERCEPTION LAYER (Content Scripts)                │    │
│  │  domExtractor · interactiveElements · textExtractor            │    │
│  │  piiDetector · visibility · semanticDomBuilder                 │    │
│  └──────┬────────────────────────────────────────────────────────┘    │
│         │                                                             │
│  ┌──────▼────────────────────────────────────────────────────────┐    │
│  │              ON-DEVICE ML (Offscreen WASM)                     │    │
│  │  ONNX Runtime Web · YuNet Face Detection (232 KB)              │    │
│  │  Token-Classification NER (29 MB quantized)                    │    │
│  │  Qwen2.5-1.5B (WebLLM, OPFS-cached, Fully Local mode)         │    │
│  └──────┬────────────────────────────────────────────────────────┘    │
│         │                                                             │
│  ┌──────▼────────────────────────────────────────────────────────┐    │
│  │              REDACTION ENGINE                                  │    │
│  │  redactor.js · coordinateMapper.js · merkleProof.js            │    │
│  │  Black-box rendering → Merkle tree → Signed proof              │    │
│  └──────┬────────────────────────────────────────────────────────┘    │
│         │ Only redacted screenshot + sanitized DOM skeleton           │
└─────────┼─────────────────────────────────────────────────────────────┘
          │  POST /api/agent/step (TLS)
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     AI REASONING TIER (Server)                          │
│                                                                         │
│  ┌───────────────┐  ┌──────────────────┐  ┌──────────────────────┐     │
│  │ Zod Validation │  │ Prompt Builder   │  │ Pixtral-12B (VLM)   │     │
│  │ requestSchema  │  │ Context Assembly │  │ Mistral AI SDK       │     │
│  └───────┬───────┘  └────────┬─────────┘  └──────────┬───────────┘     │
│          │                   │                       │                  │
│          └───────────────────┼───────────────────────┘                  │
│                              ▼                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ ActionValidator · Code-fence stripper · Sensitive field guard     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                    Returns: { action, targetSelector, reasoning }       │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
                    Only structural decisions.
                    Never a private value.
```

---

## 🛡️ Privacy Guarantees

These are not aspirational goals — they are **architecturally enforced** constraints, each traceable to a specific source file:

| # | Guarantee | Enforced By |
|:--|:----------|:------------|
| 1 | **Raw PII never leaves the browser** | `privacyBoundary.js` — allowlist sanitizer + adversarial pre-flight scan |
| 2 | **Faces blacked out before any transmission** | `offscreen.js` (YuNet ONNX) → `redactor.js` (canvas blackout) |
| 3 | **Passwords never filled by the agent** | `fieldMatcher.js` — explicit exclusion of `type="password"` fields |
| 4 | **Fully Local mode = zero cloud calls** | `agentBackend.js` — hard architectural refusal, not a soft preference |
| 5 | **Consequential actions require human approval** | `consequentialActionDetector.js` — 9-step authorization protocol |
| 6 | **Redaction is cryptographically provable** | `merkleProof.js` — tile-hashed Merkle tree with downloadable proof |
| 7 | **Trust gate blocks phishing autofill** | `trustGate.js` — domain look-alike detection, cross-domain form-action blocking |
| 8 | **Prompt injection is architecturally rejected** | `promptBuilder.js` — trusted/untrusted boundary with explicit injection defense rules |

> Every guarantee is documented in the publicly readable [**Agent Constitution**](Browser-Agent/CONSTITUTION.md) (v1.1.0), whose version number changes whenever a behavioral rule changes — visible in the product's Privacy Receipt panel.

---

## 🎛️ The Privacy Dial — Four Modes

Users choose their own trust boundary. Not a hidden setting — a first-class, always-visible control:

| Position | What Happens | Network Calls |
|:---------|:-------------|:--------------|
| ☁️ **Cloud-Assisted** | Redacted screenshot + sanitized DOM sent to Pixtral-12B | Per-step VLM call |
| ⚖️ **Hybrid** | Local matcher resolves what it can; cloud only for uncertain fields | Cloud only when needed |
| 🔒 **Fully Local** | On-device Qwen2.5-1.5B (WebLLM) + deterministic matcher. Zero cloud. | **None** (after one-time model download) |
| 🤝 **Hybrid Debate** | Local + Cloud run **in parallel**, both decisions shown with confidence scores | Per-step VLM call |

---

## 🔬 Dual Execution Modes

### Mode 1: Assist Me (Human-in-the-Loop)
The agent **guides** you — highlighting fields with an animated spotlight, showing a callout tooltip explaining what's needed, and supporting Hindi/Marathi translations via `i18nLabels.js`. You type your own data on the real page.

### Mode 2: Complete Automatically
The agent **fills** fields from a browser-local encrypted store (`PrivateDataStore`). If a value is missing, it seamlessly falls back to HITL mode — no stalling, no guessing.

Both modes share the same safety pipeline: PII detection → redaction → consequential action gate → human authorization.

---

## 🧪 Benchmark Results

Open, reproducible benchmarks — run them yourself with `node benchmark/run-benchmark.js`:

| Category | ISRO Weight | Precision | Recall | F1 | Avg Latency |
|:---------|:------------|:----------|:-------|:---|:------------|
| **Sensitive Data Detection** | 20% | 100.0% | 100.0% | **100.0%** | 15.05 ms/case |
| **Local Field Matching** | 25% | 100.0% | 100.0% | **100.0%** | 5.33 ms/case |
| **Consequential Action Gate** | Safety | 100.0% | 100.0% | **100.0%** | 0.67 ms/case |
| **Redaction Integrity** | 20% | — | — | **6/6 passed** | — |
| **Hybrid Debate Logic** | New | — | — | **52/52 passed** | — |
| **Screen-State Perception** | 25% | — | — | **23/24 passed** | 573 ms/frame |
| **Icon Classification** | 25% | 100.0% | 88.6% | **3/4 passed** | 13.17 ms/crop |

### PII Detection Coverage (38 fixture cases, 0 false positives)
Multi-jurisdictional support across **14 countries**:
- 🇮🇳 Aadhaar (Verhoeff), PAN, Indian Phone
- 🇺🇸 SSN (SSA exclusion rules), US Phone
- 🇬🇧 NINO, UK Phone
- 🇩🇪 VAT ID (ISO 7064 mod-11-10)
- 🇨🇳 Resident ID (GB 11643-1999)
- 🇯🇵 My Number (check digit)
- 🇧🇷 CPF (two-check-digit)
- 🇨🇦 SIN (Luhn), 🇦🇺 TFN/ABN (mod-11)
- 🇲🇽 CURP/RFC, 🌍 IBAN (mod-97), Passport MRZ (ICAO 9303)
- 💳 Credit Cards (Luhn), Emails, IPs, Secret Tokens (Shannon entropy)

---

## 🔐 Cryptographic Redaction Proof

Not "trust us, we redacted it" — **verify it yourself:**

1. Before redaction, the raw screenshot is hashed tile-by-tile into a **signed Merkle tree**
2. The redacted regions are committed as tile indices in the proof
3. Download the proof JSON and open `tools/verify-redaction-proof.html` — fully offline
4. **Verify:** confirms the proof is self-consistent
5. **Tamper test:** watch it detect any modification — root, tile hash, or signature

> This means a third party (auditor, judge, regulator) can confirm redaction actually happened without ever seeing the original image.

---

## 🛡️ Anti-Phishing Trust Gate

Before autofilling any data, `trustGate.js` runs four deterministic checks:

| Check | Severity | What It Catches |
|:------|:---------|:----------------|
| Form action domain ≠ page domain | **BLOCK** | Cross-site credential harvesting |
| Page not HTTPS | **WARN** | Unencrypted transmission of sensitive data |
| Domain is a look-alike of government/banking sites | **BLOCK** | `uid4i.gov.in` impersonating `uidai.gov.in` |
| 3+ sensitive field categories on one form | **BLOCK** | Password + card + Aadhaar on the same page |

Zero AI, zero network calls, zero false sense of security — deterministic pattern matching only.

---

## 🤖 Multi-Agent Debate (Hybrid Debate Mode)

The first browser agent with **transparent AI disagreement resolution:**

```
┌──────────────────────┐     ┌──────────────────────┐
│   On-Device Qwen2.5  │     │   Cloud Pixtral-12B  │
│   (WebLLM, local)    │     │   (Mistral AI)       │
│                      │     │                      │
│   "click #next"      │     │   "click #next"      │
│   confidence: 0.85   │     │   confidence: 0.82   │
└──────────┬───────────┘     └──────────┬───────────┘
           │                            │
           └──────────┬─────────────────┘
                      ▼
           ┌─────────────────────┐
           │   Debate Manager    │
           │   ────────────────  │
           │   AGREE → use 0.85 │
           │   Show both scores  │
           └─────────────────────┘
```

| Resolution Tier | Gap | Behavior |
|:----------------|:----|:---------|
| **AGREE** | — | Use higher-confidence framing |
| **DISAGREE_AUTO_RESOLVE** | < 5% | Auto-pick higher confidence |
| **DISAGREE_SHOW_BOTH** | 5–15% | Show both, flag for user |
| **DISAGREE_ASK_USER** | > 15% | Strong flag, recommend user review |
| **DEGRADED** | — | One side failed; use survivor |

All existing safety gates still apply regardless of debate outcome.

---

## 📁 Project Structure

```
Privacy-Vision-Agent/
├── Browser-Agent/                    # Chrome Extension (Manifest V3)
│   ├── manifest.json                 # MV3 config — permissions, CSP, content scripts
│   ├── CONSTITUTION.md               # Agent Constitution v1.1.0 — plain-language rules
│   ├── agent/                        # 26 client-side agent modules
│   │   ├── agentBackend.js           # Sole outbound HTTP bridge
│   │   ├── privacyBoundary.js        # Allowlist sanitizer + adversarial pre-flight
│   │   ├── privacyDial.js            # 4-position privacy control
│   │   ├── debateManager.js          # Multi-agent debate orchestrator
│   │   ├── webllmEngine.js           # On-device Qwen2.5 (WebLLM/MLC-AI)
│   │   ├── consequentialActionDetector.js  # Submit/pay safety gate
│   │   ├── trustGate.js              # Anti-phishing autofill gate
│   │   ├── fieldMatcher.js           # Semantic DOM-to-profile matcher
│   │   ├── privateDataStore.js       # Browser-local encrypted store
│   │   ├── stateManager.js           # 12-state FSM
│   │   └── ...                       # + 16 more modules
│   ├── content/                      # Injected DOM perception scripts
│   │   ├── piiDetector.js            # Regex + Luhn + NER PII detection
│   │   ├── domExtractor.js           # Master extraction pipeline
│   │   ├── redactor.js               # Canvas blackout renderer
│   │   └── ...                       # + 9 more modules
│   ├── popup/                        # Side Panel UI
│   │   ├── popup.html                # 644-line interface (Agent + Privacy Proof tabs)
│   │   ├── popup.css                 # 46 KB design system
│   │   └── popup.js                  # 222 KB orchestrator
│   ├── offscreen.js                  # WebAssembly ML worker (ONNX + WebLLM)
│   ├── models/                       # On-device ML weights
│   │   ├── face_detection_yunet_2023mar.onnx  # 232 KB face detector
│   │   └── ner/model_quantized.onnx  # 29 MB NER transformer
│   ├── lib/                          # ONNX Runtime Web + WebLLM runtime
│   ├── utils/                        # Shared utilities
│   │   ├── merkleProof.js            # Cryptographic redaction proof
│   │   ├── i18nLabels.js             # Hindi/Marathi translations
│   │   ├── visualStateEngine.js      # Pixel-level screen state analysis
│   │   └── ...
│   ├── tools/                        # Standalone verification tools
│   │   └── verify-redaction-proof.html  # Offline proof verifier
│   └── docs/                         # Technical documentation
│       ├── ARCHITECTURE.md
│       ├── PRIVACY.md
│       ├── API_REFERENCE.md
│       ├── IMPLEMENTATION.md
│       ├── DEPLOYMENT.md
│       └── TESTING.md
│
├── Brower-Agent-Server/              # Node.js Express Backend
│   ├── server.js                     # Entry point (port 5000)
│   ├── package.json                  # Express 5, Mistral AI SDK, Zod, Winston
│   └── src/
│       ├── controllers/              # POST /api/agent/step handler
│       ├── providers/                # Pixtral-12B cloud provider
│       ├── services/                 # Prompt builder + session cache
│       ├── validation/               # ActionValidator + request validation
│       └── schemas/                  # Zod schemas for strict typing
│
├── benchmark/                        # Open reproducible evaluation harness
│   ├── run-benchmark.js              # Zero-dependency Node test runner
│   ├── fixtures/                     # Hand-labeled ground-truth test data
│   └── results/                      # Auto-generated precision/recall/F1 reports
│
└── test-pages/                       # Synthetic test fixtures
    ├── kyc-onboarding-demo.html      # Full KYC onboarding simulation
    ├── testing-form.html             # 15-field identity & address form
    ├── testing-quiz.html             # 10-question scrolling MCQ test
    ├── phishing-demo-fixture.html    # Adversarial phishing test page
    └── hostile-realworld.html        # Prompt injection stress test
```

---

## 🚀 Getting Started

### Prerequisites
- **Chrome** ≥ 114 (Manifest V3 support)
- **Node.js** ≥ 18 (for the reasoning server)
- **Mistral AI API Key** (for Cloud-Assisted / Hybrid modes)

### 1. Clone the Repository
```bash
git clone https://github.com/Rohit-Dhade/Privacy-Vision-Agent.git
cd Privacy-Vision-Agent
```

### 2. Start the Reasoning Server
```bash
cd Brower-Agent-Server
cp .env.example .env          # Add your MISTRAL_API_KEY
npm install
npm run dev                   # Starts on http://localhost:5000
```

### 3. Load the Chrome Extension
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `Browser-Agent/` folder
4. The Privacy Vision Agent icon appears in your toolbar

### 4. Use It
1. Navigate to any web page with forms (try `test-pages/kyc-onboarding-demo.html`)
2. Click the extension icon → opens the **Side Panel**
3. Type a task: *"Complete this registration form using my stored profile"*
4. Watch the agent work — every screenshot redacted, every action explained

### 5. Run the Benchmarks
```bash
node benchmark/run-benchmark.js
# Results → benchmark/results/latest-results.md
```

---

## 🌐 Internationalization

Field guides and callout tooltips support:
- 🇬🇧 **English** (default)
- 🇮🇳 **Hindi** (हिन्दी)
- 🇮🇳 **Marathi** (मराठी)

Managed by `utils/i18nLabels.js` — accessible to users who may not be comfortable with English-only interfaces during sensitive government form workflows.

---

## 📊 How It Compares

| Capability | Privacy Vision Agent | Typical Cloud Agent |
|:-----------|:---------------------|:--------------------|
| PII leaves browser | ❌ Never | ✅ Every screenshot |
| Face detection | ✅ On-device (YuNet) | ❌ Sent to cloud |
| Cryptographic proof of redaction | ✅ Merkle tree | ❌ None |
| Fully offline mode | ✅ Qwen2.5 local | ❌ Cloud-dependent |
| Consequential action safety | ✅ 9-step gate | ❌ or basic confirm |
| Anti-phishing gate | ✅ Deterministic | ❌ None |
| Multi-agent debate | ✅ Local vs Cloud | ❌ Single model |
| Prompt injection defense | ✅ Architectural boundary | ⚠️ Prompt-level only |
| Open benchmark | ✅ Reproducible | ❌ Claimed numbers |

---

## 🧪 Testing

### Automated Benchmark Suite
```bash
node benchmark/run-benchmark.js
```

### Manual Test Pages
| Page | Purpose |
|:-----|:--------|
| `test-pages/kyc-onboarding-demo.html` | Full KYC workflow with multi-step progression |
| `test-pages/testing-form.html` | 15-field identity & address form |
| `test-pages/testing-quiz.html` | 10-question vertically scrolling MCQ |
| `test-pages/phishing-demo-fixture.html` | Phishing detection test |
| `test-pages/hostile-realworld.html` | Adversarial prompt injection test |
| `test-pages/hostile-iframe-payment.html` | Hostile iframe with payment form |

### Server Integration Tests
```bash
cd Brower-Agent-Server
node test/FinalTest.js        # End-to-end server test
node test/StandAloneTest.js   # Action validator unit tests
```

---

## 🔧 Tech Stack

| Layer | Technology | Purpose |
|:------|:-----------|:--------|
| **Extension** | Chrome Manifest V3 | Browser integration, permissions, side panel |
| **ML Runtime** | ONNX Runtime Web (WASM) | On-device NER + face detection inference |
| **Local LLM** | WebLLM (MLC-AI) | On-device Qwen2.5 for Fully Local mode |
| **VLM** | Pixtral-12B (Mistral AI) | Cloud visual reasoning |
| **Server** | Express 5 + Node.js | API gateway + prompt construction |
| **Validation** | Zod 4 | Runtime type safety for payloads |
| **Logging** | Winston | Structured server-side logging |
| **Cryptography** | SHA-256 + Merkle Trees | Redaction proof generation |
| **Face Detection** | YuNet (ONNX, 232 KB) | Real-time face bounding boxes |
| **NER** | Quantized Transformer (29 MB) | Named entity recognition for PII |

---

## 🗺️ Roadmap

- [ ] OCR confirmation pass (PaddleOCR — model vendored, integration in progress)
- [ ] WebGPU acceleration for visualStateEngine (currently ~573ms/frame)
- [ ] Icon classifier latency optimization (target: <5ms/crop)
- [ ] Extended i18n (Tamil, Telugu, Bengali)
- [ ] Firefox/Edge Manifest V3 port
- [ ] Published evaluation dataset for community benchmarking

---

## 🏆 Built For

<p align="center">
  <strong>Smart India Hackathon (SIH) 2026</strong><br/>
  Problem Statement PS26171 — On-device Visual Perception for Lightweight Browser Agents<br/>
  <em>Organization: Indian Space Research Organisation (ISRO)</em>
</p>

---

## 👥 Team

Built by **Team Privacy Vision** — students passionate about making AI automation safe for everyone.

---

## 📄 License

This project is open source under the [MIT License](LICENSE).

---

<p align="center">
  <em>"The safest data is the data that never leaves." — Privacy Vision Agent</em>
</p>
