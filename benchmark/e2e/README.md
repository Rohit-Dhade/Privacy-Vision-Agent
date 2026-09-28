# Real-browser end-to-end tests

Everything else in this repository tests the extension's logic in Node. This
directory is the only place the extension is actually **run**: loaded
unpacked into a real Chromium, pointed at a real page, driven through its own
service worker and content scripts.

That distinction turned out to matter. The Node harness in
`benchmark/run-benchmark.js` reported 100% across every section while the
extension contained a bug that made the entire agent fail to start whenever
the ONNX runtime could not initialise. No amount of unit testing was going to
find that, because the failure lived in the wiring rather than the logic.

```
npm install                 # in this directory
npx playwright install chromium
npm test                    # 55 assertions
npm run demo                # writes the demo artifacts to ./out
```

Extensions require a headed browser. On a machine with no display:

```
npm run test:headless-host  # wraps the run in xvfb
```

`PVA_CHROME=/path/to/chrome` uses a specific binary instead of Playwright's.

## What `run-e2e.js` covers

Six groups, 55 assertions, each independent so one failure cannot mask
another:

1. **Load and injection** — the extension registers its service worker, and
   the manifest's static content script is present in the isolated world.
   (It is queried through `chrome.scripting.executeScript`, not
   `page.evaluate`, because the isolated world is invisible to the main one —
   a distinction that produced a false failure the first time.)
2. **The full extraction pipeline**, invoked as `performAnalysis()` in the
   service worker exactly as the side panel invokes it: DOM extraction, PII
   detection, screenshot capture, and the ONNX/YuNet face pass. The test
   detects which path it is on and asserts accordingly — see the degradation
   contract below. On the full path it requires exactly one face, located
   inside the fixture's photograph element.
3. **PII detection against known ground truth** — every value in the fixture
   is a published test vector or was generated to satisfy the real checksum,
   and the expected types are asserted individually.
4. **The popup-side pipeline on the real screenshot** — real bounding boxes
   mapped through `coordinateMapper`, a real Merkle proof over real raw
   pixels (plus a tamper-rejection check), the perception layer over a real
   frame, the trained icon classifier over really-rendered SVG icons, and
   the outbound privacy boundary including the inverse case (an unsanitized
   payload carrying a live card number must be blocked).
5. **Blocking-overlay detection with a real modal open** — the fixture's
   consent dialog is opened, the page re-analysed, and the measured dialog
   rectangle compared against what the DOM reports.
5b. **No false faces on a faceless page** — the main fixture carries a face,
   so the opposite property gets its own page. A detector that hallucinates
   faces would black out arbitrary regions of every screenshot, which is
   worse than missing one.
6. **Console hygiene** — any unexpected console error fails the run. Network
   errors are filtered, since there is no agent backend in a test sandbox.

## The degradation contract

Test 2 asserts something subtler than "it worked". Face detection is allowed
to be unavailable — it depends on the ONNX runtime, WASM support and a model
file, any of which can be missing on a real user's machine. What it may not
do is fail in either of the two tempting ways:

- **It must not kill the analysis.** It used to. `detectFacesInScreenshot()`
  rejected, the rejection propagated out of `performAnalysis()`, and the user
  got no DOM extraction, no PII detection, no redaction and no agent —
  because one of several redaction inputs was unavailable.
- **It must not fail silently.** An empty face list from a broken detector is
  indistinguishable from a page with no faces on it, and that difference
  decides whether an un-redacted face reaches the cloud reasoner. So the
  service worker returns `faceDetectionAvailable: false` with a reason, and
  the side panel tells the user their screenshots are not being face-redacted
  this session.

The test asserts all of it: the flag is present and boolean, and when it is
false the extraction, the screenshot and the explanation all still arrive.

**Both paths are exercised, and both were verified.** With
`Browser-Agent/lib/*.wasm` present the run takes the full path — the ONNX
runtime starts, YuNet loads, and inference runs against the real captured
screenshot — and the test says so explicitly (`PATH: full`): **55 passed, 0
failed**. Rename the WASM binaries and the same run reports `PATH: degraded`,
asserts the degradation contract instead, and gives **49 passed, 0 failed** —
the six face-specific assertions do not apply when there is no face detector,
so they are skipped rather than faked.

Both numbers were measured, not predicted. The point of keeping the degraded
path green is that it is a state real users will hit, and it used to be fatal.

## Face redaction is proven, not assumed

The fixture carries a **drawn** face, not a photograph of a real person —
generated by `make-test-face.py`, which is committed so the fixture is
reproducible. That is only worth anything if the face is genuinely detected,
so six variants of increasing realism were each run through the extension's
own detection path; all six were detected with sensible boxes, and the most
realistic is the one embedded.

The redaction itself is then verified by sampling pixels rather than trusting
the box arithmetic: the face region must be **more than 50% non-black before**
redaction and **exactly 0% non-black after**. A box that was mapped to the
wrong place, or painted with the wrong dimensions, fails that.

## What `render-demo-artifacts.js` produces

Into `./out`:

| file | |
|---|---|
| `raw.png` | the screenshot as captured |
| `redacted.png` | after redaction — what would actually be transmitted |
| `redacted-annotated.png` | every redacted region outlined and labelled with its detected type |
| `redaction-proof.json` | the signed Merkle proof, verifiable in `Browser-Agent/tools/verify-redaction-proof.html` |

The annotated image is worth generating even when the assertions pass,
because looking at it is how two real privacy bugs were found that no
assertion was checking for: a passport MRZ whose **name line** was still
legible next to its blacked-out number line, and an Indian mobile number in
`+91 98765 43210` form that the phone pattern could not match at all. Both
are now benchmark fixtures.

## Bugs this directory has found

Kept as a record, because each one was invisible to every other layer of
testing:

1. **A face-detection failure killed the whole agent.** Wiring, not logic —
   and the reason both paths are now tested separately.
2. **MRZ line 1 was structurally unmatchable.** It ends in filler `<`, and
   `<` is not a word character, so the `\b`-anchored pattern could never
   match it — passport holder names were never redacted.
3. **The most common Indian mobile format was never detected.** 5+5 grouping
   against a 3-4/3-4 pattern, with the same trailing-`\b` problem.
4. **Single-frame modal detection failed on the first real modal it saw.**
   Averaging luminance over a "centre region" that is mostly backdrop is the
   wrong statistic; and a **scrollbar**, which sits outside a fixed-position
   scrim, unioned itself into the bright-pixel bounding box and destroyed the
   measurement. Fixed by measuring connected components instead.
5. **The icon-candidate cap was set to 5** on a guess about cost, when the
   measured cost is ~0.5ms per icon. Dense application toolbars were having
   most of their icons ignored.
6. **Face redaction had never been executed at all.** Not a defect in the
   code, which turned out to be correct — but until a detectable face existed
   in a fixture, the detect-then-paint path had no test covering it, and the
   demo artifacts it produces were showing PII redaction only.

Two things that looked like bugs and were not, also recorded so they are not
"fixed" later by mistake: PII below the fold is correctly **not** redacted
(it is not in the captured screenshot), and `ABCDE1234F` is correctly **not**
a PAN (the 4th character must be a real holder-category letter). A third: the
face box covers the face but not the hair above it or the neck below, which
is correct — YuNet reports the face region and the identifying features are
what get painted over.
