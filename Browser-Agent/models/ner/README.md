# NER model weights (vendored)

`model_quantized.onnx` in this folder is `gravitee-io/bert-small-pii-detection`'s
published `model.quant.onnx` (fetched from Hugging Face once this account's
network egress allowlist was opened to it — see `docs/IMPLEMENTATION.md`'s
"Known gaps" history for why it wasn't vendored earlier), renamed to match
the exact filename `offscreen.js`'s `runNerOnText()` fetches
(`MODEL_DIR + MODEL_FILE`, i.e. `models/ner/model_quantized.onnx`). No
conversion was needed — Gravitee already publishes a pre-quantized ONNX
export directly, so nothing here was re-exported or re-quantized.

**NER-based PII detection is live**: `content/piiDetector.js`'s NER pass now
gets real entity spans back from `offscreen.js` instead of failing closed.
This adds coverage for freeform names, locations, and organizations that
don't match any of the deterministic regex/checksum patterns (Luhn,
Verhoeff, ISO 7064, ICAO 9303, GB 11643-1999, etc. — see `docs/PRIVACY.md`);
that structured layer was never affected by this gap and does the bulk of
the redaction work either way.

## Why this exact model — not just a same-shaped one

This folder's `config.json`/`tokenizer.json` were not generic placeholders —
they turned out to be **byte-for-byte identical** to
`gravitee-io/bert-small-pii-detection`'s own `config.json` (`id2label` and
`label2id`, all 51 entries, confirmed via a direct dict comparison) and to
its tokenizer's vocabulary (all 30,522 WordPiece entries, same ids —
`tokenizer.json`'s surrounding metadata differs cosmetically by
`tokenizers`-library version, but `model.vocab` matches exactly). In other
words: this is not "a model with a compatible schema," it's the literal
source model this repo's config/tokenizer files were originally taken from.
`hidden_size: 512` matches `prajjwal1/bert-small` (a well-known small BERT
variant, not a typo for the usual 768), `architectures: ["BertForTokenClassification"]`
matches, and the model was trained specifically on
[`gravitee-io/pii-detection-dataset`](https://huggingface.co/datasets/gravitee-io/pii-detection-dataset)
against exactly this label set.

Two ONNX-converted mirrors of the same base model
(`rtrigoso/bert-small-pii-detection-ONNX`, `onnx-community/bert-small-pii-detection-ONNX`)
were found and checked first, and rejected: both are missing the
`HONORIFIC` category (49 labels instead of 51), which would have silently
shifted every label index above it. Going to the original `gravitee-io`
repo instead, which ships `model.quant.onnx` directly, avoided that
mismatch entirely.

## Real ONNX Runtime verification performed here

Structural check, via a real `onnxruntime.InferenceSession` (not just
reading `config.json`):

- Inputs: `input_ids`, `attention_mask` (both `int64`, `[batch, sequence]`)
  — matches exactly what `offscreen.js`'s `buildModelInputs()` /
  `inputNames.includes(...)` gating already produces (no `token_type_ids`
  in this model's inputs, and the code already skips it when absent).
- Output: `logits`, shape `[batch, sequence, 51]` — the `51` matches this
  folder's `config.json` `id2label` length exactly, confirming the
  classifier head lines up with the label table the rest of the pipeline
  reads.

**Full end-to-end pipeline verification** (not just shape-checking): the
real, unmodified `offscreen.js` functions —
`basicTokenizeWithOffsets`, `wordpieceTokenizeWithOffsets`,
`tokenizeWithOffsets`, `buildModelInputs`, `parseEntityLabel`,
`normalizeEntityType`, `calculateConfidence`, and `runNerOnText()` itself —
were extracted verbatim and run in Node against this real vendored model
(inference bridged to Python's real `onnxruntime`, same cross-language
harness pattern used for the PP-OCR verification in `models/ocr/README.md`)
on several synthetic PII-bearing sentences. Results:

- Correctly detected, at high confidence (0.87-0.96): email addresses,
  phone numbers, a US SSN, a credit card number, an organization name, and
  locations.
- Correctly detected PERSON names in most phrasings (0.88-0.98 confidence,
  e.g. "My name is Michael Brown", "Sarah Williams", "Robert Taylor") —
  though as two adjacent same-type spans rather than one merged span in
  some cases (the model predicts `B-PERSON` for both the first and last
  name instead of `B-`/`I-`), which doesn't affect redaction correctness
  since both tokens still each get flagged as `NAME`.
- In two harder sentences ("Contact John Smith at...", "Dr. Alice Johnson
  from...") some PERSON tokens scored just below the pipeline's 0.85
  confidence threshold (as low as 0.57-0.79) and were dropped by the
  existing confidence-gating logic in `runNerOnText()` (`accepted:
  confidence >= NER_CONFIDENCE_THRESHOLD`) — a real, disclosable limitation
  of this specific small model (512-hidden BERT-small, chosen for
  browser-extension size/speed, not the largest PII model available), not
  a vendoring defect. The structured-PII regex/checksum layer in
  `content/piiDetector.js` is unaffected by this and does not depend on
  NER for any of the entity types it already validates deterministically.
- A clean non-PII sentence ("The quick brown fox...") produced one
  low-confidence false positive (`brown` tagged `NAME` at 0.868) — an
  expected small-model false-positive rate, not a pipeline bug; redaction
  erring toward over-redaction here is the safer failure direction for a
  privacy tool.

What this verification could **not** cover: real photographed/scanned
documents (these were synthetic sentences, not real-world text with OCR
noise), and actual browser WASM execution vs. this Python-`onnxruntime`
check (see `docs/TESTING.md` — same residual gap noted for PP-OCR and
WebLLM: no real browser was available wherever this vendoring pass itself
was performed).

## Updating the vendored weights later

```bash
curl -sSL -o models/ner/model_quantized.onnx \
  "https://huggingface.co/gravitee-io/bert-small-pii-detection/resolve/main/model.quant.onnx"
```

If sourcing a different checkpoint instead, re-verify `config.json`'s
`id2label`/`label2id` and `tokenizer.json`'s vocabulary still match before
replacing them — a close-but-different label set or vocabulary will
silently mislabel entities rather than failing loudly, since
`offscreen.js` reads whatever `config.json` says at runtime.

## Reload check

Reload the unpacked extension. Check the offscreen document's console
(`chrome://extensions` → this extension → "service worker" / inspect views
→ the offscreen document) for `[offscreen] NER confidence threshold: 85%`
at startup with no accompanying fetch error for `model_quantized.onnx` —
that confirms the model loaded. (The in-code comment next to the threshold
check says "Anything below 80% is ignored" — a pre-existing, harmless
mismatch with the real `0.85` constant it sits next to; noted here since it
was seen during this verification pass, not introduced by it.)
