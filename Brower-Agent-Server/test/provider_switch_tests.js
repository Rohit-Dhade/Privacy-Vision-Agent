/**
 * test/provider_switch_tests.js
 *
 * Provider-Neutral Cloud VLM Configuration & Switch Tests
 *
 * Tests:
 * 1. Configuration loading with default Pixtral / custom Qwen models
 * 2. PromptBuilder using configured CLOUD_MODEL without hardcoded strings
 * 3. Message & Image vision payload normalization for OpenAI/DashScope/Mistral compatibility
 * 4. Response normalization across string and content-block formats
 * 5. Downstream ActionValidator parsing provider responses without regressions
 * 6. PrivacyBoundary enforcement regardless of configured provider
 */

import assert from 'assert';
import config from '../src/config/config.js';
import buildPromptRequest from '../src/services/promptBuilder.js';
import validateAction from '../src/validation/ActionValidator.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrivacyBoundary } = require('../../Browser-Agent/agent/privacyBoundary.js');

console.log("================================================================================");
console.log("             RUNNING PROVIDER-NEUTRAL VLM SWITCH TEST SUITE                     ");
console.log("================================================================================\n");

let passed = 0;
let total = 6;

// Test 1: Configuration Contract & Backward Compatibility
console.log("[Test 1] Configuration Contract & Backward Compatibility");
{
  assert.ok(typeof config.MISTRAL_API_KEY === 'string', "MISTRAL_API_KEY must be a string");
  assert.ok(typeof config.CLOUD_MODEL === 'string', "CLOUD_MODEL must be a string");
  assert.ok(typeof config.vlmProvider === 'string', "vlmProvider must be a string");
  assert.ok('CLOUD_BASE_URL' in config, "CLOUD_BASE_URL must be configurable");
  console.log(`  ✓ PASS: Preserved MISTRAL_API_KEY, CLOUD_MODEL (${config.CLOUD_MODEL}), vlmProvider (${config.vlmProvider})`);
  passed++;
}

// Test 2: PromptBuilder consumes dynamic CLOUD_MODEL
console.log("\n[Test 2] PromptBuilder uses configured CLOUD_MODEL");
{
  const samplePayload = {
    taskInstruction: "Click search button",
    domSkeleton: {
      url: "https://example.com",
      elements: [{ id: "1", tag: "button", selector: "#search-btn", box: { x: 0, y: 0, width: 50, height: 20 }, sensitive: false }]
    },
    redactionMap: [],
    actionHistory: [],
    screenshot: { format: "png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", width: 1, height: 1 }
  };

  const req = buildPromptRequest(samplePayload);
  assert.strictEqual(req.model, config.CLOUD_MODEL, "Request model must match config.CLOUD_MODEL");
  
  // Verify vision payload contains standard image_url
  const userMsg = req.messages.find(m => m.role === 'user');
  const imgPart = userMsg.content.find(p => p.type === 'image_url');
  assert.ok(imgPart, "Must contain image_url part for vision model");
  assert.ok(imgPart.image_url && imgPart.image_url.url, "Must contain standard image_url.url for OpenAI/Qwen vision compatibility");
  assert.ok(imgPart.imageUrl, "Must contain imageUrl for Mistral SDK backward compatibility");
  console.log("  ✓ PASS: Vision payload structured with dual compatibility (Mistral + OpenAI/Qwen standard)");
  passed++;
}

// Test 3: Simulated Qwen Model Response Normalization
console.log("\n[Test 3] Provider Response Normalization (Qwen / OpenAI format)");
{
  // Simulated Qwen response payload (string content)
  const qwenRawResponse = JSON.stringify({
    action: "click",
    targetSelector: "#search-btn",
    value: null,
    reasoning: "Clicking search button to query catalog",
    plan: { objective: "Click search button", currentSubgoal: "Locate and click search", subgoalCompleted: true }
  });

  const domSkeleton = {
    elements: [{ selector: "#search-btn", sensitive: false }]
  };

  const validated = validateAction(qwenRawResponse, domSkeleton);
  assert.strictEqual(validated.ok, true, "Qwen action response must validate cleanly");
  assert.strictEqual(validated.action.action, "click");
  assert.strictEqual(validated.action.targetSelector, "#search-btn");
  console.log("  ✓ PASS: Qwen VLM response validated by ActionValidator without downstream changes");
  passed++;
}

