# Privacy-Vision-Agent — Open Benchmark Results

Generated: 2026-09-18T16:02:30.107Z

This report is produced by `benchmark/run-benchmark.js` running the extension's own unmodified source files against the hand-labeled fixtures in `benchmark/fixtures/`. Re-run it yourself with `node benchmark/run-benchmark.js` — nothing here is hand-edited after the fact.

## Sensitive data detection (ISRO weight: 20%)

| Metric | Value |
|---|---|
| Cases | 25 |
| True positives | 18 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 7 |
| Precision | 100.0% |
| Recall | 100.0% |
| F1 | 100.0% |
| Avg latency/case | 1.741 ms |

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
| Avg latency/case | 0.764 ms |


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
| Avg latency/case | 0.335 ms |


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

## Local screen-state perception (proxy for Visual context accuracy, 25% weight)

24/24 checks passed.

Full-frame analysis latency at 1280x800: **31 ms**.

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
- ✓ `full_frame_analysis_under_250ms` — 31ms at 1280x800

_Scope: utils/visualStateEngine.js against synthetic scenes with known ground truth, including deliberate false-positive traps (dark theme, dark chrome, scroll). Synthetic scenes are not real screenshots: this validates the decision logic and catches regressions, it is not a claim of accuracy on arbitrary real websites._

## Local icon classification (proxy for Visual context accuracy, 25% weight)

4/4 checks passed.

| Metric | Value |
|---|---|
| Crops evaluated | 70 |
| Answered (confidence >= threshold) | 88.6% |
| Declined (below threshold) | 8 |
| Precision when answering | 100.0% |
| Latency per crop | 2.414 ms |
| Model parameters | 6862 |
| Full held-out accuracy (3,500 samples, from training) | 91.5% |
| Out-of-distribution stress accuracy | 76.9% |
| Shipping confidence threshold | 0.6 |

- ✓ `precision_when_answering_at_least_90pct` — 100.0%
- ✓ `coverage_at_least_70pct` — 88.6%
- ✓ `under_5ms_per_crop` — 2.41ms
- ✓ `model_under_50k_parameters` — 6862 parameters

_Scope: Runs the shipped JS inference path (utils/iconClassifier.js + utils/iconModel.js) over 70 held-out synthetic crops. The model is trained on procedurally rendered glyphs, not real site icons, so real-world accuracy will be lower than these numbers — the confidence threshold is what keeps that gap safe rather than harmful. The full 3,500-sample evaluation is recorded in the model metadata._

## What this benchmark does not measure

The ONNX NER pass, on-device OCR, face detection, and the cloud VLM's visual reasoning all require a real browser (offscreen document, canvas, WASM) and are out of scope for this Node-based harness by design, not by oversight. This benchmark measures the deterministic, checksum-gated, zero-model layer of the pipeline — the part that is fully reproducible outside a browser and therefore the part most useful to publish for other teams to independently re-run against their own implementations.
