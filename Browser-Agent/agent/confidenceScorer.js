/**
 * agent/confidenceScorer.js
 *
 * Multi-factor confidence scoring for a single proposed decision (local or
 * cloud), per claude/v25-master-implementation-guide.md Part 3 / Task 2.4.
 *
 * This does NOT replace a reasoner's own self-reported confidence — it
 * combines that self-report with independently-observable signals already
 * available in this extension's pipeline (checksum-validated PII detection
 * from content/piiDetector.js, HTTPS status, destination/consequential-
 * action risk, and simple task/field context overlap) so that two
 * reasoners which both merely *claim* "90% confident" can still be told
 * apart by how well-supported that claim actually is.
 *
 * Entirely local, synchronous, pure — no network calls, no model
 * inference. Used by agent/debateManager.js to compare the local WebLLM
 * agent against the cloud agent in Hybrid Debate mode, and can be called
 * standalone to explain any single decision.
 */
(function (root) {

  const HIGH_STAKES_PII = new Set([
    'AADHAAR', 'PAN', 'CARD', 'SSN', 'IBAN', 'MRZ_PASSPORT',
    'MRZ_PASSPORT_NAME', 'SECRET_TOKEN',
    // Multi-jurisdiction pack (v25 Part 3, Task 4.1) — national ID / tax
    // ID numbers, same stakes class as AADHAAR/PAN/SSN above.
    'UK_NINO', 'EU_VAT', 'CHINA_ID', 'JAPAN_MYNUMBER', 'BRAZIL_CPF',
    'MEXICO_CURP', 'MEXICO_RFC', 'CANADA_SIN', 'AU_TFN', 'AU_ABN'
  ]);

  const SUSPICIOUS_DOMAIN_PATTERNS = [
    /^xn--/i,                         // punycode / homograph risk
    /\d{1,3}(\.\d{1,3}){3}$/,         // bare IP literal as host
    /-(login|secure|verify|update|account)-/i,
    /\.(zip|mov|tk|top|xyz)$/i        // low-cost / commonly-abused TLDs
  ];

  function clamp01(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  /** Geometric mean of whatever factors are actually present (non-null),
   *  so a factor this evidence didn't have an opinion on doesn't silently
   *  drag the score toward zero — it's just left out of the combination. */
  function combineFactors(factors) {
    const present = Object.values(factors).filter((v) => typeof v === 'number');
    if (present.length === 0) return 0.5; // no signal at all: neutral
    const product = present.reduce((acc, v) => acc * Math.max(1e-4, v), 1);
    return Math.pow(product, 1 / present.length);
  }

  /** Self-reported confidence from the reasoner itself (local LLM or cloud
   *  model). This is the single most important factor, but it is only ONE
   *  factor here — the rest of this module exists precisely because a
   *  model's own stated confidence can be wrong or unfounded. */
  function modelSelfConfidence(decision) {
    return clamp01(decision && decision.confidence);
  }

  /** Average checksum-validated confidence of any PII the target element
   *  was flagged as containing (content/piiDetector.js already runs
   *  Luhn/Verhoeff/ISO-7064/MRZ check-digit validation before assigning a
   *  confidence — see that file). Neutral (null) when the decision's
   *  target isn't a sensitive field at all. */
  function checksumStrength(decision, evidence) {
    const items = Array.isArray(evidence && evidence.sensitiveItems) ? evidence.sensitiveItems : [];
    if (items.length === 0) return null;
    const targetId = decision && (decision.elementId ?? null);
    const relevant = targetId != null
      ? items.filter((it) => it.elementId === targetId)
      : [];
    if (relevant.length === 0) return null;
    const avg = relevant.reduce((sum, it) => sum + (typeof it.confidence === 'number' ? it.confidence : 0.7), 0) / relevant.length;
    return clamp01(avg);
  }

  /** HTTPS is a floor-level signal, not a strong one on its own — a
   *  phishing page can be served over HTTPS too — so this stays a modest
   *  factor rather than a gate. */
  function httpsScore(evidence) {
    const url = evidence && (evidence.pageUrl || (evidence.pageContext && evidence.pageContext.url));
    if (typeof url !== 'string' || !url) return null;
    if (url.startsWith('https://')) return 0.9;
    if (url.startsWith('http://')) return 0.4;
    return 0.6; // chrome://, file://, etc. — genuinely unknown
  }

  /** Cheap, local domain-reputation heuristic. Prefers a real verdict from
   *  agent/trustGate.js when the caller supplied one (evidence.trustGate),
   *  since that module already does the fuller phishing-pattern analysis
   *  used elsewhere in this pipeline — this is only a fallback so
   *  confidenceScorer.js stays usable on its own. */
  function domainReputation(evidence) {
    if (evidence && evidence.trustGate && typeof evidence.trustGate.score === 'number') {
      return clamp01(evidence.trustGate.score);
    }
    const url = evidence && (evidence.pageUrl || (evidence.pageContext && evidence.pageContext.url));
    if (typeof url !== 'string' || !url) return null;
    let host;
    try { host = new URL(url).hostname; } catch (_) { return null; }
    const suspicious = SUSPICIOUS_DOMAIN_PATTERNS.some((p) => p.test(host));
    return suspicious ? 0.25 : 0.85;
  }

  /** A decision that would send data toward a different origin than the
   *  page currently on screen (a consequential submit/payment/navigate to
   *  a third party) is inherently riskier than one that stays on-page. */
  function destinationSafety(decision, evidence) {
    const consequential = evidence && evidence.consequential;
    if (consequential == null) return null;
    if (!consequential.isConsequential) return 0.9;
    // A flagged consequential action (submit/payment/publish/delete) is
    // exactly the case CONSTITUTION.md routes through explicit human
    // confirmation regardless of this score — the score here only feeds
    // the debate/evidence display, it is never used to skip that gate.
    return consequential.actionType === 'PAYMENT' ? 0.35 : 0.55;
  }

  /** Rarer / higher-stakes PII types warrant more caution before a
   *  decision acts on them autonomously, independent of how confident the
   *  reasoner sounds. */
  function piiRarityPenalty(decision, evidence) {
    const items = Array.isArray(evidence && evidence.sensitiveItems) ? evidence.sensitiveItems : [];
    const targetId = decision && (decision.elementId ?? null);
    const relevant = targetId != null ? items.filter((it) => it.elementId === targetId) : [];
    if (relevant.length === 0) return null;
    const anyHighStakes = relevant.some((it) => HIGH_STAKES_PII.has(it.type));
    return anyHighStakes ? 0.55 : 0.85;
  }

  /** Simple lexical overlap between the task instruction and the target
   *  element's own label text — a decision whose target has nothing to do
   *  with the stated task is a weak signal worth surfacing, even though
   *  it's a coarse heuristic (this deliberately mirrors the same
   *  task-token scoring already used in agent/agentBackend.js's
   *  buildDomSkeleton(), reused here for consistency). */
  function contextMatch(decision, evidence) {
    const task = evidence && evidence.task;
    const elements = Array.isArray(evidence && evidence.elements) ? evidence.elements : [];
    if (!task || elements.length === 0) return null;
    const targetId = decision && (decision.elementId ?? null);
    const el = targetId != null ? elements.find((e) => e.id === targetId) : null;
    if (!el) return null;
    const taskTokens = String(task).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    if (taskTokens.length === 0) return null;
    const labelText = `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''}`.toLowerCase();
    if (!labelText.trim()) return 0.6; // no label at all — genuinely unknown, not necessarily bad
    const hits = taskTokens.filter((t) => labelText.includes(t)).length;
    return clamp01(0.5 + Math.min(0.5, hits * 0.2));
  }

  class ConfidenceScorer {
    /**
     * @param {{decision: object, evidence: object, source?: string}} args
     * @returns {{confidence:number, factors:object, vulnerabilities:string[]}}
     */
    static score({ decision, evidence = {} } = {}) {
      const factors = {
        modelSelfConfidence: modelSelfConfidence(decision),
        checksumStrength: checksumStrength(decision, evidence),
        httpsScore: httpsScore(evidence),
        domainReputation: domainReputation(evidence),
        destinationSafety: destinationSafety(decision, evidence),
        piiRarity: piiRarityPenalty(decision, evidence),
        contextMatch: contextMatch(decision, evidence),
      };

      const confidence = combineFactors(factors);
      const vulnerabilities = Object.entries(factors)
        .filter(([, v]) => typeof v === 'number' && v < 0.5)
        .map(([name]) => name);

      return { confidence: Number(confidence.toFixed(3)), factors, vulnerabilities };
    }
  }

  root.__BA_ConfidenceScorer = ConfidenceScorer;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ConfidenceScorer };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
