#!/usr/bin/env node
/**
 * utils/i18n/build-language-packs.js
 *
 * Validates every language pack in utils/i18n/packs/*.json against
 * schema.json, then regenerates utils/i18nLabels.js from them.
 *
 * This is the concrete mechanism behind Pillar 6 of the v07 system
 * design: "adding a language is a data contribution, not a code change."
 * Contributing a new language is:
 *
 *   1. Copy utils/i18n/packs/hi-IN.json to utils/i18n/packs/<bcp47-tag>.json
 *   2. Translate every field, keeping the same key structure.
 *   3. Run:  node utils/i18n/build-language-packs.js
 *   4. Commit the new pack file AND the regenerated utils/i18nLabels.js.
 *
 * No JavaScript knowledge, and no change to any other file, is required
 * to add a language. Zero third-party dependencies on purpose (no ajv,
 * no zod) — this is a schema-validated but fully self-contained Node
 * script, so contributing a language never requires `npm install`.
 *
 * utils/i18nLabels.js is a generated artifact. Don't hand-edit it —
 * edit the packs and re-run this script instead; the header comment in
 * the generated file says the same thing.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PACKS_DIR = path.join(HERE, 'packs');
const SCHEMA_PATH = path.join(HERE, 'schema.json');
const OUTPUT_PATH = path.join(HERE, '..', 'i18nLabels.js');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Hand-rolled validator against schema.json's contract. Deliberately not
 * a general-purpose JSON Schema engine — it only needs to check the one
 * shape a language pack must have, and doing that in ~30 lines means this
 * tool has no install step at all.
 */
function validatePack(pack, schema, fileName) {
  const errors = [];

  for (const metaKey of schema.requiredMeta) {
    if (typeof pack[metaKey] !== 'string' || pack[metaKey].trim() === '') {
      errors.push(`${fileName}: missing or empty required meta field "${metaKey}"`);
    }
  }

  if (!pack.entries || typeof pack.entries !== 'object') {
    errors.push(`${fileName}: missing "entries" object`);
    return errors; // nothing further to check
  }

  for (const key of schema.requiredFieldKeys) {
    const entry = pack.entries[key];
    if (!entry || typeof entry !== 'object') {
      errors.push(`${fileName}: entries.${key} is missing`);
      continue;
    }
    for (const field of schema.requiredEntryFields) {
      const val = entry[field];
      if (typeof val !== 'string' || val.trim() === '') {
        errors.push(`${fileName}: entries.${key}.${field} is missing or empty`);
      }
    }
  }

  // BCP-47-ish sanity check (language[-region]), not a full RFC 5646 parse.
  if (pack.langTag && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(pack.langTag)) {
    errors.push(`${fileName}: langTag "${pack.langTag}" doesn't look like a BCP-47 tag (expected e.g. "hi-IN")`);
  }

  return errors;
}

function jsStringLiteral(str) {
  return JSON.stringify(str);
}

function generateSource(validPacks) {
  const langEntriesSrc = validPacks
    .map(({ langTag, label, entries }) => {
      const entriesSrc = Object.entries(entries)
        .map(([key, val]) => {
          const fieldsSrc = ['title', 'subtitle', 'desc', 'hint']
            .map((f) => `        ${f}: ${jsStringLiteral(val[f])}`)
            .join(',\n');
          return `      ${key}: {\n${fieldsSrc}\n      }`;
        })
        .join(',\n');
      return `    ${jsStringLiteral(langTag)}: {\n      label: ${jsStringLiteral(label)},\n      table: {\n${entriesSrc}\n      }\n    }`;
    })
    .join(',\n');

  return `/**
 * utils/i18nLabels.js
 *
 * GENERATED FILE — do not hand-edit.
 *
 * Source of truth: utils/i18n/packs/*.json (one file per language, pure
 * data, no code). Regenerate with:
 *
 *   node utils/i18n/build-language-packs.js
 *
 * Adding a language is a data contribution: drop a new pack file that
 * satisfies utils/i18n/schema.json, run the build script, done — no
 * change to this file (or any other .js file) is written by hand. This
 * is the mechanism behind Pillar 6 of the v07 system design doc: the set
 * of supported languages is a growing, swappable config, not a hardcoded
 * assumption about which two languages an Indian user might read.
 *
 * Generated at: ${new Date().toISOString()}
 * Packs included: ${validPacks.map((p) => p.langTag).join(', ')}
 */
(function (root) {
  // Registry of supported languages beyond English (which lives inline
  // in content.js's buildFieldInfo). Keyed by BCP-47 tag used for both
  // the toggle button label and the SpeechSynthesisUtterance.lang.
  const LANGUAGES = {
${langEntriesSrc}
  };

  function getTranslation(langTag, key) {
    const lang = LANGUAGES[langTag];
    if (!lang) return null;
    return lang.table[key] || lang.table.generic || null;
  }

  root.__BA_I18nLabels = {
    LANGUAGES,
    getTranslation,
    // Back-compat direct accessor for the default (Hindi) table.
    getHindi: (key) => getTranslation('hi-IN', key)
  };
})(typeof window !== 'undefined' ? window : self);
`;
}

function main() {
  const schema = loadJson(SCHEMA_PATH);

  if (!fs.existsSync(PACKS_DIR)) {
    console.error(`No packs directory found at ${PACKS_DIR}`);
    process.exit(1);
  }

  const packFiles = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json'));
  if (packFiles.length === 0) {
    console.error('No language packs found in utils/i18n/packs/ — nothing to build.');
    process.exit(1);
  }

  const validPacks = [];
  let hadErrors = false;

  for (const fileName of packFiles) {
    const fullPath = path.join(PACKS_DIR, fileName);
    let pack;
    try {
      pack = loadJson(fullPath);
    } catch (e) {
      console.error(`✗ ${fileName}: invalid JSON — ${e.message}`);
      hadErrors = true;
      continue;
    }

    const errors = validatePack(pack, schema, fileName);
    if (errors.length > 0) {
      hadErrors = true;
      for (const err of errors) console.error(`✗ ${err}`);
      continue;
    }

    console.log(`✓ ${fileName} — valid pack for "${pack.langTag}" (${pack.label})`);
    validPacks.push(pack);
  }

  if (hadErrors) {
    console.error('\nBuild aborted — fix the errors above and re-run. utils/i18nLabels.js was NOT modified.');
    process.exit(1);
  }

  // Deterministic ordering so regenerating without content changes
  // produces a stable diff (Hindi always first, matching the original
  // hand-written file's order, then alphabetical for anything new).
  validPacks.sort((a, b) => {
    if (a.langTag === 'hi-IN') return -1;
    if (b.langTag === 'hi-IN') return 1;
    return a.langTag.localeCompare(b.langTag);
  });

  const source = generateSource(validPacks);
  fs.writeFileSync(OUTPUT_PATH, source, 'utf8');
  console.log(`\nWrote ${path.relative(process.cwd(), OUTPUT_PATH)} from ${validPacks.length} valid pack(s).`);
}

main();
