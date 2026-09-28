# Privacy-Vision-Agent — Open Benchmark

An open, reproducible evaluation harness — Pillar 4 of `claude/v07-original-system-design-global.md` in the project notes: *"publish (as a separate, MIT-licensed repo) a small evaluation harness... run your own system against it and publish the real numbers, including where they're weak... invite other teams to run their agents against the same harness."*

## What this is

`run-benchmark.js` loads the extension's own, unmodified source files (`content/piiDetector.js`, `agent/fieldMatcher.js`, `agent/consequentialActionDetector.js`, `utils/merkleProof.js`) directly under Node and runs them against small, hand-labeled JSON fixtures with known ground truth in `fixtures/`. It computes precision/recall/F1 and latency, mapped explicitly to the categories ISRO's PS26171 rubric weights, and writes the results to `results/latest-results.md` and `.json` — nothing is hand-edited after a run.

## Running it

```
node benchmark/run-benchmark.js
```

No `npm install` needed — the harness has zero dependencies beyond Node itself, deliberately, so it stays trivial for another team to clone and run against their own implementation of the same detectors.

## What it measures, and what it deliberately doesn't

| Section | ISRO category it feeds | What it actually exercises |
|---|---|---|
| Sensitive data detection | Sensitive data detection (20%) | The regex + checksum layer only: Luhn (cards), Verhoeff (Aadhaar), ISO 7064 mod-97 (IBAN), ICAO 9303 (passport MRZ), Shannon-entropy secret detection |
| Local field-matching accuracy | Feeds Visual context accuracy (25%) | `agent/fieldMatcher.js`'s label/type/regex resolution of a DOM element to a private-data key |
| Consequential-action safety gate | Hard safety requirement | `agent/consequentialActionDetector.js`'s classification of which buttons require human authorization |
| Redaction integrity | Redaction precision (20%) | Cryptographic self-consistency of `utils/merkleProof.js` — does a valid proof verify, and does tampering with the root, a tile hash, or the signature get caught |

**Deliberately out of scope**: the ONNX NER pass, on-device OCR, face detection, and the cloud VLM's visual reasoning all need a real browser (offscreen document, canvas, WASM runtime) that this Node harness does not simulate. Rather than mock these into a misleading "pass," the harness stubs the NER call to return no results (exactly how the real extension degrades if the model fails to load) and reports every metric as scoped to what actually ran. Client resource utilization and end-to-end latency are measured live, in the running extension, by the Privacy Receipt / benchmark dashboard panel (`popup/popup.js`) instead — that's the harness for the parts that genuinely need a browser to mean anything.

## This is a small, hand-authored fixture set — and it already found a real bug

The fixture files are dozens of cases each, not thousands — this demonstrates methodology and catches obvious regressions; it is not a claim of statistically robust dataset coverage. What it is NOT is a rigged demo: several fixtures were written to specifically probe cases the system was expected to handle correctly, and the first real run of this harness caught a genuine off-by-one bug in `utils/merkleProof.js`'s `tileIndicesForBbox()` — a redaction bounding box whose right or bottom edge landed exactly on a tile boundary was claiming one extra row/column of tiles as "redacted" in its cryptographic proof than the box actually covered. It didn't leak anything (a hash reveals nothing about its input either way), but it was a real correctness bug in what the proof claimed, and it was fixed the same day it was found, directly because this harness exists. That's the point of publishing an open, runnable benchmark instead of a set of claimed numbers: it finds things.

Two other fixtures document real, current limitations rather than bugs to silently patch around:

- `field-matching.json`'s `emergency-phone-not-generic-phone`: an HTML `type="tel"` field short-circuits to the generic "phone" key before a more specific label like "Emergency Contact" gets a chance to match — not a safety issue (the field still gets a phone-shaped value), but a precision gap worth fixing later (prefer specific label matches over generic type matches when both are available).
- `pii-field-values.json`'s Aadhaar/IBAN/card-number cases: the PHONE regex is loose enough to also match digit substrings inside otherwise-correctly-classified IDs, so a field correctly flagged as `AADHAAR` also gets an extra, spurious `PHONE` label. This drags the measured precision on that section down to ~42% even though recall is 100% (nothing is ever missed) — an honest number that's worse than the polished one might have looked, and a concrete, actionable target for the next round: tighten PHONE's boundary conditions or de-duplicate overlapping detections by type-specificity.

## Contributing a fixture or running your own agent against this

Add a case to the relevant `fixtures/*.json` file following the existing shape (see any entry for the fields expected) and re-run the script — no code changes needed for a new test case, only for a new *category* of check. Another team's agent can point its own equivalent detection functions at these same fixture files and publish a comparable report; the ground truth (real IBAN/MRZ/Aadhaar checksum test vectors, real Luhn-valid card numbers) is standards-based and not specific to this implementation.
