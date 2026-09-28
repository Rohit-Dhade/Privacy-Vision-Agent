/**
 * Verifies the JavaScript port of the icon classifier reproduces the Python
 * training pipeline exactly — preprocessing and forward pass both.
 *
 * This matters more than it might look: the model was trained against the
 * Python preprocessing, so any drift in the JS implementation (a rounding
 * rule, a resize convention, the edge-trim order) silently degrades
 * accuracy in the browser while every unit test still passes. Comparing
 * against Python's own recorded outputs is the only way to catch that.
 */
const fs = require('fs');
const path = require('path');
const UTILS = path.join(__dirname, '..', '..', 'utils');
const IC = require(path.join(UTILS, 'iconClassifier.js'));

const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'icon-model.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity-fixture.json'), 'utf8'));
IC.loadModel(model);

let pass = 0, fail = 0;
const check = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${info}`); }
};

console.log(`\nmodel: ${model.format}  ${model.metrics.parameters} params  ` +
            `threshold ${model.confidenceThreshold}`);
console.log(`held-out ${(model.metrics.accuracyInt8HeldOut * 100).toFixed(1)}%  ` +
            `stress ${(model.metrics.accuracyInt8StressOOD * 100).toFixed(1)}%\n`);

console.log('=== preprocessing parity (JS vs Python) ===');
let worstPre = 0;
for (const sample of fixture) {
  const h = sample.image.length, w = sample.image[0].length;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = sample.image[y][x];

  const js = IC._internals.preprocessGray(gray, w, h);
  let worst = 0;
  for (let i = 0; i < js.length; i++) {
    worst = Math.max(worst, Math.abs(js[i] - sample.preprocessed[i]));
  }
  worstPre = Math.max(worstPre, worst);
  check(`preprocess ${sample.class}`, worst < 1e-5, `max abs diff ${worst.toExponential(2)}`);
}
console.log(`  worst preprocessing difference across all samples: ${worstPre.toExponential(2)}`);

console.log('\n=== forward-pass parity (JS vs Python) ===');
let worstLogit = 0, predMatches = 0;
for (const sample of fixture) {
  const vec = Float32Array.from(sample.preprocessed);
  const logits = IC._internals.forwardFromVector(vec);
  let worst = 0;
  for (let i = 0; i < logits.length; i++) {
    worst = Math.max(worst, Math.abs(logits[i] - sample.logits[i]));
  }
  worstLogit = Math.max(worstLogit, worst);
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  const jsPred = model.classes[best];
  if (jsPred === sample.predicted) predMatches++;
  check(`forward ${sample.class}`, worst < 2e-3 && jsPred === sample.predicted,
    `maxdiff ${worst.toExponential(2)} js=${jsPred} py=${sample.predicted}`);
}
console.log(`  worst logit difference: ${worstLogit.toExponential(2)}`);
console.log(`  prediction agreement: ${predMatches}/${fixture.length}`);

console.log('\n=== end-to-end classifyIcon() on RGBA ImageData ===');
{
  // Rebuild each fixture image as real RGBA ImageData, the way a canvas
  // getImageData() call would hand it over, and check the whole path.
  let agree = 0, answered = 0;
  for (const sample of fixture) {
    const h = sample.image.length, w = sample.image[0].length;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.round(sample.image[y][x] * 255);
        const i = (y * w + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    const res = IC.classifyIcon({ data, width: w, height: h });
    if (res) {
      answered++;
      if (res.label === sample.class) agree++;
    }
  }
  console.log(`  answered on ${answered}/${fixture.length} crops, correct label on ${agree}`);
  check('end-to-end answers on most crops', answered >= fixture.length * 0.7,
    `${answered}/${fixture.length}`);
  check('end-to-end mostly correct when it answers', agree >= answered * 0.7,
    `${agree}/${answered}`);
}

console.log('\n=== guard rails ===');
{
  check('null input => null', IC.classifyIcon(null) === null);
  check('malformed input => null', IC.classifyIcon({ data: null, width: 0, height: 0 }) === null);
  const flat = new Uint8ClampedArray(20 * 20 * 4).fill(255);
  for (let i = 3; i < flat.length; i += 4) flat[i] = 255;
  const res = IC.classifyIcon({ data: flat, width: 20, height: 20 });
  console.log(`  INFO  uniform white crop => ${res ? res.label + ' @' + res.confidence.toFixed(2) : 'null (declined)'}`);
  check('model reports metrics', IC.getMetrics() && IC.getMetrics().parameters === 6862,
    JSON.stringify(IC.getMetrics && IC.getMetrics()));
}

console.log('\n=== inference speed ===');
{
  const vec = Float32Array.from(fixture[0].preprocessed);
  const N = 2000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) IC._internals.forwardFromVector(vec);
  const ms = (Date.now() - t0) / N;
  console.log(`  ${ms.toFixed(3)} ms per classification`);
  check('under 2ms per icon', ms < 2, `${ms.toFixed(3)}ms`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
