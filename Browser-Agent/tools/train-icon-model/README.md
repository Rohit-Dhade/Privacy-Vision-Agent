# Training the local icon classifier

Everything needed to regenerate `Browser-Agent/utils/iconModel.js` from
scratch. The published weights were produced by exactly these scripts; the
point of committing them is that the model shipped in this extension is
reproducible rather than a binary blob you have to take on trust.

```
pip install numpy pillow
python3 train_icons.py          # ~6 minutes on CPU, no GPU required
node verify-js-parity.js        # confirms the JS port matches Python exactly
```

`train_icons.py` writes `icon-model.json` and `parity-fixture.json`, caches
its dataset in `icon-data.npz` and its weights in `icon-weights.npz` (delete
either to regenerate), and prints the full evaluation. Convert the JSON into
the shipped `utils/iconModel.js` wrapper by assigning it to
`root.__BA_IconModelData`.

## What the model is

A 6,862-parameter CNN — `conv(8) → pool → conv(16) → pool → fc(14)` on a
20x20 grayscale input — quantised to int8, about 10KB of weights, running in
plain JavaScript (`utils/iconClassifier.js`). No ONNX runtime, no WASM, no
WebGPU, no first-run download.

It answers one narrow question: given a crop of an unlabeled icon-only
button, which of fourteen common glyphs is it — `menu`, `close`, `search`,
`cart`, `user`, `settings`, `chevron_left`, `chevron_right`, `plus`, `more`,
`download`, `heart`, `play`, or `other`.

## Measured results

| | |
|---|---|
| Held-out accuracy (3,500 samples) | 91.5% |
| Out-of-distribution stress set | 76.9% |
| Precision at shipping threshold 0.60 | 98.1% |
| Coverage at that threshold | 88.0% |
| int8 vs float32 accuracy | no measurable loss |
| Inference | ~0.5 ms per crop |

The operating point is chosen for precision, not accuracy. A wrong label
actively misleads the reasoner downstream; declining to answer merely leaves
the status quo, so the classifier returns `null` below the threshold and the
pipeline behaves as it did before it existed.

## Honest caveats

**The training data is synthetic.** The icon sets this should ideally learn
from — Material Symbols, Font Awesome, Bootstrap Icons — live on npm/CDN
hosts outside this project's build-time network allowlist, so the glyphs are
drawn procedurally by `icon_render.py` instead. Those shapes are highly
standardised across icon sets (a hamburger is three bars everywhere), so the
transfer is real, but **accuracy on arbitrary real websites will be lower
than the numbers above** and should not be quoted as if it were measured on
real web icons. If the icon sets ever become reachable at build time,
rendering them is the single highest-value improvement available here.

**Train and test share a generator.** The held-out set uses a disjoint seed,
and the stress set additionally pushes size, rotation, contrast, blur and
noise beyond the training ranges — the ~15-point drop from 91.5% to 76.9% is
the honest estimate of how much that matters.

## Things learned the hard way, preserved so they are not relearned

Two mistakes were made while building this and are worth keeping on record,
because both produced confident, plausible, wrong numbers:

1. **An MLP trained on clean glyphs and evaluated on degraded ones scored
   100% on training data and 46% held out.** Robustness you never train for
   is not robustness. The fix was to apply the full augmentation range —
   blur, noise, low contrast, intrusive borders — to training as well, and
   to switch to a CNN, whose weight sharing is worth far more per parameter
   on a task that is entirely about local shape.

2. **The gradient check reported a 20% error on conv1's bias while every
   other tensor matched to seven digits.** That was an artefact of the check,
   not the gradient: the preprocessed icons are sparse, biases initialise at
   zero, so a great many pre-activations sit exactly on the ReLU kink, where
   a bias nudge moves all of them across at once and central differencing
   picks up a one-sided term the analytic gradient correctly omits. The check
   now runs in float64 on dense random input with nonzero biases.

A third fix came out of the preprocessing rather than the model: crops taken
from real pages often clip the button's own border, which lands as a
saturated line along one edge and drags the glyph bounding box out to the
crop boundary. `icon_preprocess.py` trims saturated edge rows and columns
before measuring the box — this was measurably the largest single source of
error in the first version.

## Keeping the JS port honest

`verify-js-parity.js` is not optional. The model is trained against the
Python preprocessing, so any drift in the JavaScript reimplementation — a
rounding rule, a resize convention, the order of the edge-trim loop —
silently degrades accuracy in the browser while every unit test still
passes. The parity fixture records Python's own preprocessed vectors and
logits for fourteen samples; the JS port must reproduce them. Current
agreement: preprocessing within 1.5e-6, logits within 3.0e-5, 14/14
predictions identical.

Python's `round()` is round-half-to-even and JavaScript's `Math.round` is
half-up. `utils/iconClassifier.js` implements banker's rounding explicitly
for this reason.
