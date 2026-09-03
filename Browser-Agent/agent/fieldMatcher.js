/**
 * agent/fieldMatcher.js
 *
 * Local Semantic Field Matcher
 *
 * Deterministically analyzes extracted DOM elements (labels, placeholders,
 * aria-labels, input types, attributes) and determines which private data key
 * (e.g. "name", "email", "phone", "college", "address") corresponds to each field.
 *
 * PRIVACY GUARANTEES:
 * 1. Operates entirely locally — no AI models, no remote API calls, no network requests.
 * 2. ONLY determines KEY names (e.g. "email") — NEVER touches or returns actual private values.
 * 3. Does not access PrivateDataStore directly; returns structured match metadata
 *    for the caller to query the store independently.
 */
(function (root) {
  // Common noise words to strip during tokenization
  const NOISE_WORDS = new Set([
    'please', 'enter', 'your', 'type', 'input', 'here', 'provide', 'fill',
    'select', 'choose', 'required', 'optional', 'valid', 'e.g', 'eg', 'the',
    'a', 'an', 'of', 'for', 'in', 'to'
  ]);

  // Sensitive or transient fields that must NEVER match private store keys
  const EXCLUDED_PATTERNS = [
    /\b(password|passwd|pwd|passcode|secret)\b/i,
    /\b(otp|one time password|pin|verification code|security code|2fa|mfa)\b/i,
    /\b(captcha|recaptcha|hcaptcha|turnstile)\b/i,
    /\b(search|query|find|filter)\b/i,
    /\b(comment|feedback|message|review|description|notes|remarks)\b/i,
    /\b(terms|conditions|agree|privacy policy|consent)\b/i,
    /\b(coupon|promo|discount|voucher|referral code)\b/i
  ];

  // Semantic definitions with prioritized aliases and disambiguation rules
  const SEMANTIC_RULES = [
    // ── EMAIL ───────────────────────────────────────────────────────────────
    {
      key: 'email',
      types: ['input:email', 'email'],
      exactMatches: ['email', 'e-mail', 'email address', 'e-mail address', 'email id', 'contact email', 'work email', 'personal email', 'electronic mail'],
      regex: /\b(email|e-mail|email_id|emailaddress|mail_address)\b/i,
      weight: 10
    },

    // ── PHONE (Specific variants first, then generic) ────────────────────────
    {
      key: 'emergency_phone',
      types: [],
      exactMatches: ['emergency phone', 'emergency contact', 'emergency number', 'emergency telephone'],
      regex: /\b(emergency[-_\s]?(phone|contact|number|mobile))\b/i,
      weight: 15
    },
    {
      key: 'work_phone',
      types: [],
      exactMatches: ['work phone', 'office phone', 'business phone', 'work telephone', 'office telephone'],
      regex: /\b(work|office|business)[-_\s]?(phone|telephone|number|mobile)\b/i,
      weight: 15
    },
    {
      key: 'home_phone',
      types: [],
      exactMatches: ['home phone', 'landline', 'home telephone', 'residential phone'],
      regex: /\b(home|landline|residential)[-_\s]?(phone|telephone|number)\b/i,
      weight: 15
    },
    {
      key: 'phone',
      types: ['input:tel', 'tel'],
      exactMatches: [
        'phone', 'phone number', 'telephone', 'telephone number', 'mobile',
        'mobile number', 'cell phone', 'cell number', 'contact number',
        'phone no', 'mobile no', 'contact no', 'cell', 'phone #'
      ],
      regex: /\b(phone|mobile|telephone|cellphone|contact_number|phonenumber|mobilenumber)\b/i,
      weight: 8
    },

    // ── NAME (Specific variants first, then generic) ────────────────────────
    {
      key: 'first_name',
      types: [],
      exactMatches: ['first name', 'given name', 'forename', 'fname', 'first_name', 'firstname'],
      regex: /\b(first[-_\s]?name|given[-_\s]?name|forename|fname)\b/i,
      weight: 15
    },
    {
      key: 'last_name',
      types: [],
      exactMatches: ['last name', 'surname', 'family name', 'lname', 'last_name', 'lastname'],
      regex: /\b(last[-_\s]?name|surname|family[-_\s]?name|lname)\b/i,
      weight: 15
    },
    {
      key: 'middle_name',
      types: [],
      exactMatches: ['middle name', 'mname', 'middle_name', 'middlename', 'middle initial'],
      regex: /\b(middle[-_\s]?name|mname|middle[-_\s]?initial)\b/i,
      weight: 15
    },
    {
      key: 'name',
      types: [],
      exactMatches: [
        'full name', 'name', 'your name', 'applicant name', 'candidate name',
        'user name', 'customer name', 'legal name', 'student name', 'employee name',
        'contact name', 'person name', 'complete name'
      ],
      regex: /\b(full[-_\s]?name|applicant[-_\s]?name|legal[-_\s]?name|candidate[-_\s]?name|customer[-_\s]?name)\b/i,
      fallbackRegex: /^name$|\b(your|full)?[-_\s]?name\b/i,
      weight: 8
    },

    // ── USERNAME / LOGIN ID ─────────────────────────────────────────────────
    {
      key: 'username',
      types: [],
      exactMatches: ['username', 'user id', 'user name', 'login id', 'handle', 'screen name', 'account name'],
      regex: /\b(username|user[-_\s]?id|login[-_\s]?id|account[-_\s]?name|handle)\b/i,
      weight: 12
    },

    // ── ADDRESS (Specific variants first, then generic) ──────────────────────
    {
      key: 'billing_address',
      types: [],
      exactMatches: ['billing address', 'billing street', 'bill address', 'billing address line 1'],
      regex: /\bbilling[-_\s]?(address|street|addr)\b/i,
      weight: 15
    },
    {
      key: 'shipping_address',
      types: [],
      exactMatches: ['shipping address', 'delivery address', 'shipping street', 'ship address'],
      regex: /\b(shipping|delivery)[-_\s]?(address|street|addr)\b/i,
      weight: 15
    },
    {
      key: 'home_address',
      types: [],
      exactMatches: ['home address', 'residential address', 'permanent address'],
      regex: /\b(home|residential|permanent)[-_\s]?(address|addr)\b/i,
      weight: 15
    },
    {
      key: 'street_address',
      types: [],
      exactMatches: ['street address', 'address line 1', 'address line 2', 'street', 'street name', 'house number'],
      regex: /\b(street[-_\s]?address|address[-_\s]?line|street)\b/i,
      weight: 12
    },
    {
      key: 'address',
      types: [],
      exactMatches: ['address', 'postal address', 'mailing address', 'physical address', 'residence address'],
      regex: /\b(address|postal[-_\s]?address|mailing[-_\s]?address)\b/i,
      weight: 8
    },

    // ── GEOGRAPHIC FIELDS ───────────────────────────────────────────────────
    {
      key: 'city',
      types: [],
      exactMatches: ['city', 'town', 'district', 'municipality', 'city / town'],
      regex: /\b(city|town|district|municipality)\b/i,
      weight: 10
    },
    {
      key: 'state',
      types: [],
      exactMatches: ['state', 'province', 'region', 'state / province', 'county'],
      regex: /\b(state|province|region|county)\b/i,
      weight: 10
    },
    {
      key: 'zip',
      types: [],
      exactMatches: ['zip', 'zip code', 'postal code', 'postcode', 'pincode', 'pin code', 'zip / postal code', 'postal / zip code', 'pin'],
      regex: /\b(zip[-_\s]?code|postal[-_\s]?code|postcode|pincode|pin[-_\s]?code)\b/i,
      weight: 12
    },
    {
      key: 'country',
      types: [],
      exactMatches: ['country', 'nation', 'country / region', 'country of residence'],
      regex: /\b(country|nation)\b/i,
      weight: 10
    },

    // ── EDUCATION & EMPLOYMENT ──────────────────────────────────────────────
    {
      key: 'college',
      types: [],
      exactMatches: ['college', 'college name', 'institution', 'institute', 'school', 'school name', 'academy'],
      regex: /\b(college|institution|institute|school)[-_\s]?(name)?\b/i,
      weight: 10
    },
    {
      key: 'university',
      types: [],
      exactMatches: ['university', 'university name', 'campus'],
      regex: /\b(university|campus)[-_\s]?(name)?\b/i,
      weight: 10
    },
    {
      key: 'company',
      types: [],
      exactMatches: ['company', 'company name', 'organization', 'organisation', 'employer', 'workplace', 'business name'],
      regex: /\b(company|organization|organisation|employer|workplace)[-_\s]?(name)?\b/i,
      weight: 10
    },
    {
      key: 'occupation',
      types: [],
      exactMatches: ['occupation', 'job title', 'profession', 'designation', 'role', 'title', 'position'],
      regex: /\b(occupation|job[-_\s]?title|profession|designation|position)\b/i,
      weight: 10
    },

    // ── DEMOGRAPHICS & IDENTIFIERS ──────────────────────────────────────────
    {
      key: 'dob',
      types: ['input:date', 'date'],
      exactMatches: ['date of birth', 'dob', 'birth date', 'birthdate', 'born on', 'd.o.b.'],
      regex: /\b(date[-_\s]?of[-_\s]?birth|birth[-_\s]?date|birthdate|dob)\b/i,
      weight: 12
    },
    {
      key: 'gender',
      types: [],
      exactMatches: ['gender', 'sex'],
      regex: /\b(gender|sex)\b/i,
      weight: 10
    },
    {
      key: 'ssn',
      types: [],
      exactMatches: ['ssn', 'social security number', 'social security #', 'social security no'],
      regex: /\b(ssn|social[-_\s]?security[-_\s]?(number|no|#)?)\b/i,
      weight: 15
    },
    {
      key: 'pan',
      types: [],
      exactMatches: ['pan', 'pan number', 'pan card', 'pan no'],
      regex: /\b(pan[-_\s]?(number|card|no)?)\b/i,
      weight: 15
    },
    {
      key: 'aadhaar',
      types: [],
      exactMatches: ['aadhaar', 'aadhaar number', 'aadhaar card', 'uidai', 'aadhar'],
      regex: /\b(aadhaar|aadhar)[-_\s]?(number|card|no)?\b/i,
      weight: 15
    }
  ];

  class FieldMatcher {
    /**
     * Normalizes a text string: lowercases, removes punctuation/symbols, strips noise words.
     * @param {string} str
     * @returns {string}
     */
    static normalizeText(str) {
      if (!str || typeof str !== 'string') return '';
      const cleaned = str
        .toLowerCase()
        .replace(/[:*#_\-\/\\]/g, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

      const tokens = cleaned.split(/\s+/).filter(t => t && !NOISE_WORDS.has(t));
      return tokens.join(' ');
    }

    /**
     * Extracts raw candidate strings from an element (label, placeholder, aria-label, selector, name).
     * @param {Object} el
     * @returns {string[]}
     */
    static extractCandidateStrings(el) {
      if (!el || typeof el !== 'object') return [];
      const candidates = [];

      if (el.ariaLabel) candidates.push(el.ariaLabel);
      if (el.placeholder) candidates.push(el.placeholder);
      if (el.text && typeof el.text === 'string') candidates.push(el.text);

      // Extract from selector if it contains descriptive IDs or classes
      if (el.selector && typeof el.selector === 'string') {
        const idMatch = el.selector.match(/#([a-zA-Z0-9_\-]+)/);
        if (idMatch) candidates.push(idMatch[1].replace(/[-_]/g, ' '));

        const nameMatch = el.selector.match(/\[name=["']?([^"']+)["']?\]/);
        if (nameMatch) candidates.push(nameMatch[1].replace(/[-_]/g, ' '));
      }

      return candidates;
    }

    /**
     * Matches an extracted DOM element against known semantic profile keys.
     *
     * @param {Object} element - Extracted DOM element from interactiveElements / domExtractor
     * @returns {{
     *   matched: boolean,
     *   key: string | null,
     *   confidence: 'high' | 'medium' | 'low' | 'none',
     *   reason: string
     * }}
     */
    static matchElement(element) {
      if (!element || typeof element !== 'object') {
        return { matched: false, key: null, confidence: 'none', reason: 'Invalid element object' };
      }

      const elType = (element.type || '').toLowerCase();
      const rawCandidates = this.extractCandidateStrings(element);
      const allText = rawCandidates.join(' ');

      // 1. Guard against excluded / transient fields (passwords, OTPs, search, CAPTCHAs)
      for (const pattern of EXCLUDED_PATTERNS) {
        if (pattern.test(allText) || pattern.test(elType)) {
          return {
            matched: false,
            key: null,
            confidence: 'none',
            reason: `Field flagged as excluded/transient (${pattern})`
          };
        }
      }

      // Password input type is strictly excluded
      if (elType === 'password' || elType === 'input:password') {
        return {
          matched: false,
          key: null,
          confidence: 'none',
          reason: 'Password fields cannot be auto-matched'
        };
      }

      // 2. High-confidence match via HTML Input Type
      for (const rule of SEMANTIC_RULES) {
        if (rule.types.includes(elType)) {
          return {
            matched: true,
            key: rule.key,
            confidence: 'high',
            reason: `HTML input type matched: "${elType}"`
          };
        }
      }

      const normalizedCandidates = rawCandidates.map(c => this.normalizeText(c)).filter(Boolean);

      // 3. Exact alias match against normalized candidate strings
      for (const rule of SEMANTIC_RULES) {
        for (const candidate of normalizedCandidates) {
          for (const alias of rule.exactMatches) {
            if (candidate === alias || candidate === this.normalizeText(alias)) {
              return {
                matched: true,
                key: rule.key,
                confidence: 'high',
                reason: `Exact label/placeholder match: "${alias}"`
              };
            }
          }
        }
      }

      // 4. Regex pattern match on combined candidate text
      for (const rule of SEMANTIC_RULES) {
        if (rule.regex && rule.regex.test(allText)) {
          return {
            matched: true,
            key: rule.key,
            confidence: 'high',
            reason: `Semantic pattern match for "${rule.key}"`
          };
        }
      }

      // 5. Fallback regex match (e.g. generic name)
      for (const rule of SEMANTIC_RULES) {
        if (rule.fallbackRegex && rule.fallbackRegex.test(allText)) {
          return {
            matched: true,
            key: rule.key,
            confidence: 'medium',
            reason: `Heuristic fallback match for "${rule.key}"`
          };
        }
      }

      // 6. No confident match
      return {
        matched: false,
        key: null,
        confidence: 'none',
        reason: 'No semantic match found for element'
      };
    }

    /**
     * Batch helper to match a list of extracted elements.
     * @param {Array<Object>} elements
     * @returns {Array<{ elementId: string | number, match: Object }>}
     */
    static matchElements(elements) {
      if (!Array.isArray(elements)) return [];
      return elements.map(el => ({
        elementId: el.id,
        match: this.matchElement(el)
      }));
    }
  }

  root.__BA_FieldMatcher = FieldMatcher;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FieldMatcher };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
