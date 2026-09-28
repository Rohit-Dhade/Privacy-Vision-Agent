# Privacy-Vision-Agent — Open Benchmark

An open, reproducible evaluation harness — Pillar 4 of `claude/v07-original-system-design-global.md` in the project notes: *"publish (as a separate, MIT-licensed repo) a small evaluation harness... run your own system against it and publish the real numbers, including where they're weak... invite other teams to run their agents against the same harness."*

## What this is

`run-benchmark.js` loads the extension's own, unmodified source files (`content/piiDetector.js`, `agent/fieldMatcher.js`, `agent/consequentialActionDetector.js`, `agent/debateManager.js`, `agent/confidenceScorer.js`, `utils/merkleProof.js`) directly under Node and runs them against small, hand-labeled JSON (and, for scenario-style fixtures, plain JS) fixtures with known ground truth in `fixtures/`. It computes precision/recall/F1 and latency for the detection-layer sections, mapped explicitly to the categories ISRO's PS26171 rubric weights, plus discrete pass/fail checks for the sections that test decision logic rather than detection accuracy, and writes the results to `results/latest-results.md` and `.json` — nothing is hand-edited after a run.

## Running it

```
node benchmark/run-benchmark.js
```

No `npm install` needed — the harness has zero dependencies beyond Node itself, deliberately, so it stays trivial for another team to clone and run against their own implementation of the same detectors.

## What it measures, and what it deliberately doesn't

| Section | ISRO category it feeds | What it actually exercises |
|---|---|---|
| Sensitive data detection | Sensitive data detection (20%) | The regex + checksum layer: Luhn (cards, Canada SIN), Verhoeff (Aadhaar), ISO 7064 mod-97 (IBAN) / mod-11-10 (Germany VAT) / mod-89-style (Australia ABN), ICAO 9303 (passport MRZ), GB 11643-1999 (China resident ID), Japan's My Number check digit, Brazil's CPF two-check-digit algorithm, Australia's TFN mod-11 check, the SSA's SSN exclusion rules, plus Shannon-entropy secret detection and several format-only (no public checksum) types disclosed as such — UK NINO, Mexico CURP/RFC |
| Local field-matching accuracy | Feeds Visual context accuracy (25%) | `agent/fieldMatcher.js`'s label/type/regex resolution of a DOM element to a private-data key |
| Consequential-action safety gate | Hard safety requirement | `agent/consequentialActionDetector.js`'s classification of which buttons require human authorization |
| Redaction integrity | Redaction precision (20%) | Cryptographic self-consistency of `utils/merkleProof.js` — does a valid proof verify, and does tampering with the root, a tile hash, or the signature get caught |
| Hybrid Debate resolution logic | New Privacy Dial mode, not an ISRO category | `agent/debateManager.js`'s agree/disagree/degraded resolution tiers and `agent/confidenceScorer.js`'s scoring, against mocked local/cloud reasoner responses in `fixtures/debate-scenarios.js` — discrete pass/fail checks, not precision/recall, since each scenario asserts one specific resolution outcome |

**Deliberately out of scope**: the ONNX NER pass, on-device OCR, face detection, and the cloud VLM's visual reasoning all need a real browser (offscreen document, canvas, WASM runtime) that this Node harness does not simulate. Rather than mock these into a misleading "pass," the harness stubs the NER call to return no results (exactly how the real extension degrades if the model fails to load) and reports every metric as scoped to what actually ran. Client resource utilization and end-to-end latency are measured live, in the running extension, by the Privacy Receipt / benchmark dashboard panel (`popup/popup.js`) instead — that's the harness for the parts that genuinely need a browser to mean anything.

## This is a small, hand-authored fixture set — and it already found a real bug

The fixture files are dozens of cases each, not thousands — this demonstrates methodology and catches obvious regressions; it is not a claim of statistically robust dataset coverage. What it is NOT is a rigged demo: several fixtures were written to specifically probe cases the system was expected to handle correctly, and the first real run of this harness caught a genuine off-by-one bug in `utils/merkleProof.js`'s `tileIndicesForBbox()` — a redaction bounding box whose right or bottom edge landed exactly on a tile boundary was claiming one extra row/column of tiles as "redacted" in its cryptographic proof than the box actually covered. It didn't leak anything (a hash reveals nothing about its input either way), but it was a real correctness bug in what the proof claimed, and it was fixed the same day it was found, directly because this harness exists. That's the point of publishing an open, runnable benchmark instead of a set of claimed numbers: it finds things.

One other fixture documents a real, current limitation rather than a bug to silently patch around:

- `field-matching.json`'s `emergency-phone-not-generic-phone`: an HTML `type="tel"` field short-circuits to the generic "phone" key before a more specific label like "Emergency Contact" gets a chance to match — not a safety issue (the field still gets a phone-shaped value), but a precision gap worth fixing later (prefer specific label matches over generic type matches when both are available).

`pii-field-values.json`'s Aadhaar/IBAN/card-number cases used to have the opposite problem: the PHONE regex was loose enough to also match digit substrings inside otherwise-correctly-classified IDs, so a field correctly flagged as `AADHAAR` also picked up an extra, spurious `PHONE` label, dragging measured precision on that section down to ~42% even though recall was 100% (nothing was ever missed). That was fixed by `makeRangeClaimTracker()` in `content/piiDetector.js` (every checksum/format-validated detector claims its matched character range so the loose, deliberately-last-run PHONE pattern skips anything already claimed) — the section now runs at 100%/100%/100% precision/recall/F1, including the 13 additional multi-jurisdiction fixture cases (SSN, UK NINO, Germany VAT, China resident ID, Japan My Number, Brazil CPF, Canada SIN, Australia TFN/ABN, Mexico CURP) added alongside the detector's own expansion into those countries.

One inherent ambiguity is worth calling out rather than hiding: Canada's SIN and Australia's TFN are both bare 9-digit numbers with no distinguishing prefix, so a number that happens to satisfy both countries' checksums at once (roughly a 1-in-100 chance for a random 9-digit run) is claimed by whichever detector runs first (`CANADA_SIN`, ahead of `AU_TFN` in `content/piiDetector.js`'s detection order) — see `valid-australia-tfn`'s fixture note for a worked example. This doesn't cause a miss (the number is still flagged as sensitive and redacted), only a possible mislabel of which country's ID it is.

## Contributing a fixture or running your own agent against this

Add a case to the relevant `fixtures/*.json` file following the existing shape (see any entry for the fields expected) and re-run the script — no code changes needed for a new test case, only for a new *category* of check. Another team's agent can point its own equivalent detection functions at these same fixture files and publish a comparable report; the ground truth (real IBAN/MRZ/Aadhaar checksum test vectors, real Luhn-valid card numbers) is standards-based and not specific to this implementation.
