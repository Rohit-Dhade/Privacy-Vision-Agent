# Vendoring the NER model weights (required for NER-based PII detection)

This folder ships `tokenizer.json`, `tokenizer_config.json`, and `config.json` for a `BertForTokenClassification` model (`hidden_size: 512`, 51 labels covering `PERSON, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, LOCATION, ORGANIZATION, US_SSN, US_PASSPORT, US_DRIVER_LICENSE, US_BANK_NUMBER, US_ITIN, US_LICENSE_PLATE, IMEI, MAC_ADDRESS, COORDINATE, NRP, HONORIFIC, TITLE, AGE, DATE_TIME, URL, PASSWORD, FINANCIAL` — see `config.json`'s `id2label` for the full BIO-tagged list). **The actual model weights file, `model_quantized.onnx`, is not present in this folder** — `offscreen.js`'s `runNerOnText()` (`MODEL_DIR + MODEL_FILE`, i.e. `models/ner/model_quantized.onnx`) fetches it by that exact name and there is nothing here to find. This was discovered while writing `docs/IMPLEMENTATION.md`; it had not been previously documented anywhere in this repo.

**This is a one-time manual step.** Nothing else in this feature requires it — if you skip this step, `content/piiDetector.js`'s NER pass fails closed exactly the way it's designed to (`runNerOnText()` treats a failed/missing response as "no NER spans found," identical to how it degrades if the offscreen document itself is unavailable). The deterministic regex + checksum layer in `content/piiDetector.js` (Luhn, Verhoeff, ISO 7064, ICAO 9303, GB 11643-1999, and the rest of the multi-jurisdiction pack — see `docs/PRIVACY.md`) is completely unaffected and does the actual redaction work either way. NER would only add coverage for freeform names, locations, and organizations that don't match any of those structured patterns.

## Steps

1. This repo's `config.json`/`tokenizer.json` describe the exact model shape needed — any `BertForTokenClassification` checkpoint trained against this same 51-label BIO schema will work as a drop-in replacement, quantized and exported to ONNX. If you already have (or trained) such a checkpoint, export it with Hugging Face's `optimum` CLI, from a machine with network access (not inside a restricted sandbox):

   ```bash
   pip install optimum[exporters,onnxruntime]
   optimum-cli export onnx --model <your-checkpoint-path-or-hf-repo-id> --task token-classification --quantize --dtype int8 ./ner-export/
   ```

2. Copy the resulting quantized weights file into this folder as `model_quantized.onnx`, and confirm `config.json`/`tokenizer.json`/`tokenizer_config.json` here still match what you exported (replace them too if your checkpoint's vocab or label order differs — `offscreen.js` reads the label list from `config.json` at runtime via `normalizeEntityType()`'s mapping table, so a different label spelling for the same concept is fine as long as it's added there).

3. If you're sourcing a pre-trained checkpoint rather than training your own, search Hugging Face's model hub for a `token-classification` model whose label set matches the one in this folder's `config.json` — this exact 51-label PII schema (the `B-`/`I-` prefixed set above) is a recognizable, specific search target. Verify the label list matches exactly before exporting; a close-but-different label set will silently mislabel entities rather than failing loudly.

4. Reload the unpacked extension. Check the offscreen document's console (`chrome://extensions` → this extension → "service worker" / inspect views → the offscreen document) for `[offscreen] NER confidence threshold: 85%` at startup with no accompanying fetch error for `model_quantized.onnx` — that confirms the model loaded.

## Why this step can't be automated here

Same restriction documented in `models/ocr/README.md` and `lib/webllm/README.md`: this sandbox's outbound network access does not reach Hugging Face's model hub, `pip`'s package index for `optimum`, or any other host a real export would need. Everything else — the tokenizer loading, WordPiece implementation, BIO-tag decoding, per-token confidence scoring, and the `chrome.runtime` message plumbing connecting `content/piiDetector.js` to this model inside `offscreen.js` — is already written and will start working the moment `model_quantized.onnx` is present here.
