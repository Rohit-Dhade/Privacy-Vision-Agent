# Privacy-Vision-Agent — Open Benchmark Results

Generated: 2026-09-24T09:45:20.279Z

This report is produced by `benchmark/run-benchmark.js` running the extension's own unmodified source files against the hand-labeled fixtures in `benchmark/fixtures/`. Re-run it yourself with `node benchmark/run-benchmark.js` — nothing here is hand-edited after the fact.

## Sensitive data detection (ISRO weight: 20%)

| Metric | Value |
|---|---|
| Cases | 38 |
| True positives | 28 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 10 |
| Precision | 100.0% |
| Recall | 100.0% |
| F1 | 100.0% |
| Avg latency/case | 15.052 ms |

_Scope: Regex + checksum layer only (Luhn/Verhoeff/IBAN-mod97/ICAO-9303-MRZ/entropy). NER pass excluded — requires the real browser offscreen document._

No failures in this run.

## Local field-matching accuracy (feeds Visual context accuracy, 25% weight)

| Metric | Value |
|---|---|
| Cases | 13 |
| True positives | 8 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 5 |
| Precision | 100.0% |
| Recall | 100.0% |
| F1 | 100.0% |
| Avg latency/case | 5.326 ms |


No failures in this run.

## Consequential-action safety gate (hard safety requirement — a false negative here means an unauthorized real-world action)

| Metric | Value |
|---|---|
| Cases | 12 |
| True positives | 7 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 5 |
| Precision | 100.0% |
| Recall | 100.0% |
| F1 | 100.0% |
| Avg latency/case | 0.673 ms |


No failures in this run.

## Redaction integrity (proxy for Redaction precision, 20% weight)

6/6 checks passed.

- ✓ `valid_proof_verifies`
- ✓ `tampered_root_rejected`
- ✓ `tampered_tile_hash_rejected`
- ✓ `tampered_signature_rejected`
- ✓ `correct_grid_dimensions`
- ✓ `correct_redacted_tile_count`

_Scope: Cryptographic self-consistency of the Merkle-proof system (utils/merkleProof.js) against synthetic pixel data — not IoU against a labeled real-image dataset, which this harness has no images to provide._

## Hybrid Debate resolution logic (v25 Part 3, Task 6.1 — new Privacy Dial mode, not an ISRO rubric category)

52/52 checks passed.

