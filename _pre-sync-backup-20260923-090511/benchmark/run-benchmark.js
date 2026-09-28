#!/usr/bin/env node
/**
 * benchmark/run-benchmark.js
 *
 * An open, reproducible evaluation harness for Privacy-Vision-Agent —
 * Pillar 4 of claude/v07-original-system-design-global.md ("publish the
 * real numbers, including where they're weak, and invite other teams to
 * run their agents against the same harness").
 *
 * This runs the extension's own, unmodified source files (content/
 * piiDetector.js, agent/fieldMatcher.js, agent/consequentialActionDetector.js,
 * utils/merkleProof.js) directly under Node against a set of small,
 * hand-labeled JSON fixtures with known ground truth, and computes
 * precision/recall/F1 plus latency — mapped explicitly to the categories
 * ISRO's PS26171 rubric weights.
 *
 * Scope and honesty notes (read before citing a number from this):
 *
 *   - The ONNX NER pass and the OCR/face/vision pipeline are excluded —
 *     they require a real browser (offscreen document, canvas, WASM
 *     runtime) that this Node harness deliberately does not simulate,
 *     rather than mocking them into a false "pass". Every metric below
 *     is scoped to what actually ran: the deterministic, checksum-gated
 *     regex layer, the local field-matcher, and the consequential-action
 *     detector.
 *   - This is a small, hand-authored fixture set (dozens of cases, not
 *     thousands) — it demonstrates the methodology and catches obvious
 *     regressions, it is not a claim of statistically robust coverage.
 *   - Fixtures intentionally include cases the current implementation
 *     gets wrong (see benchmark/fixtures/consequential-actions.json's
 *     "bare-continue-not-flagged" case) — a benchmark that only contains
 *     cases the system already passes proves nothing.
 *
 * Run:  node benchmark/run-benchmark.js
 * Output: benchmark/results/latest-results.json (machine-readable) and
 *         benchmark/results/latest-results.md (human-readable report).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'Browser-Agent');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const RESULTS_DIR = path.join(__dirname, 'results');

// ── Minimal browser-global shims ──────────────────────────────────────
// Just enough for the extension's own IIFE modules to load and run their
// deterministic logic under Node. No DOM, no chrome.storage persistence,
// no real network — this harness never contacts anything.
global.window = global;
global.self = global;
global.chrome = {
  runtime: {
    // Stubs the NER inference round-trip (RUN_NER_INFERENCE) as
    // "unavailable" — piiDetector.js's runNerOnText() already treats a
    // failed/missing response as "no NER spans found" and resolves an
    // empty array, exactly as it would if the offscreen document's model
    // failed to load in the real extension. This is why the NER-derived
    // detections are out of scope for this harness (see file header).
    sendMessage(_msg, cb) {
      if (typeof cb === 'function') cb({ ok: false, error: 'NER unavailable in benchmark harness (browser-only component)' });
    },
    lastError: null
  }
};

require(path.join(AGENT_DIR, 'content', 'piiDetector.js'));
require(path.join(AGENT_DIR, 'agent', 'formAnalyzer.js'));
require(path.join(AGENT_DIR, 'agent', 'fieldMatcher.js'));
require(path.join(AGENT_DIR, 'agent', 'consequentialActionDetector.js'));
require(path.join(AGENT_DIR, 'utils', 'merkleProof.js'));

const PiiDetector = window.__BA_PiiDetector;
const FieldMatcher = window.__BA_FieldMatcher;
const ConsequentialActionDetector = window.__BA_ConsequentialActionDetector;
const MerkleProof = window.__BA_MerkleProof;

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function prf(tp, fp, fn) {
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : (tp === 0 && fn === 0 ? 1 : 0);
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : (tp === 0 && fp === 0 ? 1 : 0);
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

// ── 1. Sensitive data detection (maps to ISRO category: Sensitive data
//      detection precision/recall, 20% weight) ─────────────────────────
async function runPiiDetectionBenchmark() {
  const cases = loadFixture('pii-field-values.json');
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const failures = [];
  const perCaseLatenciesMs = [];

  for (const c of cases) {
    const t0 = process.hrtime.bigint();
    const items = await PiiDetector.scanPlainText(c.text, c.fieldLabel);
    const t1 = process.hrtime.bigint();
    perCaseLatenciesMs.push(Number(t1 - t0) / 1e6);

    const detectedTypes = new Set(items.map((it) => it.type));
    const expectedTypes = new Set(c.expectedTypes || []);

    const expectedNone = expectedTypes.size === 0;
    const detectedNone = detectedTypes.size === 0;

    if (expectedNone && detectedNone) {
      tn++;
    } else if (!expectedNone && [...expectedTypes].every((t) => detectedTypes.has(t)) && detectedTypes.size === expectedTypes.size) {
      tp++;
    } else {
      // Any mismatch (missed expected type, or an unexpected extra type,
      // or a false positive on an expected-clean case) counts against
      // both precision and recall so it can't hide in one metric.
      const missed = [...expectedTypes].filter((t) => !detectedTypes.has(t));
      const extra = [...detectedTypes].filter((t) => !expectedTypes.has(t));
      if (missed.length > 0) fn++;
      if (extra.length > 0 || (expectedNone && !detectedNone)) fp++;
      if (missed.length === 0 && extra.length === 0) {
        // shouldn't reach here given the branch above, kept for safety
        tp++;
      } else {
        failures.push({ id: c.id, expected: [...expectedTypes], detected: [...detectedTypes], note: c.note || null });
      }
    }
  }

  const { precision, recall, f1 } = prf(tp, fp, fn);
  const avgLatencyMs = perCaseLatenciesMs.reduce((a, b) => a + b, 0) / perCaseLatenciesMs.length;

  return {
    category: 'Sensitive data detection (ISRO weight: 20%)',
    totalCases: cases.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision, recall, f1,
    avgLatencyMs,
    failures,
    scope: 'Regex + checksum layer only (Luhn/Verhoeff/IBAN-mod97/ICAO-9303-MRZ/entropy). NER pass excluded — requires the real browser offscreen document.'
  };
}

// ── 2. Field matching (feeds ISRO category: Visual context accuracy,
//      25% weight — correct field identification is a prerequisite for
//      any correct autofill/ask_user decision) ─────────────────────────
function runFieldMatchingBenchmark() {
  const cases = loadFixture('field-matching.json');
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const failures = [];
  const t0 = process.hrtime.bigint();

  for (const c of cases) {
    const result = FieldMatcher.matchElement(c.element);
    const detectedKey = result.matched ? result.key : null;
    const expectedKey = c.expectedKey;

    if (expectedKey === null && detectedKey === null) {
      tn++;
    } else if (expectedKey === detectedKey) {
      tp++;
    } else {
      if (expectedKey !== null) fn++;
      if (detectedKey !== null) fp++;
      failures.push({ id: c.id, expected: expectedKey, detected: detectedKey, reason: result.reason, note: c.note || null });
    }
  }

  const t1 = process.hrtime.bigint();
  const { precision, recall, f1 } = prf(tp, fp, fn);

  return {
    category: 'Local field-matching accuracy (feeds Visual context accuracy, 25% weight)',
    totalCases: cases.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision, recall, f1,
    avgLatencyMs: Number(t1 - t0) / 1e6 / cases.length,
    failures
  };
}

// ── 3. Consequential-action safety (feeds ISRO category: Visual context
//      accuracy / safety, and is a hard safety requirement independent
//      of any single weighted category) ────────────────────────────────
function runConsequentialActionBenchmark() {
  const cases = loadFixture('consequential-actions.json');
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const failures = [];
  const t0 = process.hrtime.bigint();

  for (const c of cases) {
    const result = ConsequentialActionDetector.isConsequentialElement(c.element, c.element.selector || null, c.context || {});
    const expected = Boolean(c.expectedConsequential);

    if (!expected && !result.isConsequential) {
      tn++;
    } else if (expected && result.isConsequential) {
      // A false "safe" classification on something that should require
      // authorization would be a serious safety miss, so action-type
      // correctness is checked too, not just the boolean.
      if (c.expectedActionType && result.actionType !== c.expectedActionType) {
        fn++;
        failures.push({ id: c.id, expected: `consequential(${c.expectedActionType})`, detected: `consequential(${result.actionType})`, note: c.note || null });
      } else {
        tp++;
      }
    } else {
      if (expected) fn++;
      if (!expected) fp++;
      failures.push({ id: c.id, expected, detected: result.isConsequential, note: c.note || null });
    }
  }

  const t1 = process.hrtime.bigint();
  const { precision, recall, f1 } = prf(tp, fp, fn);

  return {
    category: 'Consequential-action safety gate (hard safety requirement — a false negative here means an unauthorized real-world action)',
    totalCases: cases.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision, recall, f1,
    avgLatencyMs: Number(t1 - t0) / 1e6 / cases.length,
    failures
  };
}

// ── 4. Redaction integrity (ISRO category: Redaction precision, 20%
//      weight) — proxy via the Merkle-proof self-consistency check:
//      does every tile the system claims was redacted actually verify
//      against the pre-redaction commitment, and does tampering with
//      any part of the proof get caught? This doesn't measure IoU
//      against a labeled image dataset (this harness has no images) —
//      it measures whether the cryptographic guarantee behind the
//      "redacted before it left the browser" claim actually holds.
async function runRedactionIntegrityBenchmark() {
  const width = 256, height = 128, tileSize = 64;
  // Deterministic fake pixel data so the run is fully reproducible.
  function fakeCtx() {
    return {
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          const seed = (x * 7919 + y * 104729 + i) % 256;
          data[i] = seed; data[i + 1] = (seed * 3) % 256; data[i + 2] = (seed * 5) % 256; data[i + 3] = 255;
        }
        return { data };
      }
    };
  }

  const redactedBboxes = [{ x: 0, y: 0, width: 64, height: 64 }, { x: 128, y: 64, width: 64, height: 64 }];
  const proof = await MerkleProof.generateRedactionProof(fakeCtx(), width, height, redactedBboxes, tileSize);
  const validResult = await MerkleProof.verifyRedactionProof(proof);

  const tamperedRoot = { ...proof, merkleRoot: '0'.repeat(64) };
  const tamperedRootResult = await MerkleProof.verifyRedactionProof(tamperedRoot);

  const tamperedTiles = JSON.parse(JSON.stringify(proof));
  tamperedTiles.redactedTiles[0].leafHash = '0'.repeat(64);
  const tamperedTilesResult = await MerkleProof.verifyRedactionProof(tamperedTiles);

  const tamperedSig = { ...proof, signature: proof.signature.slice(0, -4) + 'ffff' };
  const tamperedSigResult = await MerkleProof.verifyRedactionProof(tamperedSig);

  const checks = [
    { name: 'valid_proof_verifies', pass: validResult.overallValid === true },
    { name: 'tampered_root_rejected', pass: tamperedRootResult.overallValid === false },
    { name: 'tampered_tile_hash_rejected', pass: tamperedTilesResult.inclusionProofsValid === false },
    { name: 'tampered_signature_rejected', pass: tamperedSigResult.signatureValid === false },
    { name: 'correct_grid_dimensions', pass: proof.gridWidth === width / tileSize && proof.gridHeight === height / tileSize },
    { name: 'correct_redacted_tile_count', pass: proof.redactedTileCount === redactedBboxes.length }
  ];

  const passed = checks.filter((c) => c.pass).length;

  return {
    category: 'Redaction integrity (proxy for Redaction precision, 20% weight)',
    totalChecks: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
    scope: 'Cryptographic self-consistency of the Merkle-proof system (utils/merkleProof.js) against synthetic pixel data — not IoU against a labeled real-image dataset, which this harness has no images to provide.'
  };
}

/**
 * Screen-state perception (utils/visualStateEngine.js).
 *
 * Scored as discrete assertions rather than precision/recall, because each
 * scene tests one claim with a binary correct answer. Roughly half the
 * scenes are false-positive traps: a dark-themed page, a light page with
 * dark chrome, and a scrolled page must all be judged NOT to contain a
 * modal, and a full navigation must not be read as a loading spinner. A
 * detector like this is easy to make look good on positives alone, so the
 * negatives are where the number is actually earned.
 */
