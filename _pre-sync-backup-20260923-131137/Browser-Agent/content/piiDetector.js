/**
 * content/piiDetector.js
 *
 * Local rule-based detection (regex + Luhn) PLUS an async NER pass that
 * delegates to an offscreen document running an ONNX model
 * (background/service-worker.js relays 'RUN_NER_INFERENCE' messages to
 * offscreen.js — see offscreen/offscreen.js). The NER inference still
 * never leaves the browser: it runs in the offscreen document, not a
 * remote API.
 */
(function (root) {
  const PATTERNS = {
    EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    // Phone numbers, with two fixes over the obvious pattern, both found by
    // rendering a real redacted screenshot and noticing a number still
    // legible on it:
    //
    //  1. Groups of 3-5 digits, not 3-4. Indian mobile numbers are written
    //     5+5 ("98765 43210") far more often than anything else, and a
    //     3-4/3-4 pattern cannot match that at all — the single most common
    //     phone format in this system's primary jurisdiction was invisible.
    //  2. A negative lookahead instead of a trailing \b. \b cannot match
    //     between two digits, so with a 5-digit final group the regex
    //     backtracked into failure on exactly the numbers it should catch.
    //     (?!\d) refuses a following digit while still allowing end-of-text
    //     or punctuation, which is what was actually meant.
    //
    // This stays deliberately loose, consistent with PHONE's role as the
    // fail-toward-redaction fallback: it runs LAST and skips any range a
    // checksum-validated detector already claimed, so broadening it cannot
    // steal a match from CARD, AADHAAR, IBAN or MRZ.
    PHONE: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}(?!\d)/g,
    CARD: /\b(?:\d[ -]?){13,19}\b/g,
    IPV4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    // UIDAI numbering scheme: 12 digits, first digit never 0 or 1, usually
    // rendered in 4-4-4 groups. Structural match only — verhoeffValidate()
    // below does the real checksum validation before anything is flagged.
    AADHAAR: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    // Income Tax PAN: 5 letters (4th letter is the holder-category code),
    // 4 digits, 1 check letter. The category-letter constraint (vs. a
    // generic \b[A-Z]{5}\d{4}[A-Z]\b) meaningfully cuts false positives
    // from random alphanumeric SKUs/order codes.
    PAN: /\b[A-Za-z]{3}[ABCFGHLJPTabcfghljpt][A-Za-z]\d{4}[A-Za-z]\b/g,
    // Candidate secrets/API keys/tokens: long alnum+symbol runs. Actual
    // classification happens in looksLikeSecret() via Shannon entropy —
    // this regex only narrows down what's worth scoring.
    SECRET_CANDIDATE: /\b[A-Za-z0-9_\-.\/+=]{20,100}\b/g,
    // --- Global region pack (not India-only): every country's bank
    // account number (ISO 13616 IBAN, ~70 countries) and every
    // machine-readable passport (ICAO 9303 MRZ) on Earth uses one of
    // these two publicly standardized checksum schemes. Aadhaar/PAN
    // above are the India-specific pack; these two are jurisdiction-
    // agnostic by design — see ibanValidate()/validateMrzLine2() below.
    IBAN: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    MRZ_LINE2: /\b[A-Z0-9<]{44}\b/g,
    // MRZ line 1 (TD3) carries the holder's SURNAME and GIVEN NAMES, which
    // line 2 does not. Detecting only line 2 therefore redacts a passport's
    // numbers while leaving the person's name in plain sight — a gap found
    // by looking at an actual redacted screenshot (see benchmark/e2e).
    //
    // Note the lookarounds instead of \b: line 1 ends in filler '<'
    // characters, and '<' is not a word character, so a trailing \b can
    // never match after one. The MRZ_LINE2 pattern above gets away with \b
    // only because line 2 ends in a check digit. This is exactly why line 1
    // was silently unmatchable rather than merely unvalidated.
    MRZ_LINE1: /(?<![A-Z0-9<])[A-Z][A-Z<][A-Z]{3}[A-Z<]{39}(?![A-Z0-9<])/g,

    // --- Multi-jurisdiction pack (claude/v25-master-implementation-guide.md
    // Part 3, Task 4.1) — each of these is checksum-validated below unless
    // explicitly noted as format-only (same honesty standard as PAN above:
    // a structural match alone is disclosed as such, never presented as
    // more certain than it is). ---

    // USA SSN: requires the hyphenated grouping (a bare 9-digit run is far
    // too collision-prone with order/tracking numbers to flag on its own);
    // area/group/serial exclusion rules applied in ssnValidate() below.
    SSN: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g,
    // UK National Insurance Number: format-only (no public check digit) —
    // excluded first/second letters and excluded two-letter prefixes per
    // HMRC's published NINO format rules.
    UK_NINO: /\b[A-CEGHJ-PR-TW-Z]{1}[A-CEGHJ-NPR-TW-Z]{1}\d{6}[A-D]\b/g,
    // EU VAT identification number: generic 2-letter country code + up to
    // 12 alphanumerics. Only Germany's is checksum-validated below
    // (ISO 7064 MOD 11-10, per its published spec); every other member
    // state's VAT number matching this shape is still flagged, but
    // disclosed as format-only in confidence (see the detection loop).
    EU_VAT: /\b(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[A-Z0-9]{8,12}\b/g,
    // China Resident Identity Card (18 digits): GB 11643-1999 checksum.
    CHINA_ID: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    // Japan My Number (12-digit Individual Number): official check-digit algorithm.
    JAPAN_MYNUMBER: /\b\d{12}\b/g,
    // Brazil CPF: two check digits per the standard, widely-published algorithm.
    BRAZIL_CPF: /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g,
    // Mexico CURP (18 chars): format-only — the real check digit depends on
    // a name/date derivation this detector cannot reconstruct, so this is
    // disclosed as structural-match-only, same as PAN.
    MEXICO_CURP: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g,
    // Mexico RFC (individuals, 13 chars): format-only.
    MEXICO_RFC: /\b[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}\b/g,
    // Canada SIN (9 digits): Luhn-validated — the same checksum as CARD
    // above, reusing luhnCheck() rather than a second implementation.
    CANADA_SIN: /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g,
    // Australia Tax File Number (9 digits): ATO's published weighted-sum
    // mod-11 check.
    AU_TFN: /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g,
    // Australia Business Number (11 digits): ISO 7064-style weighted-sum
    // mod-89 check per the ABR's published spec.
    AU_ABN: /\b\d{2}[- ]?\d{3}[- ]?\d{3}[- ]?\d{3}\b/g
  };

  const KNOWN_SECRET_PREFIXES = /^(sk-|pk_live_|pk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|AKIA|ASIA|AIza|xox[baprs]-|eyJ[A-Za-z0-9_-]*\.|Bearer\s)/;

  /** Shannon entropy in bits/char — the standard secret-scanner heuristic
   *  (same technique tools like gitleaks/trufflehog use): a real API key
   *  or token is close to uniformly random over its character set, so it
   *  has much higher per-character entropy than English words or IDs. */
  function shannonEntropy(str) {
    const freq = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    const len = str.length;
    let entropy = 0;
    for (const ch in freq) {
      const p = freq[ch] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  function looksLikeSecret(token) {
    if (!token || token.length < 20) return false;
    if (KNOWN_SECRET_PREFIXES.test(token)) return true;
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    const varietyScore = [hasUpper, hasLower, hasDigit].filter(Boolean).length;
    // Needs at least two character classes mixed — rules out things like
    // long all-lowercase slugs or all-digit tracking numbers.
    if (varietyScore < 2) return false;
    const isHexish = /^[A-Fa-f0-9]+$/.test(token);
    // Hex-only strings have a smaller alphabet, so raw Shannon entropy
    // saturates lower even when fully random — use a lower bar for them.
    const threshold = isHexish ? 3.0 : 4.0;
    return shannonEntropy(token) >= threshold;
  }

  // --- Verhoeff checksum (used by UIDAI for Aadhaar check-digit validation) ---
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  /** Validates a 12-digit Aadhaar number's Verhoeff check digit. Rejects
   *  anything that isn't a real checksum-valid 12-digit sequence, so a
   *  random 12-digit number (a phone-like ID, an order number) won't be
   *  misflagged as Aadhaar the way a bare regex would. */
  function verhoeffValidate(numStr) {
    const digits = numStr.split('').reverse();
    let c = 0;
    for (let i = 0; i < digits.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(digits[i], 10)]];
    }
    return c === 0;
  }

  // --- ISO 7064 mod-97-10 checksum (used by every IBAN, ~70 countries) ---
  /** Validates an IBAN's check digits per ISO 13616 / ISO 7064 mod-97-10:
   *  move the first 4 characters to the end, convert letters to numbers
   *  (A=10 ... Z=35), then the whole numeral string mod 97 must equal 1.
   *  Computed digit-by-digit (never building the full big integer) since
   *  a 34-character IBAN's numeric expansion is far larger than a JS
   *  safe integer. This is a real ISO standard, not a heuristic — an IBAN
   *  passing this check is genuinely valid, the same way Luhn-validated
   *  card numbers are. */
  function ibanValidate(iban) {
    const cleaned = iban.toUpperCase().replace(/\s/g, '');
    if (cleaned.length < 15 || cleaned.length > 34) return false;
    const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
      const value = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55) : ch;
      for (const digitChar of String(value)) {
        remainder = (remainder * 10 + Number(digitChar)) % 97;
      }
    }
    return remainder === 1;
  }

  // --- ICAO Document 9303 MRZ check-digit weights (every machine-readable
  // passport on Earth uses this same publicly standardized algorithm) ---
  const MRZ_WEIGHTS = [7, 3, 1];
  function mrzCharValue(ch) {
    if (ch === '<') return 0;
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55; // A=10..Z=35
    return 0;
  }
  /**
   * Length gate for the (deliberately loose) PHONE pattern.
   *
   * Broadening PHONE to catch 5+5 Indian mobile grouping also made it match
   * things like the "2024-88213" inside an order number ORD-2024-88213, and
   * stray digit runs inside a passport MRZ. Both are 9 digits or fewer.
   *
   * Every real dialable number is longer than that: ITU E.164 allows up to
   * 15 digits, national significant numbers run about 9-11, and India's
   * mobile numbers are exactly 10. Requiring 10-15 digits therefore keeps
   * every format the broadened pattern was written for while rejecting the
   * short YYYY-NNNNN shapes that make order numbers and reference codes
   * look phone-like.
   *
   * The cost is that a bare 8-digit local landline is no longer flagged.
   * That is the right trade: an 8-digit run is genuinely ambiguous with
   * identifiers, and redacting every such number on every page would make
   * the agent's own output unreadable for a marginal privacy gain.
   */
  function looksLikePhone(match) {
    const digits = (String(match).match(/\d/g) || []).length;
    return digits >= 10 && digits <= 15;
  }

  function mrzCheckDigit(field) {
    let sum = 0;
    for (let i = 0; i < field.length; i++) {
      sum += mrzCharValue(field[i]) * MRZ_WEIGHTS[i % 3];
    }
    return sum % 10;
  }

  /**
   * Validates a TD3 (passport) MRZ line 1 (44 chars).
   *
   * Line 1 has no check digits — its integrity is structural — so this
   * validates the ICAO 9303 layout instead: a document-type letter, an
   * optional subtype, a three-letter issuing state, and then a name field
   * drawn only from A-Z and the filler character, containing the mandatory
   * double-filler that separates surname from given names.
   *
   * That structure is specific enough to be safe: a 44-character string of
   * capitals and chevrons, beginning with a passport/ID document code and
   * an ISO-3166 style country triple, containing '<<' and padded to exactly
   * 44, is not something that occurs in ordinary page text.
   *
   * Returns only whether it is valid plus the issuing state — never the
   * name, matching the "key names only, never values" rule the rest of
   * this file follows.
   */
  function validateMrzLine1(line1) {
    if (!line1 || line1.length !== 44) return { valid: false };
    if (!/^[A-Z]$/.test(line1[0])) return { valid: false };
    if (!/^[A-Z<]$/.test(line1[1])) return { valid: false };
    const issuingState = line1.slice(2, 5);
    if (!/^[A-Z]{3}$/.test(issuingState)) return { valid: false };
    const nameField = line1.slice(5);
    if (!/^[A-Z<]+$/.test(nameField)) return { valid: false };
    // The surname/given-names separator is mandatory in a TD3 line 1.
    if (!nameField.includes('<<')) return { valid: false };
    // Guard against a run of pure filler being treated as a name.
    const letters = (nameField.match(/[A-Z]/g) || []).length;
    if (letters < 4) return { valid: false };
    // Document type: P is a passport; I, A and C are the ID-card variants.
    if (!'PIAC'.includes(line1[0])) return { valid: false };
    return { valid: true, issuingState, documentType: line1[0] };
  }

  /** Validates a TD3 (passport) MRZ line 2 (44 chars) against its own
   *  embedded check digits: passport-number, birth-date, expiry-date, and
   *  the final composite check over the whole line. Returns only whether
   *  it's valid plus non-identifying metadata (nationality, sex) — the
   *  actual passport number is never extracted or returned, matching the
   *  "key names only, never values" pattern the rest of this file follows. */
  function validateMrzLine2(line2) {
    if (!line2 || line2.length !== 44) return { valid: false };
    const passportNumField = line2.slice(0, 9);
    const passportCheck = line2[9];
    const nationality = line2.slice(10, 13);
    const dobField = line2.slice(13, 19);
    const dobCheck = line2[19];
    const sex = line2[20];
    const expiryField = line2.slice(21, 27);
    const expiryCheck = line2[27];
    const personalNumField = line2.slice(28, 42);
    const personalCheck = line2[42];
    const compositeCheck = line2[43];

    const composite =
      passportNumField + passportCheck +
      dobField + dobCheck +
      expiryField + expiryCheck +
      personalNumField + personalCheck;

    const passportOk = String(mrzCheckDigit(passportNumField)) === passportCheck;
    const dobOk = /^\d{6}$/.test(dobField) && String(mrzCheckDigit(dobField)) === dobCheck;
    const expiryOk = /^\d{6}$/.test(expiryField) && String(mrzCheckDigit(expiryField)) === expiryCheck;
    const compositeOk = String(mrzCheckDigit(composite)) === compositeCheck;
    const nationalityOk = /^[A-Z<]{3}$/.test(nationality);
    const sexOk = sex === 'M' || sex === 'F' || sex === '<';

    return {
      valid: passportOk && dobOk && expiryOk && compositeOk && nationalityOk && sexOk,
      nationality: nationalityOk ? nationality.replace(/</g, '') : null,
      sex: sexOk ? sex : null
    };
  }

  // --- Multi-jurisdiction pack validators (v25 Part 3, Task 4.1) ---

  // USA SSN: area != 000/666/900-999, group != 00, serial != 0000
  // (SSA-published exclusion rules — these are the only publicly known
  // "invalid by construction" ranges; there is no public check digit).
  function ssnValidate(digitsOnly) {
    if (!digitsOnly || digitsOnly.length !== 9) return false;
    const area = parseInt(digitsOnly.slice(0, 3), 10);
    const group = parseInt(digitsOnly.slice(3, 5), 10);
    const serial = parseInt(digitsOnly.slice(5, 9), 10);
    if (area === 0 || area === 666 || area >= 900) return false;
    if (group === 0) return false;
    if (serial === 0) return false;
    return true;
  }

  // UK National Insurance Number: format-only (HMRC has never published a
  // check digit for the NINO) — excluded prefix pairs per the published
  // format rules.
  const UK_NINO_EXCLUDED_PREFIXES = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);
  function ukNinoValidate(match) {
    const prefix = match.slice(0, 2).toUpperCase();
    return !UK_NINO_EXCLUDED_PREFIXES.has(prefix);
  }

  // EU VAT ID: only Germany's is checksum-validated (ISO 7064 MOD 11-10,
  // per its published spec). Every other member state's number matching
  // the generic shape is disclosed as format-only by the caller.
  function euVatValidate(match) {
    const country = match.slice(0, 2).toUpperCase();
    const digits = match.slice(2);
    if (country !== 'DE') return { valid: /^[A-Z0-9]{8,12}$/.test(digits), checksummed: false };
    if (!/^\d{9}$/.test(digits)) return { valid: false, checksummed: true };
    let product = 10;
    for (let i = 0; i < 8; i++) {
      let sum = (parseInt(digits[i], 10) + product) % 10;
      if (sum === 0) sum = 10;
      product = (2 * sum) % 11;
    }
    const checkDigit = (11 - product) % 10;
    return { valid: checkDigit === parseInt(digits[8], 10), checksummed: true };
  }

  // China Resident Identity Card (18 digits): GB 11643-1999 weighted-sum
  // mod-11 checksum, mapped to a check character via the standard table.
  const CHINA_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const CHINA_ID_CHECK_TABLE = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  function chinaIdValidate(match) {
    if (!/^\d{17}[\dXx]$/.test(match)) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += parseInt(match[i], 10) * CHINA_ID_WEIGHTS[i];
    const expected = CHINA_ID_CHECK_TABLE[sum % 11];
    return match[17].toUpperCase() === expected;
  }

  // Japan My Number (12-digit Individual Number): the official check-digit
  // algorithm — Pn = n+1 for n<=6, n-5 for n>6, over the first 11 digits.
  function japanMyNumberValidate(digitsOnly) {
    if (!digitsOnly || digitsOnly.length !== 12) return false;
    let sum = 0;
    for (let n = 1; n <= 11; n++) {
      const digit = parseInt(digitsOnly[n - 1], 10);
      const weight = n <= 6 ? n + 1 : n - 5;
      sum += digit * weight;
    }
    const remainder = sum % 11;
    const checkDigit = remainder <= 1 ? 0 : 11 - remainder;
    return checkDigit === parseInt(digitsOnly[11], 10);
  }

  // Brazil CPF (11 digits): the standard two-check-digit algorithm, plus
  // the well-known guard against all-same-digit sequences (which trivially
  // pass the raw weighted-sum check in naive implementations).
  function brazilCpfValidate(digitsOnly) {
    if (!digitsOnly || digitsOnly.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(digitsOnly)) return false;
    const calcCheck = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += parseInt(digitsOnly[i], 10) * (len + 1 - i);
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    const check1 = calcCheck(9);
    if (check1 !== parseInt(digitsOnly[9], 10)) return false;
    const check2 = calcCheck(10);
    return check2 === parseInt(digitsOnly[10], 10);
  }

  // Mexico CURP (format-only — the real 18th-character check digit is
  // derived from the person's name/birthdate, which this detector cannot
  // reconstruct, so a structural match is disclosed as such, not as a
  // verified checksum) and RFC (format-only, individuals).
  function mexicoCurpValidate(match) {
    return /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(match);
  }
  function mexicoRfcValidate(match) {
    return /^[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}$/.test(match);
  }

  // Australia Tax File Number (9 digits): ATO's published weighted-sum
  // mod-11 check.
  const AU_TFN_WEIGHTS = [10, 7, 8, 4, 6, 3, 5, 2, 1];
  function auTfnValidate(digitsOnly) {
    if (!digitsOnly || digitsOnly.length !== 9) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(digitsOnly[i], 10) * AU_TFN_WEIGHTS[i];
    return sum % 11 === 0;
  }

  // Australia Business Number (11 digits): ISO 7064-style weighted-sum
  // mod-89 check per the ABR's published spec (subtract 1 from the first
  // digit before weighting).
  const AU_ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  function auAbnValidate(digitsOnly) {
    if (!digitsOnly || digitsOnly.length !== 11) return false;
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      const digit = i === 0 ? parseInt(digitsOnly[i], 10) - 1 : parseInt(digitsOnly[i], 10);
      sum += digit * AU_ABN_WEIGHTS[i];
    }
    return sum % 89 === 0;
  }

  const SENSITIVE_QUERY_PARAMS = new Set([
    'token', 'access_token', 'auth', 'password', 'pwd', 'email', 'ssn',
    'api_key', 'apikey', 'key', 'session', 'sid'
  ]);

  const ENTITY_TYPE_MAP = {
    NAME: 'NAME',
    PERSON: 'NAME',
    GIVENNAME: 'NAME',
    FIRSTNAME: 'NAME',
    LASTNAME: 'NAME', 
    SURNAME: 'NAME', 
    MIDDLENAME: 'NAME', 
    EMAIL: 'EMAIL',
    TEL: 'PHONE', 
    PHONE: 'PHONE', 
    PHONENUMBER: 'PHONE', 
    PHONEIMEI: 'PHONE',
    CREDITCARDNUMBER: 'CARD', 
    CREDITCARDCVV: 'CARD', 
    CREDITCARD: 'CARD',
    IP: 'IP_ADDRESS', 
    IPV4: 'IP_ADDRESS', 
    IPV6: 'IP_ADDRESS'
  };

  function normalizeEntityType(rawType) {
    const key = rawType.toUpperCase().replace(/[\s_-]/g, '');
    return ENTITY_TYPE_MAP[key] || rawType.toUpperCase();
  }

  /** Sends text to background service worker -> offscreen document for ONNX NER inference */
  // ── NER round-trip management ───────────────────────────────────────────
  //
  // The NER pass is the single most expensive thing in extraction, and it was
  // being run in the worst possible shape: one message round trip per text
  // node, awaited serially inside the detection loop. Measured on the demo
  // fixture that was 43 round trips for 1409ms — about 33ms each — making it
  // ~97% of a 1.4-second extraction while every other phase was cheap
  // (injection 6ms, screenshot 92ms, face inference 113ms).
  //
  // Worse, the cost was paid even when the model was unavailable: each of the
  // 43 calls failed, and each failure still cost a full relay through the
  // service worker to the offscreen document.
  //
  // Three things fix it, in descending order of effect:
  //
  //   1. A CIRCUIT BREAKER. Once the model reports unavailable, stop asking
  //      for a cooldown period. 43 doomed round trips become 1.
  //   2. ELIGIBILITY. NER finds names, organisations and places. Text with no
  //      letters, or a single short token, cannot contain one, so asking is
  //      pure latency. The checksum-validated detectors already own the
  //      numeric formats.
  //   3. CONCURRENCY. The remaining calls are issued together rather than
  //      awaited one at a time, so their round trips overlap instead of
  //      stacking.
  const NER_COOLDOWN_MS = 60000;
  let nerUnavailableUntil = 0;

  function nerIsCoolingDown() {
    return Date.now() < nerUnavailableUntil;
  }

  function markNerUnavailable(reason) {
    if (!nerIsCoolingDown()) {
      console.warn(`[piiDetector] NER unavailable (${reason}); skipping it for ` +
                   `${NER_COOLDOWN_MS / 1000}s rather than retrying per text node.`);
    }
    nerUnavailableUntil = Date.now() + NER_COOLDOWN_MS;
  }

  /** Could this string plausibly contain a named entity at all? */
  function isNerEligible(text) {
    if (!text || text.length < 4 || text.length > 2000) return false;
    // Needs at least one run of two or more letters; pure digits, currency,
    // punctuation and single characters cannot carry a name.
    if (!/[A-Za-zÀ-ɏऀ-ॿ]{2,}/.test(text)) return false;
    return true;
  }

  async function runNerOnText(text) {
    if (nerIsCoolingDown()) return [];
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_NER_INFERENCE', text }, (response) => {
        if (chrome.runtime.lastError) {
          markNerUnavailable(chrome.runtime.lastError.message);
          return resolve([]);
        }
        if (response && response.ok) {
          resolve(response.spans || []);
        } else {
          markNerUnavailable(response?.error || 'unknown error');
          resolve([]);
        }
      });
    });
  }

  function luhnCheck(digitsOnly) {
    let sum = 0;
    let alt = false;
    for (let i = digitsOnly.length - 1; i >= 0; i--) {
      let d = parseInt(digitsOnly[i], 10);
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function maskValue(type, text) {
    switch (type) {
      case 'EMAIL': {
        const [user, domain] = text.split('@');
        const maskedUser = user.length <= 2 ? '*'.repeat(user.length) : user[0] + '*'.repeat(user.length - 2) + user.slice(-1);
        return `${maskedUser}@${domain}`;
      }
      case 'CARD': {
        const digits = text.replace(/\D/g, '');
        return `**** **** **** ${digits.slice(-4)}`;
      }
      case 'PHONE': {
        const digits = text.replace(/\D/g, '');
        return `${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
      }
      case 'IPV4':
      case 'IP_ADDRESS':
        return text.includes('.')
          ? text.split('.').map((o, i) => (i < 2 ? '*'.repeat(o.length) : o)).join('.')
          : '[REDACTED]';
      case 'NAME':
        return text[0] + '*'.repeat(Math.max(0, text.length - 1));
      case 'AADHAAR': {
        const digits = text.replace(/\D/g, '');
        return `${'*'.repeat(8)} ${digits.slice(-4)}`;
      }
      case 'PAN':
        return `${text.slice(0, 3)}${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-1)}`;
      case 'SECRET_TOKEN':
        return `${text.slice(0, 4)}${'*'.repeat(Math.max(0, text.length - 4))}`;
      case 'IBAN':
        return `${text.slice(0, 4)}${'*'.repeat(Math.max(0, text.length - 8))}${text.slice(-4)}`;
      case 'MRZ_PASSPORT':
        return '[MRZ REDACTED]';
      case 'MRZ_PASSPORT_NAME':
        return '[MRZ NAME REDACTED]';
      case 'SSN': {
        const digits = text.replace(/\D/g, '');
        return `***-**-${digits.slice(-4)}`;
      }
      case 'UK_NINO':
        return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 3))}${text.slice(-1)}`;
      case 'EU_VAT':
        return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 2))}`;
      case 'CHINA_ID': {
        const s = text.replace(/\s/g, '');
        return `${s.slice(0, 6)}${'*'.repeat(Math.max(0, s.length - 10))}${s.slice(-4)}`;
      }
      case 'JAPAN_MYNUMBER': {
        const digits = text.replace(/\D/g, '');
        return `${'*'.repeat(8)}${digits.slice(-4)}`;
      }
      case 'BRAZIL_CPF': {
        const digits = text.replace(/\D/g, '');
        return `***.***.***-${digits.slice(-2)}`;
      }
      case 'MEXICO_CURP':
      case 'MEXICO_RFC':
        return `${text.slice(0, 4)}${'*'.repeat(Math.max(0, text.length - 4))}`;
      case 'CANADA_SIN': {
        const digits = text.replace(/\D/g, '');
        return `***-***-${digits.slice(-3)}`;
      }
      case 'AU_TFN': {
        const digits = text.replace(/\D/g, '');
        return `***-***-${digits.slice(-3)}`;
      }
      case 'AU_ABN': {
        const digits = text.replace(/\D/g, '');
        return `**-***-***-${digits.slice(-3)}`;
      }
      default:
        return '[REDACTED]';
    }
  }

  function bboxForMatch(textNode, index, length, viewportWidth, viewportHeight) {
    try {
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + length);
      const rect = range.getBoundingClientRect();
      range.detach && range.detach();
      if (!root.__BA_Geometry.rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
        return null;
      }
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Tracks character ranges already claimed by a higher-specificity,
   * checksum/format-validated detector (AADHAAR, PAN, IBAN, MRZ, CARD,
   * EMAIL, IP) within one piece of text, so a looser pattern like PHONE
   * — which matches almost any 7-15 digit run — doesn't also fire on a
   * digit substring that's already been correctly, more specifically
   * classified. Found by benchmark/run-benchmark.js: a value correctly
   * flagged as AADHAAR/IBAN/CARD/a secret token was also picking up a
   * spurious extra PHONE label from an overlapping digit run inside the
   * same match, which measurably hurt detection precision without ever
   * improving recall (nothing was ever missed — the field was still
   * flagged and redacted, just under an extra, wrong label too). See
   * benchmark/README.md's "already found a real bug" section.
   */
  function makeRangeClaimTracker() {
    const claimed = [];
    return {
      claim(start, end) { claimed.push([start, end]); },
      overlapsClaimed(start, end) {
        return claimed.some(([s, e]) => start < e && s < end);
      }
    };
  }

  function detectInText(text, type, regex) {
    const matches = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ match: m[0], index: m.index, group: m[1] });
      if (m[0].length === 0) regex.lastIndex++;
    }
    return matches;
  }

  async function detectSensitiveInfo(textNodes, viewportWidth, viewportHeight) {
    const items = [];
    const flaggedNodes = new Set();
    // Nodes worth asking the NER model about; drained after the loop so the
    // round trips overlap instead of serialising. See runNerOnText().
    const nerQueue = [];

    for (const entry of textNodes) {
      const { node, text, elementId } = entry;
      let nodeFlagged = false;
      // See makeRangeClaimTracker()'s comment: every checksum/format-
      // validated detector below claims its matched range so the loose
      // PHONE pattern (last, deliberately) can skip anything already
      // more specifically classified instead of double-labeling it.
      const claims = makeRangeClaimTracker();

      // EMAIL
      for (const { match, index } of detectInText(text, 'EMAIL', PATTERNS.EMAIL)) {
        claims.claim(index, index + match.length);
        const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
        if (bbox) { items.push({ type: 'EMAIL', masked: maskValue('EMAIL', match), confidence: 0.98, bbox, elementId }); nodeFlagged = true; }
      }

      // CARD
      for (const { match, index } of detectInText(text, 'CARD', PATTERNS.CARD)) {
        const digits = match.replace(/[ -]/g, '');
        if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'CARD', masked: maskValue('CARD', digits), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // IPV4
      for (const { match, index } of detectInText(text, 'IPV4', PATTERNS.IPV4)) {
        claims.claim(index, index + match.length);
        const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
        if (bbox) { items.push({ type: 'IP_ADDRESS', masked: maskValue('IPV4', match), confidence: 0.9, bbox, elementId }); nodeFlagged = true; }
      }

      // AADHAAR (Verhoeff-checksum validated, like Luhn for cards above)
      for (const { match, index } of detectInText(text, 'AADHAAR', PATTERNS.AADHAAR)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 12 && verhoeffValidate(digits)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'AADHAAR', masked: maskValue('AADHAAR', digits), confidence: 0.97, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // PAN
      for (const { match, index } of detectInText(text, 'PAN', PATTERNS.PAN)) {
        claims.claim(index, index + match.length);
        const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
        if (bbox) { items.push({ type: 'PAN', masked: maskValue('PAN', match.toUpperCase()), confidence: 0.9, bbox, elementId }); nodeFlagged = true; }
      }

      // High-entropy secrets / API keys / tokens
      for (const { match, index } of detectInText(text, 'SECRET_CANDIDATE', PATTERNS.SECRET_CANDIDATE)) {
        if (looksLikeSecret(match)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'SECRET_TOKEN', masked: maskValue('SECRET_TOKEN', match), confidence: 0.75, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // IBAN (ISO 7064 mod-97 validated — any of ~70 countries)
      for (const { match, index } of detectInText(text, 'IBAN', PATTERNS.IBAN)) {
        if (ibanValidate(match)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'IBAN', masked: maskValue('IBAN', match.toUpperCase()), confidence: 0.96, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Passport MRZ line 2 (ICAO 9303 check-digit validated)
      for (const { match, index } of detectInText(text, 'MRZ_LINE2', PATTERNS.MRZ_LINE2)) {
        if (validateMrzLine2(match).valid) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'MRZ_PASSPORT', masked: maskValue('MRZ_PASSPORT', match), confidence: 0.97, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Passport MRZ line 1 — the holder's NAME. Redacting line 2 alone
      // blacks out the passport number and dates while leaving the surname
      // and given names legible, which is not a redacted passport.
      for (const { match, index } of detectInText(text, 'MRZ_LINE1', PATTERNS.MRZ_LINE1)) {
        if (validateMrzLine1(match).valid && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'MRZ_PASSPORT_NAME', masked: maskValue('MRZ_PASSPORT_NAME', match), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // --- Multi-jurisdiction pack (v25 Part 3, Task 4.1) — same
      // claim-before-PHONE discipline as the block above: each checksum
      // check runs first, and only a validated match claims its range. ---

      // USA SSN
      for (const { match, index } of detectInText(text, 'SSN', PATTERNS.SSN)) {
        const digits = match.replace(/\D/g, '');
        if (ssnValidate(digits)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'SSN', masked: maskValue('SSN', digits), confidence: 0.9, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // UK National Insurance Number (format-only — see ukNinoValidate())
      for (const { match, index } of detectInText(text, 'UK_NINO', PATTERNS.UK_NINO)) {
        if (ukNinoValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'UK_NINO', masked: maskValue('UK_NINO', match.toUpperCase()), confidence: 0.8, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // EU VAT ID (Germany checksum-validated; other member states format-only)
      for (const { match, index } of detectInText(text, 'EU_VAT', PATTERNS.EU_VAT)) {
        const result = euVatValidate(match);
        if (result.valid && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'EU_VAT', masked: maskValue('EU_VAT', match.toUpperCase()), confidence: result.checksummed ? 0.93 : 0.7, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // China Resident ID (GB 11643-1999 checksum-validated)
      for (const { match, index } of detectInText(text, 'CHINA_ID', PATTERNS.CHINA_ID)) {
        if (chinaIdValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'CHINA_ID', masked: maskValue('CHINA_ID', match.toUpperCase()), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Japan My Number (official check-digit validated)
      for (const { match, index } of detectInText(text, 'JAPAN_MYNUMBER', PATTERNS.JAPAN_MYNUMBER)) {
        if (japanMyNumberValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'JAPAN_MYNUMBER', masked: maskValue('JAPAN_MYNUMBER', match), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Brazil CPF (standard two-check-digit algorithm validated)
      for (const { match, index } of detectInText(text, 'BRAZIL_CPF', PATTERNS.BRAZIL_CPF)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 11 && brazilCpfValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'BRAZIL_CPF', masked: maskValue('BRAZIL_CPF', digits), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Mexico CURP / RFC (both format-only — see the validators' comments)
      for (const { match, index } of detectInText(text, 'MEXICO_CURP', PATTERNS.MEXICO_CURP)) {
        if (mexicoCurpValidate(match.toUpperCase()) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'MEXICO_CURP', masked: maskValue('MEXICO_CURP', match.toUpperCase()), confidence: 0.7, bbox, elementId }); nodeFlagged = true; }
        }
      }
      for (const { match, index } of detectInText(text, 'MEXICO_RFC', PATTERNS.MEXICO_RFC)) {
        if (mexicoRfcValidate(match.toUpperCase()) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'MEXICO_RFC', masked: maskValue('MEXICO_RFC', match.toUpperCase()), confidence: 0.65, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Canada SIN (Luhn-validated, tried before AU_TFN below since both
      // share the same 9-digit 3-3-3 grouping and a successful claim here
      // stops the AU_TFN check from also firing on the same digits).
      for (const { match, index } of detectInText(text, 'CANADA_SIN', PATTERNS.CANADA_SIN)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 9 && luhnCheck(digits) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'CANADA_SIN', masked: maskValue('CANADA_SIN', digits), confidence: 0.85, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Australia TFN (ATO weighted-sum mod-11 checksum validated)
      for (const { match, index } of detectInText(text, 'AU_TFN', PATTERNS.AU_TFN)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 9 && auTfnValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'AU_TFN', masked: maskValue('AU_TFN', digits), confidence: 0.85, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // Australia ABN (ISO 7064-style weighted-sum mod-89 checksum validated)
      for (const { match, index } of detectInText(text, 'AU_ABN', PATTERNS.AU_ABN)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 11 && auAbnValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
          claims.claim(index, index + match.length);
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'AU_ABN', masked: maskValue('AU_ABN', digits), confidence: 0.9, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // PHONE — deliberately last and range-gated: this pattern matches
      // almost any 7-15 digit run, so it's the one most likely to
      // needlessly double-label a substring already claimed above by a
      // more specific, checksum-validated type.
      for (const { match, index } of detectInText(text, 'PHONE', PATTERNS.PHONE)) {
        if (looksLikePhone(match) && !claims.overlapsClaimed(index, index + match.length)) {
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'PHONE', masked: maskValue('PHONE', match), confidence: 0.8, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // The NER pass is deliberately NOT awaited here. Awaiting inside this
      // loop is what made extraction serial: one round trip per node, each
      // blocking the next. Eligible nodes are queued and resolved together
      // after the loop, so the deterministic detectors above finish at full
      // speed and the remaining round trips overlap.
      if (isNerEligible(text) && !nerIsCoolingDown()) {
        nerQueue.push({ node, text, elementId });
      }

      if (nodeFlagged) flaggedNodes.add(node);
    }

    // ── NER phase, issued concurrently ──────────────────────────────────
    if (nerQueue.length > 0 && !nerIsCoolingDown()) {
      const spanLists = await Promise.all(nerQueue.map((e) => runNerOnText(e.text)));
      for (let i = 0; i < nerQueue.length; i++) {
        const { node, elementId } = nerQueue[i];
        for (const span of spanLists[i] || []) {
          const type = normalizeEntityType(span.entityType);
          const bbox = bboxForMatch(node, span.start, span.end - span.start, viewportWidth, viewportHeight);
          if (bbox) {
            items.push({ type, masked: maskValue(type, span.text), confidence: span.confidence, bbox, elementId });
            flaggedNodes.add(node);
          }
        }
      }
    }

    return { items, flaggedNodes };
  }

  async function scanPlainText(text, fieldLabel) {
    if (!text) return [];
    const items = [];
    // See makeRangeClaimTracker()'s comment near detectInText(): every
    // checksum/format-validated detector below claims its matched range
    // so the loose PHONE pattern (run last, deliberately) can skip
    // anything already more specifically classified.
    const claims = makeRangeClaimTracker();

    for (const { match, index } of detectInText(text, 'EMAIL', PATTERNS.EMAIL)) {
      claims.claim(index, index + match.length);
      items.push({ type: 'EMAIL', masked: maskValue('EMAIL', match), confidence: 0.98 });
    }

    for (const { match, index } of detectInText(text, 'CARD', PATTERNS.CARD)) {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'CARD', masked: maskValue('CARD', digits), confidence: 0.95 });
      }
    }

    for (const { match, index } of detectInText(text, 'IPV4', PATTERNS.IPV4)) {
      claims.claim(index, index + match.length);
      items.push({ type: 'IP_ADDRESS', masked: maskValue('IPV4', match), confidence: 0.9 });
    }

    for (const { match, index } of detectInText(text, 'AADHAAR', PATTERNS.AADHAAR)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length === 12 && verhoeffValidate(digits)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'AADHAAR', masked: maskValue('AADHAAR', digits), confidence: 0.97 });
      }
    }

    for (const { match, index } of detectInText(text, 'PAN', PATTERNS.PAN)) {
      claims.claim(index, index + match.length);
      items.push({ type: 'PAN', masked: maskValue('PAN', match.toUpperCase()), confidence: 0.9 });
    }

    for (const { match, index } of detectInText(text, 'SECRET_CANDIDATE', PATTERNS.SECRET_CANDIDATE)) {
      if (looksLikeSecret(match)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'SECRET_TOKEN', masked: maskValue('SECRET_TOKEN', match), confidence: 0.75 });
      }
    }

    for (const { match, index } of detectInText(text, 'IBAN', PATTERNS.IBAN)) {
      if (ibanValidate(match)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'IBAN', masked: maskValue('IBAN', match.toUpperCase()), confidence: 0.96 });
      }
    }

    for (const { match, index } of detectInText(text, 'MRZ_LINE2', PATTERNS.MRZ_LINE2)) {
      if (validateMrzLine2(match).valid) {
        claims.claim(index, index + match.length);
        items.push({ type: 'MRZ_PASSPORT', masked: maskValue('MRZ_PASSPORT', match), confidence: 0.97 });
      }
    }

    for (const { match, index } of detectInText(text, 'MRZ_LINE1', PATTERNS.MRZ_LINE1)) {
      if (validateMrzLine1(match).valid && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'MRZ_PASSPORT_NAME', masked: maskValue('MRZ_PASSPORT_NAME', match), confidence: 0.95 });
      }
    }

    // --- Multi-jurisdiction pack (v25 Part 3, Task 4.1) — see the mirrored
    // block in detectSensitiveInfo() above for the per-type comments. ---

    for (const { match, index } of detectInText(text, 'SSN', PATTERNS.SSN)) {
      const digits = match.replace(/\D/g, '');
      if (ssnValidate(digits)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'SSN', masked: maskValue('SSN', digits), confidence: 0.9 });
      }
    }

    for (const { match, index } of detectInText(text, 'UK_NINO', PATTERNS.UK_NINO)) {
      if (ukNinoValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'UK_NINO', masked: maskValue('UK_NINO', match.toUpperCase()), confidence: 0.8 });
      }
    }

    for (const { match, index } of detectInText(text, 'EU_VAT', PATTERNS.EU_VAT)) {
      const result = euVatValidate(match);
      if (result.valid && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'EU_VAT', masked: maskValue('EU_VAT', match.toUpperCase()), confidence: result.checksummed ? 0.93 : 0.7 });
      }
    }

    for (const { match, index } of detectInText(text, 'CHINA_ID', PATTERNS.CHINA_ID)) {
      if (chinaIdValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'CHINA_ID', masked: maskValue('CHINA_ID', match.toUpperCase()), confidence: 0.95 });
      }
    }

    for (const { match, index } of detectInText(text, 'JAPAN_MYNUMBER', PATTERNS.JAPAN_MYNUMBER)) {
      if (japanMyNumberValidate(match) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'JAPAN_MYNUMBER', masked: maskValue('JAPAN_MYNUMBER', match), confidence: 0.95 });
      }
    }

    for (const { match, index } of detectInText(text, 'BRAZIL_CPF', PATTERNS.BRAZIL_CPF)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length === 11 && brazilCpfValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'BRAZIL_CPF', masked: maskValue('BRAZIL_CPF', digits), confidence: 0.95 });
      }
    }

    for (const { match, index } of detectInText(text, 'MEXICO_CURP', PATTERNS.MEXICO_CURP)) {
      if (mexicoCurpValidate(match.toUpperCase()) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'MEXICO_CURP', masked: maskValue('MEXICO_CURP', match.toUpperCase()), confidence: 0.7 });
      }
    }
    for (const { match, index } of detectInText(text, 'MEXICO_RFC', PATTERNS.MEXICO_RFC)) {
      if (mexicoRfcValidate(match.toUpperCase()) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'MEXICO_RFC', masked: maskValue('MEXICO_RFC', match.toUpperCase()), confidence: 0.65 });
      }
    }

    for (const { match, index } of detectInText(text, 'CANADA_SIN', PATTERNS.CANADA_SIN)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length === 9 && luhnCheck(digits) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'CANADA_SIN', masked: maskValue('CANADA_SIN', digits), confidence: 0.85 });
      }
    }

    for (const { match, index } of detectInText(text, 'AU_TFN', PATTERNS.AU_TFN)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length === 9 && auTfnValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'AU_TFN', masked: maskValue('AU_TFN', digits), confidence: 0.85 });
      }
    }

    for (const { match, index } of detectInText(text, 'AU_ABN', PATTERNS.AU_ABN)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length === 11 && auAbnValidate(digits) && !claims.overlapsClaimed(index, index + match.length)) {
        claims.claim(index, index + match.length);
        items.push({ type: 'AU_ABN', masked: maskValue('AU_ABN', digits), confidence: 0.9 });
      }
    }

    // PHONE — deliberately last and range-gated (see comment above).
    for (const { match, index } of detectInText(text, 'PHONE', PATTERNS.PHONE)) {
      if (looksLikePhone(match) && !claims.overlapsClaimed(index, index + match.length)) {
        items.push({ type: 'PHONE', masked: maskValue('PHONE', match), confidence: 0.8 });
      }
    }

    const spans = (isNerEligible(text) && !nerIsCoolingDown())
      ? await runNerOnText(text)
      : [];
    for (const span of spans) {
      const type = normalizeEntityType(span.entityType);
      items.push({ type, masked: maskValue(type, span.text), confidence: span.confidence });
    }

    if (
      fieldLabel &&
      /\b(name|passenger|patient|customer|guest)\b/i.test(fieldLabel) &&
      /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,2}$/.test(text.trim()) &&
      !items.some((it) => it.type === 'NAME')
    ) {
      items.push({ type: 'NAME', masked: maskValue('NAME', text.trim()), confidence: 0.6 });
    }

    return items;
  }

  function detectSensitiveUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      const flaggedParams = [...url.searchParams.keys()].filter((k) =>
        SENSITIVE_QUERY_PARAMS.has(k.toLowerCase())
      );
      if (flaggedParams.length > 0) {
        return { type: 'SENSITIVE_URL_PARAM', masked: `${url.origin}${url.pathname}?...`, confidence: 0.7, params: flaggedParams };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  root.__BA_PiiDetector = {
    detectSensitiveInfo,
    detectSensitiveUrl,
    scanPlainText,
    maskValue,
    luhnCheck,
    verhoeffValidate,
    ibanValidate,
    validateMrzLine2,
    validateMrzLine1,
    looksLikeSecret,
    looksLikePhone,
    shannonEntropy,
    // Multi-jurisdiction pack (v25 Part 3, Task 4.1) — exported for reuse by
    // benchmark/ fixtures and complianceChecker.js.
    ssnValidate,
    ukNinoValidate,
    euVatValidate,
    chinaIdValidate,
    japanMyNumberValidate,
    brazilCpfValidate,
    mexicoCurpValidate,
    mexicoRfcValidate,
    auTfnValidate,
    auAbnValidate,
    ensureModelLoaded: () => Promise.resolve()
  };
})(window);