- ✓ `agree-same-target-high-confidence__does_not_throw` — Both reasoners pick the same field and are both fairly confident — should resolve as a plain AGREE, using whichever side scored (marginally) higher.
- ✓ `agree-same-target-high-confidence__mode_FULL_DEBATE` — got FULL_DEBATE
- ✓ `agree-same-target-high-confidence__resolution_AGREE` — got AGREE
- ✓ `agree-same-target-high-confidence__agreement_true` — got true
- ✓ `agree-same-target-high-confidence__decided_by_local` — got local
- ✓ `agree-same-target-high-confidence__winner_action_click` — got click
- ✓ `agree-same-target-high-confidence__winner_target_#next` — got #next
- ✓ `agree-same-target-high-confidence__decision_has_numeric_confidence`
- ✓ `agree-no-target-both-wait__does_not_throw` — Both reasoners propose a targetless action (wait) — actionsRoughlyMatch() has an explicit branch for this; it should still count as agreement.
- ✓ `agree-no-target-both-wait__mode_FULL_DEBATE` — got FULL_DEBATE
- ✓ `agree-no-target-both-wait__resolution_AGREE` — got AGREE
- ✓ `agree-no-target-both-wait__agreement_true` — got true
- ✓ `agree-no-target-both-wait__decided_by_local` — got local
- ✓ `agree-no-target-both-wait__winner_action_wait` — got wait
- ✓ `agree-no-target-both-wait__decision_has_numeric_confidence`
- ✓ `disagree-small-gap-auto-resolve__does_not_throw` — Different targets, confidence gap under 5% — small enough to auto-resolve to the higher-confidence side without extra fanfare.
- ✓ `disagree-small-gap-auto-resolve__mode_FULL_DEBATE` — got FULL_DEBATE
- ✓ `disagree-small-gap-auto-resolve__resolution_DISAGREE_AUTO_RESOLVE` — got DISAGREE_AUTO_RESOLVE
- ✓ `disagree-small-gap-auto-resolve__agreement_false` — got false
- ✓ `disagree-small-gap-auto-resolve__decided_by_cloud` — got cloud
- ✓ `disagree-small-gap-auto-resolve__winner_action_click` — got click
- ✓ `disagree-small-gap-auto-resolve__winner_target_#b` — got #b
- ✓ `disagree-small-gap-auto-resolve__decision_has_numeric_confidence`
- ✓ `disagree-medium-gap-show-both__does_not_throw` — Confidence gap of 10 points (0.70 vs 0.80) — in the 5%-15% band where both sides should be shown to the user, not silently auto-resolved.
- ✓ `disagree-medium-gap-show-both__mode_FULL_DEBATE` — got FULL_DEBATE
- ✓ `disagree-medium-gap-show-both__resolution_DISAGREE_SHOW_BOTH` — got DISAGREE_SHOW_BOTH
- ✓ `disagree-medium-gap-show-both__agreement_false` — got false
- ✓ `disagree-medium-gap-show-both__decided_by_cloud` — got cloud
- ✓ `disagree-medium-gap-show-both__winner_action_click` — got click
- ✓ `disagree-medium-gap-show-both__winner_target_#b` — got #b
- ✓ `disagree-medium-gap-show-both__decision_has_numeric_confidence`
- ✓ `disagree-large-gap-ask-user-recommended__does_not_throw` — Confidence gap of 30 points (0.60 vs 0.90) — wide disagreement should be flagged strongly, recommending the user look before this executes.
- ✓ `disagree-large-gap-ask-user-recommended__mode_FULL_DEBATE` — got FULL_DEBATE
- ✓ `disagree-large-gap-ask-user-recommended__resolution_DISAGREE_ASK_USER_RECOMMENDED` — got DISAGREE_ASK_USER_RECOMMENDED
- ✓ `disagree-large-gap-ask-user-recommended__agreement_false` — got false
- ✓ `disagree-large-gap-ask-user-recommended__decided_by_cloud` — got cloud
- ✓ `disagree-large-gap-ask-user-recommended__winner_action_click` — got click
- ✓ `disagree-large-gap-ask-user-recommended__winner_target_#pay-now` — got #pay-now
- ✓ `disagree-large-gap-ask-user-recommended__decision_has_numeric_confidence`
- ✓ `local-only-degraded-cloud-backend-down__does_not_throw` — Cloud backend errors out (e.g. network failure) — debate should degrade gracefully to the local decision alone, not throw.
- ✓ `local-only-degraded-cloud-backend-down__mode_LOCAL_ONLY_DEGRADED` — got LOCAL_ONLY_DEGRADED
- ✓ `local-only-degraded-cloud-backend-down__agreement_null` — got null
- ✓ `local-only-degraded-cloud-backend-down__winner_action_fill_from_local` — got fill_from_local
- ✓ `local-only-degraded-cloud-backend-down__decision_has_numeric_confidence`
- ✓ `cloud-only-degraded-local-model-unavailable__does_not_throw` — On-device WebLLM not available yet (e.g. not vendored, or model still loading) — debate should degrade gracefully to the cloud decision alone.
- ✓ `cloud-only-degraded-local-model-unavailable__mode_CLOUD_ONLY_DEGRADED` — got CLOUD_ONLY_DEGRADED
- ✓ `cloud-only-degraded-local-model-unavailable__agreement_null` — got null
- ✓ `cloud-only-degraded-local-model-unavailable__winner_action_click` — got click
- ✓ `cloud-only-degraded-local-model-unavailable__winner_target_#submit` — got #submit
- ✓ `cloud-only-degraded-local-model-unavailable__decision_has_numeric_confidence`
- ✓ `both-reasoners-fail__throws_when_both_reasoners_fail` — Both the local model and the cloud backend fail in the same step — there is nothing left to act on, so this must throw rather than silently returning a fabricated decision.
- ✓ `both-reasoners-fail__error_carries_both_underlying_messages`