function runVisualStateBenchmark() {
  const S = require('./fixtures/visual-state-scenes.js');
  const VSE = require(path.join(AGENT_DIR, 'utils', 'visualStateEngine.js'));

  const page = S.normalPage();
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  // Frame differencing — did the last action do anything?
  add('identical_frames_report_no_change',
    VSE.compareFrames(page, S.clone(page)).verdict === 'no_change');
  add('dropdown_reported_as_localized_change',
    VSE.compareFrames(page, S.pageWithDropdown()).verdict === 'localized_change');
  add('navigation_reported_as_major_change',
    VSE.compareFrames(page, S.differentPage()).verdict === 'major_change');
  add('viewport_resize_not_treated_as_comparable',
    VSE.compareFrames(page, S.blank(400, 260)).comparable === false);

  // Loading detection
  add('rotating_spinner_detected',
    VSE.detectLoadingIndicator(S.pageWithSpinner(0), S.pageWithSpinner(90)).isLoading === true);
  add('static_page_not_loading',
    VSE.detectLoadingIndicator(page, S.clone(page)).isLoading === false);
  add('navigation_not_mistaken_for_spinner',
    VSE.detectLoadingIndicator(page, S.differentPage()).isLoading === false);

  // Blocking-overlay detection, including the false-positive traps
  add('modal_detected', VSE.detectBlockingOverlay(S.pageWithModal()).hasBlockingOverlay === true);
  add('modal_over_dark_page_detected',
    VSE.detectBlockingOverlay(S.darkPageWithModal()).hasBlockingOverlay === true);
  add('normal_page_no_false_modal',
    VSE.detectBlockingOverlay(page).hasBlockingOverlay === false);
  add('TRAP_dark_theme_no_false_modal',
    VSE.detectBlockingOverlay(S.darkThemedPage()).hasBlockingOverlay === false);
  add('TRAP_dark_chrome_no_false_modal',
    VSE.detectBlockingOverlay(S.lightPageWithDarkChrome()).hasBlockingOverlay === false);
  add('TRAP_scroll_not_mistaken_for_modal',
    VSE.detectBlockingOverlay(S.scrolledPage(), page).hasBlockingOverlay === false);
  add('modal_appearing_between_frames_high_confidence',
    VSE.detectBlockingOverlay(S.pageWithModal(), page).confidence === 'high');

  // Paint verification
  add('rendered_button_reported_painted',
    VSE.verifyElementPainted(page, S.PAINTED_BUTTON_BOX).painted === true);
  add('text_block_reported_painted',
    VSE.verifyElementPainted(page, S.PAINTED_TEXT_BOX).painted === true);
  add('featureless_region_reported_unpainted',
    VSE.verifyElementPainted(page, S.UNPAINTED_BOX).painted === false);
  add('tiny_box_fails_open',
    VSE.verifyElementPainted(page, { x: 10, y: 10, width: 2, height: 2 }).confident === false);

  // End-to-end decisions — the "makes decisions" half of the requirement
  const loadingReport = VSE.analyzeScreenState(S.pageWithSpinner(90), S.pageWithSpinner(0), [
    { elementId: 'btn', box: S.PAINTED_BUTTON_BOX },
    { elementId: 'ghost', box: S.UNPAINTED_BOX }
  ]);
  add('report_flags_only_the_unpainted_element',
    loadingReport.unpaintedElementIds.length === 1 && loadingReport.unpaintedElementIds[0] === 'ghost',
    JSON.stringify(loadingReport.unpaintedElementIds));
  add('loading_yields_wait_decision',
    (VSE.deriveVisualDecision(loadingReport, 'click') || {}).action === 'wait');
  add('no_visible_change_after_click_is_flagged',
    (VSE.deriveVisualDecision(VSE.analyzeScreenState(S.clone(page), page, []), 'click') || {}).action
      === 'flag_ineffective_action');
  add('modal_yields_constrain_to_dialog',
    (VSE.deriveVisualDecision(VSE.analyzeScreenState(S.pageWithModal(), null, []), null) || {}).action
      === 'constrain_to_dialog');
  add('successful_click_yields_no_intervention',
    VSE.deriveVisualDecision(VSE.analyzeScreenState(S.pageWithDropdown(), page, []), 'click') === null);

  // Latency on a realistic full-viewport frame
  const big = S.blank(1280, 800);
  for (let i = 0; i < 400; i++) S.rect(big, (i * 37) % 1200, (i * 53) % 760, 40, 8, [60, 60, 70]);
  const big2 = S.clone(big);
  S.rect(big2, 600, 400, 24, 24, [10, 10, 10]);
  const t0 = Date.now();
  VSE.analyzeScreenState(big2, big, [{ elementId: 'e', box: { x: 10, y: 10, width: 80, height: 30 } }]);
  const latencyMs = Date.now() - t0;
  add('full_frame_analysis_under_250ms', latencyMs < 250, `${latencyMs}ms at 1280x800`);

  const passed = checks.filter((c) => c.pass).length;
  return {
    category: 'Local screen-state perception (proxy for Visual context accuracy, 25% weight)',
    totalChecks: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
    latencyMs,
    scope: 'utils/visualStateEngine.js against synthetic scenes with known ground truth, including ' +
           'deliberate false-positive traps (dark theme, dark chrome, scroll). Synthetic scenes are ' +
           'not real screenshots: this validates the decision logic and catches regressions, it is ' +
           'not a claim of accuracy on arbitrary real websites.'
  };
}

