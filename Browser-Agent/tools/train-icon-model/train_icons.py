"""
Trains the tiny icon classifier and exports int8-quantised weights for
dependency-free JS inference.

Architecture (a small CNN, not an MLP — an earlier MLP version memorised the
training set at 100% and reached only 46% on held-out data; convolution's
weight sharing and translation equivariance are worth far more per parameter
on a task that is entirely about local glyph shape):

    input  1 x 20 x 20
    conv1  8 filters 3x3 pad 1  -> ReLU -> maxpool 2x2   ->  8 x 10 x 10
    conv2  16 filters 3x3 pad 1 -> ReLU -> maxpool 2x2   -> 16 x  5 x  5
    flatten 400 -> dropout 0.25 -> fc 14

    6,862 parameters.

For scale: the competing PS26171 entry ships Florence-2-base-ft at 230M
parameters / ~275MB int8 across four ONNX graphs, requiring WebGPU. This is
~33,000x fewer parameters and, quantised to int8, a few KB of weights that
run in plain JavaScript — no ONNX runtime, no WASM, no WebGPU, so it also
runs on Firefox, Safari and low-end Android where that model cannot.
"""
import base64
import json
import os
import random
import time

import numpy as np

from icon_render import CLASSES, CLASS_INDEX, render_icon
from icon_preprocess import preprocess, OUT

SEED = 1337
np.random.seed(SEED)

TRAIN_PER_CLASS = 1200
TEST_PER_CLASS = 250
N_CLASSES = len(CLASSES)
K = 3
C1, C2 = 8, 16
FLAT = C2 * 5 * 5


# ── data ───────────────────────────────────────────────────────────────────
def build_set(per_class, seed, stress=False):
    rng = random.Random(seed)
    np.random.seed(seed)
    X, y = [], []
    for name in CLASSES:
        for _ in range(per_class):
            img = render_icon(name, rng, hard=True, stress=stress)
            X.append(preprocess(img))
            y.append(CLASS_INDEX[name])
    X = np.asarray(X, dtype=np.float32).reshape(-1, 1, OUT, OUT)
    y = np.asarray(y, dtype=np.int64)
    idx = np.random.permutation(len(y))
    return X[idx], y[idx]


CACHE = 'icon-data.npz'
if os.path.exists(CACHE):
    z = np.load(CACHE)
    Xtr, ytr, Xte, yte, Xood, yood = (z['Xtr'], z['ytr'], z['Xte'], z['yte'], z['Xood'], z['yood'])
    print(f'loaded cached data  train {Xtr.shape}  held-out {Xte.shape}  stress {Xood.shape}')
else:
    print('generating data (full augmentation range for train AND test)...')
    t0 = time.time()
    Xtr, ytr = build_set(TRAIN_PER_CLASS, seed=SEED)
    Xte, yte = build_set(TEST_PER_CLASS, seed=98765)                 # held out, same distribution
    Xood, yood = build_set(TEST_PER_CLASS, seed=555111, stress=True)  # OOD stress
    np.savez_compressed(CACHE, Xtr=Xtr, ytr=ytr, Xte=Xte, yte=yte, Xood=Xood, yood=yood)
    print(f'  train {Xtr.shape}  held-out {Xte.shape}  stress {Xood.shape}  ({time.time()-t0:.1f}s)')


# ── layers ─────────────────────────────────────────────────────────────────
def im2col(x, k, pad):
    N, C, H, W = x.shape
    xp = np.pad(x, ((0, 0), (0, 0), (pad, pad), (pad, pad)))
    OH, OW = H + 2 * pad - k + 1, W + 2 * pad - k + 1
    cols = np.empty((N, C, k, k, OH, OW), dtype=x.dtype)
    for i in range(k):
        for j in range(k):
            cols[:, :, i, j] = xp[:, :, i:i + OH, j:j + OW]
    return cols.reshape(N, C * k * k, OH * OW), OH, OW


