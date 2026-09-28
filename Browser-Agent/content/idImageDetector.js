/**
 * content/idImageDetector.js
 *
 * Heuristic, on-device detector for <img>/<canvas> elements that are
 * likely to be showing a scanned/photographed government ID document
 * (Aadhaar, PAN, passport, driving licence, voter ID, etc.) — for
 * example a KYC form's "preview" thumbnail of an uploaded ID.
 *
 * This closes a real gap: the PII pipeline (piiDetector.js) only reads
 * DOM TEXT nodes. A photo of a physical ID card rendered as an <img> or
 * drawn onto a <canvas> carries no text nodes at all, so without this
 * pass it would sail straight through to the "redacted" screenshot
 * untouched.
 *
 * Detection is deterministic and local — no OCR, no network calls, no
 * AI model. It looks at:
 *   1. Nearby text (alt/aria-label/title/id/class/src, plus a small
 *      DOM neighborhood of labels/headings/captions/file inputs) for
 *      explicit ID-document keywords ("Aadhaar", "PAN", "Passport",
 *      "KYC", "identity proof", etc.)
 *   2. As a secondary heuristic: "upload/preview" language nearby
 *      combined with an aspect ratio typical of a photographed/scanned
 *      ID card (~1.586 landscape ISO/IEC 7810 card ratio, or a portrait
 *      scan crop).
 *
 * Output is a list of viewport-relative bounding boxes, in the exact
 * same shape as piiDetector's sensitiveItems bbox, so the existing
 * redaction pipeline (redactor.js / popup.js drawRedactedScreenshot)
 * can black them out with no further changes to the coordinate math.
 */
(function (root) {
  const ID_KEYWORDS = /(aadhaar|aadhar|uidai|\bpan\s*card\b|\bpan\s*number\b|passport|driving\s*licen[cs]e|\bdl\s*number\b|voter\s*id|voter\s*card|identity\s*proof|\bid\s*proof\b|\bkyc\b|identity\s*card|government[-\s]?id|national\s*id|proof\s*of\s*identity|proof\s*of\s*address)/i;

  const UPLOAD_KEYWORDS = /(upload|uploaded|scan|scanned|attach|attachment|choose\s*file|browse|preview|selected\s*file)/i;

  const MIN_DIMENSION_PX = 40; // ignore icons/avatars/logos

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim().slice(0, 200);
  }

  /**
   * Cheap approximation of "near" without a full geometric proximity
   * search: attributes on the element itself, plus a shallow walk up a
   * few ancestor levels collecting label/heading/caption text and any
   * sibling <input type="file"> metadata (the common
   * "<label>Aadhaar Card</label><input type=file><img class=preview>"
   * pattern used by most KYC upload widgets).
   */
  function nearbyText(el) {
    const parts = [
      el.getAttribute('alt') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.id || '',
      (typeof el.className === 'string' ? el.className : ''),
      el.getAttribute('src') || el.getAttribute('data-src') || ''
    ];

    let node = el;
    for (let hop = 0; hop < 4 && node; hop++) {
      node = node.parentElement;
      if (!node) break;

      const caption = node.querySelector
        ? node.querySelector('label, legend, h1, h2, h3, h4, figcaption, .form-label, [class*="label" i], [class*="caption" i]')
        : null;
      if (caption) parts.push(textOf(caption));

      let sib = node.previousElementSibling;
      let sibHops = 0;
      while (sib && sibHops < 2) {
        parts.push(textOf(sib));
        sib = sib.previousElementSibling;
        sibHops++;
      }

      const fileInput = node.querySelector ? node.querySelector('input[type="file"]') : null;
      if (fileInput) {
        parts.push(fileInput.getAttribute('name') || '');
        parts.push(fileInput.getAttribute('id') || '');
        parts.push(fileInput.getAttribute('accept') || '');
        const flabel = fileInput.id ? document.querySelector(`label[for="${CSS.escape(fileInput.id)}"]`) : null;
        if (flabel) parts.push(textOf(flabel));
      }
    }

    return parts.join(' ').toLowerCase();
  }

  function looksLikeIdCardAspect(rect) {
    if (!rect.width || !rect.height) return false;
    const ratio = rect.width / rect.height;
    // ISO/IEC 7810 ID-1 ratio is ~1.586 (landscape card scans); phone
    // photos of a card at a slight angle land roughly in 1.2-2.0.
    // Portrait document scans (passport photo pages, full-page ID
    // photocopies) tend to fall around 0.5-0.85.
    return (ratio > 1.2 && ratio < 2.0) || (ratio > 0.5 && ratio < 0.85);
  }

  /**
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   * @returns {Array<{bbox:{x:number,y:number,width:number,height:number}, reason:string, tag:string}>}
   */
  function detectIdImageRegions(viewportWidth, viewportHeight) {
    const regions = [];
    const candidates = document.querySelectorAll('img, canvas');

    for (const el of candidates) {
      if (!root.__BA_Visibility || !root.__BA_Visibility.isElementVisible(el, viewportWidth, viewportHeight)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_DIMENSION_PX || rect.height < MIN_DIMENSION_PX) continue;

      const text = nearbyText(el);
      const hasIdKeyword = ID_KEYWORDS.test(text);
      const hasUploadKeyword = UPLOAD_KEYWORDS.test(text);
      const aspectMatches = looksLikeIdCardAspect(rect);

      if (hasIdKeyword || (hasUploadKeyword && aspectMatches)) {
        regions.push({
          bbox: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          reason: hasIdKeyword ? 'id_keyword_match' : 'upload_preview_aspect_match',
          tag: el.tagName.toLowerCase()
        });
      }
    }

    return regions;
  }

  root.__BA_IdImageDetector = { detectIdImageRegions };
})(window);