_Scope: agent/debateManager.js + agent/confidenceScorer.js run unmodified; only agentBackend.decideNextActionLocalLLM()/decideNextAction() are mocked per scenario (benchmark/fixtures/debate-scenarios.js). Every scenario passes evidence:{} so confidenceScorer.js's combineFactors() has only one present factor (modelSelfConfidence) and the scored confidence is deterministic. The real, multi-factor scoring behavior (checksum strength, HTTPS, domain reputation, etc.) is exercised implicitly wherever those factors are unit-tested elsewhere, not re-verified here._

## Local screen-state perception (proxy for Visual context accuracy, 25% weight)

23/24 checks passed.

Full-frame analysis latency at 1280x800: **573 ms**.

- ✓ `identical_frames_report_no_change`
- ✓ `dropdown_reported_as_localized_change`
- ✓ `navigation_reported_as_major_change`
- ✓ `viewport_resize_not_treated_as_comparable`
- ✓ `rotating_spinner_detected`
- ✓ `static_page_not_loading`
- ✓ `navigation_not_mistaken_for_spinner`
- ✓ `modal_detected`
- ✓ `modal_over_dark_page_detected`
- ✓ `normal_page_no_false_modal`
- ✓ `TRAP_dark_theme_no_false_modal`
- ✓ `TRAP_dark_chrome_no_false_modal`
- ✓ `TRAP_scroll_not_mistaken_for_modal`
- ✓ `modal_appearing_between_frames_high_confidence`
- ✓ `rendered_button_reported_painted`
- ✓ `text_block_reported_painted`
- ✓ `featureless_region_reported_unpainted`
- ✓ `tiny_box_fails_open`
- ✓ `report_flags_only_the_unpainted_element` — ["ghost"]
- ✓ `loading_yields_wait_decision`
- ✓ `no_visible_change_after_click_is_flagged`
- ✓ `modal_yields_constrain_to_dialog`
- ✓ `successful_click_yields_no_intervention`
- ✗ `full_frame_analysis_under_250ms` — 573ms at 1280x800

_Scope: utils/visualStateEngine.js against synthetic scenes with known ground truth, including deliberate false-positive traps (dark theme, dark chrome, scroll). Synthetic scenes are not real screenshots: this validates the decision logic and catches regressions, it is not a claim of accuracy on arbitrary real websites._

## Local icon classification (proxy for Visual context accuracy, 25% weight)

3/4 checks passed.

| Metric | Value |
|---|---|
| Crops evaluated | 70 |
| Answered (confidence >= threshold) | 88.6% |
| Declined (below threshold) | 8 |
| Precision when answering | 100.0% |
| Latency per crop | 13.171 ms |
| Model parameters | 6862 |
| Full held-out accuracy (3,500 samples, from training) | 91.5% |
| Out-of-distribution stress accuracy | 76.9% |
| Shipping confidence threshold | 0.6 |

- ✓ `precision_when_answering_at_least_90pct` — 100.0%
- ✓ `coverage_at_least_70pct` — 88.6%
- ✗ `under_5ms_per_crop` — 13.17ms
- ✓ `model_under_50k_parameters` — 6862 parameters

_Scope: Runs the shipped JS inference path (utils/iconClassifier.js + utils/iconModel.js) over 70 held-out synthetic crops. The model is trained on procedurally rendered glyphs, not real site icons, so real-world accuracy will be lower than these numbers — the confidence threshold is what keeps that gap safe rather than harmful. The full 3,500-sample evaluation is recorded in the model metadata._

## What this benchmark does not measure

The ONNX NER pass, on-device OCR, face detection, and the cloud VLM's visual reasoning all require a real browser (offscreen document, canvas, WASM) and are out of scope for this Node-based harness by design, not by oversight. This benchmark measures the deterministic, checksum-gated, zero-model layer of the pipeline — the part that is fully reproducible outside a browser and therefore the part most useful to publish for other teams to independently re-run against their own implementations.