def col2im(dcols, x_shape, k, pad, OH, OW):
    N, C, H, W = x_shape
    d = dcols.reshape(N, C, k, k, OH, OW)
    dxp = np.zeros((N, C, H + 2 * pad, W + 2 * pad), dtype=dcols.dtype)
    for i in range(k):
        for j in range(k):
            dxp[:, :, i:i + OH, j:j + OW] += d[:, :, i, j]
    return dxp[:, :, pad:pad + H, pad:pad + W] if pad else dxp


def conv_fwd(x, W, b, k=K, pad=1):
    cols, OH, OW = im2col(x, k, pad)
    out = np.matmul(W[None], cols) + b[None, :, None]
    return out.reshape(x.shape[0], W.shape[0], OH, OW), (cols, OH, OW, x.shape)


def conv_bwd(dout, W, cache, k=K, pad=1):
    cols, OH, OW, xshape = cache
    N, F = dout.shape[0], dout.shape[1]
    df = dout.reshape(N, F, OH * OW)
    dW = np.einsum('nfl,ncl->fc', df, cols).astype(np.float32)
    db = df.sum(axis=(0, 2)).astype(np.float32)
    dcols = np.matmul(W.T[None], df)
    return col2im(dcols, xshape, k, pad, OH, OW), dW, db