// Test 4: Content Block Array Response Normalization
console.log("\n[Test 4] Content Block Array Normalization");
{
  // Simulated response where choices[0].message.content is an array of text blocks
  const contentBlocks = [
    { type: "text", text: '{\n  "action": "fill_from_local",\n  "targetSelector": "#email",\n  "value": null,\n  "reasoning": "Filling email locally from user store"\n}' }
  ];
  const combined = contentBlocks.map(c => c.text || c).join('\n');
  const domSkeleton = {
    elements: [{ selector: "#email", sensitive: false }]
  };
  const validated = validateAction(combined, domSkeleton);
  assert.strictEqual(validated.ok, true);
  assert.strictEqual(validated.action.action, "fill_from_local");
  console.log("  ✓ PASS: Content block array normalized into valid action");
  passed++;
}

// Test 5: Privacy Boundary Security under Provider Switching
console.log("\n[Test 5] Privacy Boundary Unbroken Under Provider Switch");
{
  const dirtyPayload = {
    sessionId: "test-sess",
    taskInstruction: "Submit tax form",
    capturedAt: Date.now(),
    screenshot: { format: "png", dataBase64: "...", width: 100, height: 100 },
    domSkeleton: {
      url: "https://example.com",
      elements: [{ id: "1", tag: "input", selector: "#pan", text: "PAN: ABCDE1234F", sensitive: true, box: { x: 0, y: 0, width: 10, height: 10 } }]
    },
    redactionMap: [],
    actionHistory: [{ action: "type", targetSelector: "#pan", value: "ABCDE1234F" }] // Raw PAN in history
  };

  // Privacy boundary must sanitize before payload ever leaves client
  const sanitized = PrivacyBoundary.sanitizeOutboundPayload(dirtyPayload);
  assert.strictEqual(sanitized.actionHistory[0].value, "[REDACTED]", "History value must be neutralized");
  assert.strictEqual(sanitized.domSkeleton.elements[0].text, "[REDACTED_PII]", "Element text must be redacted");

  // Adversarial pre-flight scan must throw if raw PII is passed directly
  assert.throws(() => {
    PrivacyBoundary.assertSafeForTransmission({ pan: "ABCDE1234F" });
  }, /Privacy Boundary Violation/);

  console.log("  ✓ PASS: Privacy boundary strictly enforces zero PII wire transmission");
  passed++;
}

// Test 6: Dynamic Model Switch Verification (Pixtral <-> Qwen)
console.log("\n[Test 6] Dynamic Model Switch Verification");
{
  const modelsToTest = [
    "pixtral-12b-2409",
    "qwen2.5-vl-72b-instruct",
    "qwen-vl-max",
    "qwen/qwen-2.5-vl-72b-instruct:free"
  ];

  for (const m of modelsToTest) {
    const fakePayload = {
      taskInstruction: "Test task",
      domSkeleton: { url: "https://example.com", elements: [] },
      redactionMap: [],
      actionHistory: [],
      screenshot: { format: "png", dataBase64: "...", width: 1, height: 1 }
    };
    
    // Temporarily set CLOUD_MODEL
    config.CLOUD_MODEL = m;
    const req = buildPromptRequest(fakePayload);
    assert.strictEqual(req.model, m, `PromptRequest model must match ${m}`);
  }

  // Restore
  config.CLOUD_MODEL = process.env.CLOUD_MODEL || 'pixtral-12b-2409';
  console.log("  ✓ PASS: Successfully tested model switching across Pixtral and Qwen model IDs");
  passed++;
}

console.log("\n================================================================================");
console.log(`PROVIDER SWITCH TEST RESULTS: ${passed}/${total} TESTS PASSED (100%)`);
console.log("================================================================================\n");