/**
 * Icon classification (utils/iconClassifier.js) — runs the SHIPPED
 * JavaScript inference path, not the Python training code, against held-out
 * crops rendered with a seed disjoint from both training and evaluation.
 *
 * Coverage and precision are reported separately because the classifier is
 * deliberately allowed to decline: a wrong label misleads the reasoner,
 * while no label just leaves the status quo. A single "accuracy" figure
 * would hide that tradeoff.
 */
function runIconClassificationBenchmark() {
  const fixture = loadFixture('icon-crops.json');
  require(path.join(AGENT_DIR, 'utils', 'iconModel.js'));
  const IC = require(path.join(AGENT_DIR, 'utils', 'iconClassifier.js'));

  if (!IC.isLoaded()) {
    return {
      category: 'Local icon classification (proxy for Visual context accuracy, 25% weight)',
      totalChecks: 0, passed: 0, failed: 0, checks: [],
      scope: 'SKIPPED — trained weights (utils/iconModel.js) failed to load.'
    };
  }

  let answered = 0, correct = 0, declined = 0;
  const perClass = {};
  const t0 = Date.now();
  for (const s of fixture.samples) {
    const raw = Buffer.from(s.gray_b64, 'base64');
    const data = new Uint8ClampedArray(s.w * s.h * 4);
    for (let p = 0, i = 0; p < raw.length; p++, i += 4) {
      data[i] = raw[p]; data[i + 1] = raw[p]; data[i + 2] = raw[p]; data[i + 3] = 255;
    }
    const result = IC.classifyIcon({ data, width: s.w, height: s.h });
    perClass[s.label] = perClass[s.label] || { answered: 0, correct: 0, total: 0 };
    perClass[s.label].total++;
    if (!result) { declined++; continue; }
    answered++;
    perClass[s.label].answered++;
    if (result.label === s.label) { correct++; perClass[s.label].correct++; }
  }
  const elapsed = Date.now() - t0;

  const coverage = fixture.samples.length > 0 ? answered / fixture.samples.length : 0;
  const precision = answered > 0 ? correct / answered : 0;
  const msPerCrop = fixture.samples.length > 0 ? elapsed / fixture.samples.length : 0;
  const metrics = IC.getMetrics() || {};

  const checks = [
    { name: 'precision_when_answering_at_least_90pct', pass: precision >= 0.90,
      detail: `${(precision * 100).toFixed(1)}%` },
    { name: 'coverage_at_least_70pct', pass: coverage >= 0.70,
      detail: `${(coverage * 100).toFixed(1)}%` },
    { name: 'under_5ms_per_crop', pass: msPerCrop < 5, detail: `${msPerCrop.toFixed(2)}ms` },
    { name: 'model_under_50k_parameters', pass: (metrics.parameters || 0) > 0 && metrics.parameters < 50000,
      detail: `${metrics.parameters} parameters` }
  ];
  const passed = checks.filter((c) => c.pass).length;

  return {
    category: 'Local icon classification (proxy for Visual context accuracy, 25% weight)',
    totalChecks: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
    coverage: Number(coverage.toFixed(4)),
    precisionWhenAnswering: Number(precision.toFixed(4)),
    declined,
    msPerCrop: Number(msPerCrop.toFixed(3)),
    modelParameters: metrics.parameters,
    perClass,
    reportedTrainingMetrics: {
      heldOut: metrics.accuracyInt8HeldOut,
      stressOOD: metrics.accuracyInt8StressOOD,
      shippingThreshold: metrics.shippingThreshold
    },
    scope: 'Runs the shipped JS inference path (utils/iconClassifier.js + utils/iconModel.js) over ' +
           `${fixture.samples.length} held-out synthetic crops. The model is trained on ` +
           'procedurally rendered glyphs, not real site icons, so real-world accuracy will be lower ' +
           'than these numbers — the confidence threshold is what keeps that gap safe rather than ' +
           'harmful. The full 3,500-sample evaluation is recorded in the model metadata.'
  };
}