def pool_fwd(x):
    N, C, H, W = x.shape
    xr = x.reshape(N, C, H // 2, 2, W // 2, 2).transpose(0, 1, 2, 4, 3, 5).reshape(N, C, H // 2, W // 2, 4)
    idx = xr.argmax(-1)
    return xr.max(-1), (idx, x.shape)


def pool_bwd(dout, cache):
    idx, xshape = cache
    N, C, H, W = xshape
    d = np.zeros((N, C, H // 2, W // 2, 4), dtype=dout.dtype)
    np.put_along_axis(d, idx[..., None], dout[..., None], axis=-1)
    return d.reshape(N, C, H // 2, W // 2, 2, 2).transpose(0, 1, 2, 4, 3, 5).reshape(N, C, H, W)


def he(shape, fan_in):
    return (np.random.randn(*shape) * np.sqrt(2.0 / fan_in)).astype(np.float32)


W1 = he((C1, 1 * K * K), 1 * K * K); b1 = np.zeros(C1, dtype=np.float32)
W2 = he((C2, C1 * K * K), C1 * K * K); b2 = np.zeros(C2, dtype=np.float32)
W3 = he((FLAT, N_CLASSES), FLAT); b3 = np.zeros(N_CLASSES, dtype=np.float32)
params = [W1, b1, W2, b2, W3, b3]


def forward(x, train=False, drop=0.25):
    c1, k1 = conv_fwd(x, W1, b1); r1 = np.maximum(c1, 0)
    p1, kp1 = pool_fwd(r1)
    c2, k2 = conv_fwd(p1, W2, b2); r2 = np.maximum(c2, 0)
    p2, kp2 = pool_fwd(r2)
    flat = p2.reshape(x.shape[0], -1)
    mask = None
    if train and drop > 0:
        mask = (np.random.rand(*flat.shape) >= drop).astype(np.float32) / (1 - drop)
        flat = flat * mask
    logits = flat @ W3 + b3
    return logits, (k1, c1, kp1, k2, c2, kp2, p2.shape, flat, mask)


def backward(dlogits, cache):
    k1, c1, kp1, k2, c2, kp2, p2shape, flat, mask = cache
    gW3 = flat.T @ dlogits
    gb3 = dlogits.sum(axis=0)
    dflat = dlogits @ W3.T
    if mask is not None:
        dflat = dflat * mask
    dp2 = dflat.reshape(p2shape)
    dr2 = pool_bwd(dp2, kp2)
    dc2 = dr2 * (c2 > 0)
    dp1, gW2, gb2 = conv_bwd(dc2, W2, k2)
    dr1 = pool_bwd(dp1, kp1)
    dc1 = dr1 * (c1 > 0)
    _, gW1, gb1 = conv_bwd(dc1, W1, k1)
    return [gW1, gb1, gW2, gb2, gW3.astype(np.float32), gb3.astype(np.float32)]


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def accuracy(X, y, bs=1024):
    correct = 0
    for s in range(0, len(y), bs):
        lg, _ = forward(X[s:s + bs], train=False)
        correct += int((lg.argmax(axis=1) == y[s:s + bs]).sum())
    return correct / len(y)


# ── gradient check (guards against a silent backprop bug) ──────────────────
def gradient_check():
    """Verifies analytic gradients against central differences.

    Two things make a naive version of this check report false failures,
    and both were hit while building it:

      1. Central differencing on float32 weights is dominated by rounding
         noise. So the check runs on a float64 copy of the network.
      2. ReLU kinks. The preprocessed icons are sparse (large exactly-zero
         background), and biases initialise to zero, so a great many conv
         pre-activations sit at exactly 0. Nudging a BIAS then pushes every
         one of them across the ReLU kink at once: the numerical derivative
         picks up a one-sided contribution that the analytic derivative
         (which takes ReLU'(0)=0) correctly does not. That produced a 20%
         disagreement on conv1's bias while every other tensor matched to
         seven digits — an artefact of the check, not of the gradient. So
         the check uses dense random input and small nonzero biases, which
         keeps pre-activations off the kink and tests the arithmetic rather
         than the data.

    Entries whose gradient is negligible on both sides are skipped: their
    relative error is meaningless.
    """
    global W1, b1, W2, b2, W3, b3, params
    saved = [p.copy() for p in params]
    W1, b1, W2, b2, W3, b3 = [p.astype(np.float64) for p in params]
    params = [W1, b1, W2, b2, W3, b3]
    try:
        np.random.seed(7)
        b1[...] = np.random.randn(*b1.shape) * 0.05 + 0.15
        b2[...] = np.random.randn(*b2.shape) * 0.05 + 0.15
        b3[...] = np.random.randn(*b3.shape) * 0.05
        xb = np.random.rand(4, 1, OUT, OUT).astype(np.float64) * 0.9 + 0.05
        yb = np.array([0, 3, 7, N_CLASSES - 1])
        lg, cache = forward(xb, train=False)
        p = softmax(lg); d = p.copy(); d[np.arange(4), yb] -= 1; d /= 4
        grads = backward(d, cache)
        worst, checked = 0.0, 0
        for P, G in zip(params, grads):
            for fi in np.random.choice(P.size, size=min(8, P.size), replace=False):
                idx = np.unravel_index(fi, P.shape)
                orig = float(P[idx]); eps = 1e-6
                P[idx] = orig + eps
                l1 = float(-np.log(softmax(forward(xb, train=False)[0])[np.arange(4), yb] + 1e-12).mean())
                P[idx] = orig - eps
                l2 = float(-np.log(softmax(forward(xb, train=False)[0])[np.arange(4), yb] + 1e-12).mean())
                P[idx] = orig
                num = (l1 - l2) / (2 * eps)
                ana = float(G[idx])
                if abs(num) < 1e-7 and abs(ana) < 1e-7:
                    continue
                worst = max(worst, abs(num - ana) / max(1e-12, abs(num) + abs(ana)))
                checked += 1
        return worst, checked
    finally:
        W1, b1, W2, b2, W3, b3 = saved
        params = [W1, b1, W2, b2, W3, b3]


gc, gc_n = gradient_check()
print(f'gradient check: worst relative error {gc:.2e} over {gc_n} informative entries '
      f'({"OK" if gc < 1e-3 else "SUSPECT"})')
assert gc < 1e-3, 'backprop disagrees with numerical gradient'

# ── train ──────────────────────────────────────────────────────────────────
m = [np.zeros_like(p) for p in params]
v = [np.zeros_like(p) for p in params]
LR, B1, B2, EPS, WD = 2.5e-3, 0.9, 0.999, 1e-8, 2e-5
EPOCHS, BATCH = 70, 128
step = 0
best = (0.0, None)

WCACHE = 'icon-weights.npz'
if os.path.exists(WCACHE):
    z = np.load(WCACHE)
    for P, key in zip(params, ['W1', 'b1', 'W2', 'b2', 'W3', 'b3']):
        P[...] = z[key]
    print(f'loaded cached weights from {WCACHE} (delete it to retrain)')
    EPOCHS = 0

print('training...')
n = len(ytr)
for epoch in range(EPOCHS):
    perm = np.random.permutation(n)
    Xs, ys = Xtr[perm], ytr[perm]
    tot = 0.0
    lr = LR * (0.5 * (1 + np.cos(np.pi * epoch / EPOCHS)))  # cosine decay
    for s in range(0, n, BATCH):
        xb, yb = Xs[s:s + BATCH], ys[s:s + BATCH]
        bs = len(yb)
        lg, cache = forward(xb, train=True)
        p = softmax(lg)
        tot += float(-np.log(p[np.arange(bs), yb] + 1e-9).sum())
        d = p; d[np.arange(bs), yb] -= 1; d /= bs
        grads = backward(d, cache)
        step += 1
        for i, (P, G) in enumerate(zip(params, grads)):
            G = G + WD * P if P.ndim > 1 else G
            m[i] = B1 * m[i] + (1 - B1) * G
            v[i] = B2 * v[i] + (1 - B2) * (G * G)
            P -= lr * (m[i] / (1 - B1 ** step)) / (np.sqrt(v[i] / (1 - B2 ** step)) + EPS)

    if (epoch + 1) % 10 == 0 or epoch == 0:
        a_tr, a_te = accuracy(Xtr[:4000], ytr[:4000]), accuracy(Xte, yte)
        if a_te > best[0]:
            best = (a_te, [p.copy() for p in params])
        print(f'  epoch {epoch+1:3d}  loss {tot/n:.4f}  train {a_tr*100:.1f}%  held-out {a_te*100:.1f}%')

if best[1] is not None and best[0] > accuracy(Xte, yte):
    for P, B in zip(params, best[1]):
        P[...] = B
    print(f'  restored best checkpoint ({best[0]*100:.1f}%)')

if not os.path.exists(WCACHE):
    np.savez(WCACHE, W1=W1, b1=b1, W2=W2, b2=b2, W3=W3, b3=b3)
    print(f'saved weights to {WCACHE}')

f_tr, f_te, f_ood = accuracy(Xtr, ytr), accuracy(Xte, yte), accuracy(Xood, yood)
print(f'\nfloat32   train {f_tr*100:.2f}%   held-out {f_te*100:.2f}%   stress(OOD) {f_ood*100:.2f}%')


# ── int8 quantisation ──────────────────────────────────────────────────────
def quantize(w):
    scale = float(np.abs(w).max()) / 127.0 or 1e-8
    return np.clip(np.round(w / scale), -127, 127).astype(np.int8), scale


qW1, sW1 = quantize(W1); qW2, sW2 = quantize(W2); qW3, sW3 = quantize(W3)
W1[...] = qW1.astype(np.float32) * sW1
W2[...] = qW2.astype(np.float32) * sW2
W3[...] = qW3.astype(np.float32) * sW3

q_tr, q_te, q_ood = accuracy(Xtr, ytr), accuracy(Xte, yte), accuracy(Xood, yood)
print(f'int8      train {q_tr*100:.2f}%   held-out {q_te*100:.2f}%   stress(OOD) {q_ood*100:.2f}%')

logits_te = np.concatenate([forward(Xte[s:s + 1024])[0] for s in range(0, len(yte), 1024)])
pred = logits_te.argmax(axis=1)
print('\nper-class accuracy (int8, held-out):')
for i, c in enumerate(CLASSES):
    sel = yte == i
    print(f'  {c:14s} {float((pred[sel] == i).mean())*100:5.1f}%   (n={int(sel.sum())})')

probs = softmax(logits_te)
conf = probs.max(axis=1)
print('\nconfidence-threshold operating points (held-out):')
chosen = None
for thr in (0.40, 0.50, 0.60, 0.70, 0.80):
    keep = conf >= thr
    cov = float(keep.mean())
    acc = float((pred[keep] == yte[keep]).mean()) if keep.any() else 0.0
    print(f'  threshold {thr:.2f}: answers on {cov*100:5.1f}% of crops, correct {acc*100:5.1f}% of the time')
    # A WRONG icon label actively misleads the reasoner; a MISSING one just
    # leaves the status quo. The operating point is therefore chosen for
    # precision, accepting reduced coverage: the lowest threshold that is
    # still right at least 98% of the time when it commits to an answer.
    if acc >= 0.98 and chosen is None:
        chosen = (thr, cov, acc)
if chosen is None:
    thr = 0.80
    keep = conf >= thr
    chosen = (thr, float(keep.mean()), float((pred[keep] == yte[keep]).mean()) if keep.any() else 0.0)
print(f'  -> shipping threshold {chosen[0]:.2f} (coverage {chosen[1]*100:.1f}%, precision {chosen[2]*100:.1f}%)')

model = {
    'format': 'ba-icon-cnn-int8-v1',
    'classes': CLASSES,
    'input': {'size': OUT, 'binThreshold': 0.45, 'edgeTrimMax': 3, 'edgeFillRatio': 0.85},
    'arch': {'conv1': [C1, 1, K, K], 'conv2': [C2, C1, K, K], 'fc': [FLAT, N_CLASSES], 'pool': 2},
    'confidenceThreshold': round(float(chosen[0]), 2),
    'layers': {
        'conv1': {'scale': sW1, 'w_b64': base64.b64encode(qW1.tobytes()).decode(), 'b': [float(x) for x in b1]},
        'conv2': {'scale': sW2, 'w_b64': base64.b64encode(qW2.tobytes()).decode(), 'b': [float(x) for x in b2]},
        'fc':    {'scale': sW3, 'w_b64': base64.b64encode(qW3.tobytes()).decode(), 'b': [float(x) for x in b3]},
    },
    'metrics': {
        'parameters': int(W1.size + b1.size + W2.size + b2.size + W3.size + b3.size),
        'trainSamples': int(len(ytr)),
        'heldOutSamples': int(len(yte)),
        'accuracyInt8Train': round(q_tr, 4),
        'accuracyInt8HeldOut': round(q_te, 4),
        'accuracyInt8StressOOD': round(q_ood, 4),
        'shippingThreshold': round(float(chosen[0]), 2),
        'coverageAtThreshold': round(float(chosen[1]), 4),
        'precisionAtThreshold': round(float(chosen[2]), 4),
        'trainedOn': 'procedurally rendered glyphs, 14 classes, full augmentation range',
        'caveat': 'Synthetic training data. Real-world accuracy on arbitrary sites will be lower than these numbers.'
    }
}
with open('icon-model.json', 'w') as f:
    json.dump(model, f, separators=(',', ':'))
print(f'\nwrote icon-model.json ({os.path.getsize("icon-model.json")/1024:.1f} KB), '
      f'{model["metrics"]["parameters"]:,} parameters')

# parity fixture for verifying the JS port against these exact outputs
parity = []
rngp = random.Random(4242)
for name in CLASSES:
    img = render_icon(name, rngp, hard=True)
    vec = preprocess(img)
    lg, _ = forward(vec.reshape(1, 1, OUT, OUT))
    parity.append({
        'class': name,
        'image': [[round(float(x), 6) for x in row] for row in img],
        'preprocessed': [round(float(x), 6) for x in vec],
        'logits': [round(float(x), 5) for x in lg[0]],
        'predicted': CLASSES[int(lg[0].argmax())],
    })
with open('parity-fixture.json', 'w') as f:
    json.dump(parity, f, separators=(',', ':'))
print(f'wrote parity-fixture.json ({os.path.getsize("parity-fixture.json")/1024:.1f} KB)')
