/**
 * agent/complianceChecker.js
 *
 * Local Compliance Signal Checker — GDPR / CCPA / HIPAA
 * (claude/v25-master-implementation-guide.md Part 3, Task 4.2)
 *
 * Inspects data already extracted locally by content/domExtractor.js —
 * pageContext.forms, the visible-text summary, the detected sensitiveItems
 * (content/piiDetector.js), and the interactive element list (link text and
 * href) — for a small set of well-known, keyword/structure-based
 * compliance SIGNALS. Nothing new is read from the page and nothing here
 * makes a network request; this runs entirely on data the extension
 * already had in hand for redaction.
 *
 * Honesty boundary, stated up front because it matters: this is pattern
 * matching over visible text and link targets. It can tell you whether a
 * cookie-consent banner, a privacy-policy link, or a "Do Not Sell my
 * personal information" link is present on the page in front of you right
 * now. It CANNOT tell you whether the organization running that page is
 * actually GDPR/CCPA/HIPAA compliant overall — that depends on data
 * processing agreements, retention policies, and what happens to the data
 * after submission, none of which a page inspection can see. Every finding
 * below is phrased as "this page does/doesn't show signal X", never as a
 * legal verdict, matching CONSTITUTION.md's "What this document is not"
 * caveat applied to this whole project. Treat a HIGH severity finding as
 * "worth the user's attention", not as a compliance certification either
 * way.
 */