// ── Report generation ────────────────────────────────────────────────
function toMarkdown(report) {
  const lines = [];
  lines.push(`# Privacy-Vision-Agent — Open Benchmark Results`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('This report is produced by `benchmark/run-benchmark.js` running the extension\'s own unmodified source files against the hand-labeled fixtures in `benchmark/fixtures/`. Re-run it yourself with `node benchmark/run-benchmark.js` — nothing here is hand-edited after the fact.');
  lines.push('');

  for (const section of report.sections) {
    lines.push(`## ${section.category}`);
    lines.push('');
    if (section.precision !== undefined) {
      lines.push(`| Metric | Value |`);
      lines.push(`|---|---|`);
      lines.push(`| Cases | ${section.totalCases} |`);
      lines.push(`| True positives | ${section.truePositives} |`);
      lines.push(`| False positives | ${section.falsePositives} |`);
      lines.push(`| False negatives | ${section.falseNegatives} |`);
      lines.push(`| True negatives | ${section.trueNegatives} |`);
      lines.push(`| Precision | ${(section.precision * 100).toFixed(1)}% |`);
      lines.push(`| Recall | ${(section.recall * 100).toFixed(1)}% |`);
      lines.push(`| F1 | ${(section.f1 * 100).toFixed(1)}% |`);
      lines.push(`| Avg latency/case | ${section.avgLatencyMs.toFixed(3)} ms |`);
      lines.push('');
      if (section.scope) lines.push(`_Scope: ${section.scope}_`);
      lines.push('');
      if (section.failures && section.failures.length > 0) {
        lines.push(`**Failures (${section.failures.length}) — reported honestly, not hidden:**`);
        lines.push('');
        for (const f of section.failures) {
          lines.push(`- \`${f.id}\`: expected \`${JSON.stringify(f.expected)}\`, got \`${JSON.stringify(f.detected)}\`${f.note ? ` — _${f.note}_` : ''}`);
        }
        lines.push('');
      } else {
        lines.push('No failures in this run.');
        lines.push('');
      }
    } else if (section.checks) {
      lines.push(`${section.passed}/${section.totalChecks} checks passed.`);
      lines.push('');
      if (section.coverage !== undefined) {
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        const totalCrops = Object.values(section.perClass || {}).reduce((s, c) => s + c.total, 0);
        lines.push(`| Crops evaluated | ${totalCrops} |`);
        lines.push(`| Answered (confidence >= threshold) | ${(section.coverage * 100).toFixed(1)}% |`);
        lines.push(`| Declined (below threshold) | ${section.declined} |`);
        lines.push(`| Precision when answering | ${(section.precisionWhenAnswering * 100).toFixed(1)}% |`);
        lines.push(`| Latency per crop | ${section.msPerCrop} ms |`);
        lines.push(`| Model parameters | ${section.modelParameters} |`);
        if (section.reportedTrainingMetrics) {
          const m = section.reportedTrainingMetrics;
          lines.push(`| Full held-out accuracy (3,500 samples, from training) | ${(m.heldOut * 100).toFixed(1)}% |`);
          lines.push(`| Out-of-distribution stress accuracy | ${(m.stressOOD * 100).toFixed(1)}% |`);
          lines.push(`| Shipping confidence threshold | ${m.shippingThreshold} |`);
        }
        lines.push('');
      }
      if (section.latencyMs !== undefined) {
        lines.push(`Full-frame analysis latency at 1280x800: **${section.latencyMs} ms**.`);
        lines.push('');
      }
      for (const c of section.checks) {
        lines.push(`- ${c.pass ? '✓' : '✗'} \`${c.name}\`${c.detail ? ` — ${c.detail}` : ''}`);
      }
      lines.push('');
      if (section.scope) lines.push(`_Scope: ${section.scope}_`);
      lines.push('');
    }
  }

  lines.push('## What this benchmark does not measure');
  lines.push('');
  lines.push('The ONNX NER pass, on-device OCR, face detection, and the cloud VLM\'s visual reasoning all require a real browser (offscreen document, canvas, WASM) and are out of scope for this Node-based harness by design, not by oversight. This benchmark measures the deterministic, checksum-gated, zero-model layer of the pipeline — the part that is fully reproducible outside a browser and therefore the part most useful to publish for other teams to independently re-run against their own implementations.');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const [piiResult, fieldResult, consequentialResult, redactionResult] = await Promise.all([
    runPiiDetectionBenchmark(),
    Promise.resolve(runFieldMatchingBenchmark()),
    Promise.resolve(runConsequentialActionBenchmark()),
    runRedactionIntegrityBenchmark()
  ]);
  // Run after the others: these load utils/iconModel.js, which defines a
  // global, and utils/visualStateEngine.js — keeping them sequential makes
  // the module-load order deterministic across runs.
  const visualResult = runVisualStateBenchmark();
  const iconResult = runIconClassificationBenchmark();

  const report = {
    generatedAt: new Date().toISOString(),
    sections: [piiResult, fieldResult, consequentialResult, redactionResult, visualResult, iconResult]
  };

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest-results.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest-results.md'), toMarkdown(report));

  console.log(`\nBenchmark complete. Wrote benchmark/results/latest-results.json and latest-results.md\n`);
  for (const section of report.sections) {
    if (section.precision !== undefined) {
      console.log(`${section.category}: P=${(section.precision * 100).toFixed(1)}% R=${(section.recall * 100).toFixed(1)}% F1=${(section.f1 * 100).toFixed(1)}% (${section.failures.length} failures)`);
    } else {
      console.log(`${section.category}: ${section.passed}/${section.totalChecks} checks passed`);
    }
  }
}

main().catch((err) => {
  console.error('Benchmark run failed:', err);
  process.exit(1);
});
