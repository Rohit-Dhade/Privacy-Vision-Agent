/**
 * agent/trustGate.js
 *
 * Pre-Autofill Trust / Phishing Gate
 *
 * The Consequential Action Safety Gate (consequentialActionDetector.js)
 * protects against the AGENT doing something dangerous. This module
 * protects against the PAGE ITSELF being dangerous — a look-alike
 * phishing form designed to harvest the private data the agent is about
 * to autofill into it.
 *
 * Same design philosophy as the rest of the safety stack:
 * 1. Entirely deterministic — no AI model, no remote calls, no network requests.
 * 2. Operates only on already-extracted, non-sensitive DOM metadata
 *    (page URL, form action URL, field labels/types) — never on private values.
 * 3. Fails OPEN to a WARN (never silently blocks or silently allows a
 *    HIGH-risk case) — the human always makes the final call via the
 *    existing Human Authorization Gate UI (userInputManager.renderConfirmation).
 *
 * Checks performed, in order of severity:
 *   A. Form action domain !== page domain           -> BLOCK
 *   B. Page not served over HTTPS                    -> WARN
 *   C. Page domain is a "look-alike" of a known
 *      government / banking domain (small edit
 *      distance, or the trusted brand name embedded
 *      as a decoy subdomain/prefix)                  -> BLOCK
 *   D. Unusually sensitive combination of fields on
 *      one form (e.g. password + card + Aadhaar)      -> WARN, escalates
 *      to BLOCK once 3+ distinct sensitive categories
 *      are present, or password appears alongside a
 *      government ID / financial field.
 */
(function (root) {
  // A small, illustrative set of high-value Indian government/banking
  // domains most likely to be impersonated in a KYC-style phishing flow.
  // This is NOT an allow-list (unlisted domains are not penalized) — it's
  // only used to catch look-alikes of these specific well-known names.
  const TRUSTED_REFERENCE_DOMAINS = [
    'uidai.gov.in',
    'incometax.gov.in',
    'digilocker.gov.in',
    'india.gov.in',
    'nsdl.co.in',
    'protean-tinpan.com',
    'utiitsl.com',
    'epfindia.gov.in',
    'passportindia.gov.in',
    'irctc.co.in',
    'onlinesbi.sbi',
    'sbi.co.in',
    'hdfcbank.com',
    'icicibank.com',
    'axisbank.com',
    'pnbindia.in'
  ];

  const SENSITIVE_FIELD_TESTS = [
    { key: 'password', test: (el, text) => (el.type || '').toLowerCase().includes('password') },
    { key: 'aadhaar', test: (el, text) => /aadhaar|aadhar|uidai/i.test(text) },
    { key: 'pan', test: (el, text) => /\bpan\b|permanent account number/i.test(text) },
    { key: 'card', test: (el, text) => /card\s*number|credit\s*card|debit\s*card|\bcvv\b|card\s*expiry/i.test(text) },
    { key: 'otp', test: (el, text) => /\botp\b|one[-\s]?time\s*password/i.test(text) },
    { key: 'bank_account', test: (el, text) => /account\s*number|ifsc/i.test(text) }
  ];

  /** Cheap, dependency-free Levenshtein edit distance (bounded use-case: domain strings, <64 chars). */
  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // deletion
          curr[j - 1] + 1,  // insertion
          prev[j - 1] + cost // substitution
        );
      }
      for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
  }

  function getDomain(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      return new URL(url, location?.href).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  /**
   * Returns the trusted domain being impersonated if `domain` looks like a
   * decoy of one of TRUSTED_REFERENCE_DOMAINS, else null.
   * Two independent signals, either one is enough:
   *   1. Small edit distance + similar length (typosquats: "uidai-gov.in", "uidaii.gov.in")
   *   2. The trusted brand's name embedded but the domain doesn't actually end with it
   *      (decoy subdomains: "uidai.gov.in.verify-kyc.com", "sbi-secure-login.com")
   */
  function findImpersonatedDomain(domain) {
    if (!domain) return null;
    for (const trusted of TRUSTED_REFERENCE_DOMAINS) {
      if (domain === trusted || domain.endsWith('.' + trusted)) return null; // genuinely trusted
    }
    for (const trusted of TRUSTED_REFERENCE_DOMAINS) {
      const dist = levenshtein(domain, trusted);
      if (dist > 0 && dist <= 2 && Math.abs(domain.length - trusted.length) <= 3) {
        return trusted;
      }
      const brand = trusted.split('.')[0];
      if (brand.length >= 3 && domain.includes(brand) && !domain.endsWith(trusted)) {
        return trusted;
      }
    }
    return null;
  }

  function collectFieldText(el) {
    return `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''} ${el.selector || ''}`.toLowerCase();
  }

  function detectSensitiveCombo(elements) {
    const found = new Set();
    for (const el of (elements || [])) {
      if (!el) continue;
      const text = collectFieldText(el);
      for (const { key, test } of SENSITIVE_FIELD_TESTS) {
        if (test(el, text)) found.add(key);
      }
    }
    return Array.from(found);
  }

  /**
   * @param {{
   *   pageUrl: string,
   *   formAction?: string|null,
   *   elements?: Array<Object>
   * }} input
   * @returns {{
   *   level: 'allow'|'warn'|'block',
   *   reasons: string[],
   *   domain: string,
   *   isHttps: boolean,
   *   sensitiveCombo: string[]
   * }}
   */
  function evaluate({ pageUrl, formAction, elements } = {}) {
    const reasons = [];
    let level = 'allow';
    const domain = getDomain(pageUrl);
    const isHttps = /^https:/i.test(pageUrl || '');

    if (!isHttps && domain) {
      reasons.push(`This page is not served over HTTPS ("${pageUrl}"). Data typed here can be intercepted in transit.`);
      level = 'warn';
    }

    if (formAction) {
      const formDomain = getDomain(formAction);
      if (formDomain && domain && formDomain !== domain && !formDomain.endsWith('.' + domain) && !domain.endsWith('.' + formDomain)) {
        reasons.push(`This form submits your data to a different domain ("${formDomain}") than the page you're viewing ("${domain}").`);
        level = 'block';
      }
    }

    const impersonated = findImpersonatedDomain(domain);
    if (impersonated) {
      reasons.push(`"${domain}" closely resembles the trusted domain "${impersonated}" — this looks like a possible look-alike/phishing site.`);
      level = 'block';
    }

    const sensitiveCombo = detectSensitiveCombo(elements);
    if (sensitiveCombo.length >= 2) {
      reasons.push(`This page asks for an unusually sensitive combination of data on one form: ${sensitiveCombo.join(', ')}.`);
      if (level === 'allow') level = 'warn';
      const hasCredential = sensitiveCombo.includes('password') || sensitiveCombo.includes('otp');
      const hasIdOrFinancial = sensitiveCombo.includes('aadhaar') || sensitiveCombo.includes('pan') ||
        sensitiveCombo.includes('card') || sensitiveCombo.includes('bank_account');
      if (sensitiveCombo.length >= 3 || (hasCredential && hasIdOrFinancial)) {
        level = 'block';
      }
    }

    return { level, reasons, domain, isHttps, sensitiveCombo };
  }

  root.__BA_TrustGate = {
    evaluate,
    getDomain,
    levenshtein,
    findImpersonatedDomain,
    TRUSTED_REFERENCE_DOMAINS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evaluate, getDomain, levenshtein, findImpersonatedDomain };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