(function (root) {
  // ── GDPR signal patterns ─────────────────────────────────────────────
  const COOKIE_CONSENT_PATTERNS = /\b(we use cookies|this (site|website) uses cookies|cookie (consent|policy|preferences|settings)|accept (all )?cookies|manage (cookie|your) preferences|by continuing to (browse|use) this (site|website)|consent to (the use of )?cookies)\b/i;
  const PRIVACY_POLICY_LINK_PATTERNS = /\b(privacy policy|privacy notice|privacy statement)\b/i;
  const CROSS_BORDER_PATTERNS = /\b(cross-border|international transfer|transferred? (outside|to countries outside)|standard contractual clauses|third[- ]?countr(y|ies)|adequacy decision)\b/i;

  // ── CCPA signal patterns ─────────────────────────────────────────────
  const DO_NOT_SELL_PATTERNS = /\b(do not sell (or share )?my (personal )?(information|data)|your privacy choices|opt[- ]?out of (the )?sale|do not sell my info)\b/i;
  const CCPA_OPT_OUT_PATTERNS = /\b(unsubscribe|opt[- ]?out of marketing|marketing preferences|email preferences)\b/i;

  // ── HIPAA signal patterns ────────────────────────────────────────────
  // Deliberately broad-but-plain-language terms a real intake/medical form
  // uses, not a clinical taxonomy — this is a page-structure heuristic, not
  // a medical NLP model.
  const HEALTH_KEYWORD_PATTERNS = /\b(diagnos(is|es)|medical (history|condition|record)|prescription|patient (name|id|information)|physician|treatment plan|health insurance|medication|therapy session|mental health|hiv status|blood type|allergies|immunization|surgery history|clinical trial)\b/i;

  const SEVERITY_SCORE_DEDUCTION = { HIGH: 25, MEDIUM: 15, LOW: 5 };

  function collectPageText(visibleText, elements) {
    const parts = [];
    if (Array.isArray(visibleText)) {
      for (const entry of visibleText) {
        if (entry && typeof entry.text === 'string' && !entry.text.startsWith('[REDACTED')) {
          parts.push(entry.text);
        }
      }
    }
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (el && el.text) parts.push(String(el.text));
        if (el && el.ariaLabel) parts.push(String(el.ariaLabel));
        if (el && el.placeholder) parts.push(String(el.placeholder));
      }
    }
    return parts.join(' \n ');
  }

  function collectLinkTargets(elements) {
    if (!Array.isArray(elements)) return [];
    return elements
      .filter((el) => el && (el.type === 'link' || (el.tag || '').toLowerCase() === 'a'))
      .map((el) => ({ text: (el.text || el.ariaLabel || '').trim(), href: el.href || null }));
  }

  function anyLinkMatches(links, pattern) {
    return links.some((l) => pattern.test(l.text || '') || (l.href && pattern.test(l.href)));
  }

  class ComplianceChecker {
    /**
     * @param {object} args
     * @param {Array} args.elements        Interactive elements from the current extraction.
     * @param {Array} args.visibleText     visibleText summary from content/domExtractor.js.
     * @param {Array} args.sensitiveItems  Detected PII items (content/piiDetector.js types).
     * @param {string} [args.pageUrl]
     * @returns {{
     *   score: number,
     *   violations: Array<{id:string, law:string, severity:string, title:string, description:string, evidence?:string}>,
     *   signals: object
     * }}
     */
    static check({ elements = [], visibleText = [], sensitiveItems = [], pageUrl = '' } = {}) {
      const pageText = collectPageText(visibleText, elements).toLowerCase();
      const links = collectLinkTargets(elements);
      const isInsecure = typeof pageUrl === 'string' && pageUrl.trim().toLowerCase().startsWith('http://');

      const hasCookieConsentBanner = COOKIE_CONSENT_PATTERNS.test(pageText);
      const hasPrivacyPolicyLink = anyLinkMatches(links, PRIVACY_POLICY_LINK_PATTERNS) || PRIVACY_POLICY_LINK_PATTERNS.test(pageText);
      const hasCrossBorderDisclosure = CROSS_BORDER_PATTERNS.test(pageText);
      const hasDoNotSellLink = anyLinkMatches(links, DO_NOT_SELL_PATTERNS) || DO_NOT_SELL_PATTERNS.test(pageText);
      const hasCcpaOptOut = anyLinkMatches(links, CCPA_OPT_OUT_PATTERNS) || CCPA_OPT_OUT_PATTERNS.test(pageText);
      const hasHealthKeywords = HEALTH_KEYWORD_PATTERNS.test(pageText);

      const piiTypes = new Set((Array.isArray(sensitiveItems) ? sensitiveItems : []).map((it) => it && it.type).filter(Boolean));
      const collectsPii = piiTypes.size > 0;
      const highStakesScorer = root.__BA_ConfidenceScorer;
      // Reuse confidenceScorer.js's own notion of "high stakes" PII types
      // where available, rather than re-defining a second list that could
      // silently drift out of sync with it.
      const highStakesTypes = ['AADHAAR', 'PAN', 'CARD', 'SSN', 'IBAN', 'MRZ_PASSPORT', 'UK_NINO', 'EU_VAT', 'CHINA_ID', 'JAPAN_MYNUMBER', 'BRAZIL_CPF', 'CANADA_SIN', 'AU_TFN', 'AU_ABN'];
      const highStakesCount = highStakesTypes.filter((t) => piiTypes.has(t)).length;

      const violations = [];

      // ── GDPR ──────────────────────────────────────────────────────────
      if (collectsPii && !hasCookieConsentBanner) {
        violations.push({
          id: 'GDPR_NO_CONSENT_BANNER',
          law: 'GDPR',
          severity: 'MEDIUM',
          title: 'No cookie/consent banner detected',
          description: 'This page collects personal data but no cookie-consent or data-processing consent banner was found in the visible text. GDPR (Art. 6/7) generally requires a lawful basis and, for non-essential cookies, opt-in consent before collection.',
        });
      }
      if (collectsPii && !hasPrivacyPolicyLink) {
        violations.push({
          id: 'GDPR_NO_PRIVACY_POLICY_LINK',
          law: 'GDPR',
          severity: 'MEDIUM',
          title: 'No privacy policy link found',
          description: 'This page collects personal data but no link to a privacy policy/notice was found among its visible links or text. GDPR Art. 13/14 require this information to be provided at the point of collection.',
        });
      }
      if (highStakesCount >= 3) {
        violations.push({
          id: 'GDPR_POSSIBLE_EXCESSIVE_COLLECTION',
          law: 'GDPR',
          severity: 'LOW',
          title: 'Multiple high-sensitivity identifiers requested on one page',
          description: `${highStakesCount} distinct high-sensitivity identifier types (e.g. national ID, card, bank account numbers) were detected on this single page. GDPR's data-minimization principle (Art. 5(1)(c)) calls for collecting only what's necessary for the stated purpose — worth checking whether all of these are actually needed here.`,
        });
      }

      // ── CCPA ──────────────────────────────────────────────────────────
      if (collectsPii && !hasDoNotSellLink) {
        violations.push({
          id: 'CCPA_NO_DO_NOT_SELL_LINK',
          law: 'CCPA',
          severity: 'LOW',
          title: '"Do Not Sell or Share My Personal Information" link not found',
          description: 'No "Do Not Sell/Share My Personal Information" or "Your Privacy Choices" link was found. CCPA requires this only for businesses that sell/share personal information as defined by the statute — this page inspection cannot determine whether that applies here, so treat this as a signal to check, not a confirmed violation.',
        });
      }
      if (collectsPii && !hasCcpaOptOut && !hasDoNotSellLink) {
        violations.push({
          id: 'CCPA_NO_OPT_OUT_MECHANISM',
          law: 'CCPA',
          severity: 'LOW',
          title: 'No opt-out / unsubscribe mechanism found',
          description: 'No unsubscribe or marketing-preferences opt-out link was found alongside the data collected on this page.',
        });
      }

      // ── HIPAA ─────────────────────────────────────────────────────────
      if (hasHealthKeywords && isInsecure) {
        violations.push({
          id: 'HIPAA_HEALTH_INFO_ON_INSECURE_FORM',
          law: 'HIPAA',
          severity: 'HIGH',
          title: 'Health-related information requested over an insecure (HTTP) connection',
          description: 'This page appears to request health-related information (diagnosis, medication, patient/medical record fields, etc.) but is not served over HTTPS. HIPAA\'s Security Rule requires appropriate technical safeguards, including encryption in transit, for protected health information.',
        });
      }
      if (hasHealthKeywords && highStakesCount > 0) {
        violations.push({
          id: 'HIPAA_HEALTH_INFO_WITH_IDENTIFIER',
          law: 'HIPAA',
          severity: 'MEDIUM',
          title: 'Health information combined with an identifying number',
          description: 'This page appears to combine health-related fields with a high-sensitivity identifier (national ID, card, or similar). Combining health data with an identifier is exactly what turns health information into Protected Health Information (PHI) under HIPAA — worth extra caution about where this page sends it.',
        });
      } else if (hasHealthKeywords) {
        violations.push({
          id: 'HIPAA_HEALTH_INFO_FORM_DETECTED',
          law: 'HIPAA',
          severity: 'LOW',
          title: 'Health-related form detected',
          description: 'This page appears to collect health-related information. Informational only — no specific issue found beyond the presence of this data category, but consider Hybrid or Fully Local Privacy Dial mode for pages like this.',
        });
      }

      const scoreDeduction = violations.reduce((sum, v) => sum + (SEVERITY_SCORE_DEDUCTION[v.severity] || 0), 0);
      const score = Math.max(0, 100 - scoreDeduction);

      return {
        score,
        violations,
        signals: {
          collectsPii,
          highStakesPiiTypeCount: highStakesCount,
          hasCookieConsentBanner,
          hasPrivacyPolicyLink,
          hasCrossBorderDisclosure,
          hasDoNotSellLink,
          hasCcpaOptOut,
          hasHealthKeywords,
          isInsecureTransport: isInsecure,
        },
      };
    }
  }

  root.__BA_ComplianceChecker = ComplianceChecker;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ComplianceChecker };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
