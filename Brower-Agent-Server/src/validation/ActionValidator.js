import actionSchema from "../schemas/actionSchema.js";

function extractJson(text) {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  const start = trimmed.indexOf("{");
  if (start === -1) return trimmed;

  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    if (trimmed[i] === "}") depth--;
    if (depth === 0) {
      return trimmed.slice(start, i + 1);
    }
  }
  return trimmed;
}

// function stripCodeFence(text) {
//     const trimmed = text.trim();
//     const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
//     return fenceMatch ? fenceMatch[1] : trimmed;
// }

function sanitizeRawJson(text) {
  let result = "";
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString && ch === "\n") { result += "\\n"; continue; }
    if (inString && ch === "\r") { result += "\\r"; continue; }
    if (inString && ch === "\t") { result += "\\t"; continue; }

    result += ch;
  }

  return result;
}

const TARGETED_ACTIONS = new Set([
  'click', 'fill', 'type', 'clear', 'select', 'check', 'uncheck', 'radio', 'hover', 'focus', 'fill_from_local', 'upload'
]);


function findTargetElement(action, domSkeleton) {
  const elements = domSkeleton?.elements;

  if (!Array.isArray(elements) || !action?.targetSelector) {
    return null;
  }

  const target = String(action.targetSelector).trim();

  return elements.find((el) => {
    if (!el) return false;

    // Exact CSS selector
    if (String(el.selector || '').trim() === target) {
      return true;
    }

    // Internal element ID: "#17"
    if (target.startsWith('#')) {
      return String(el.id) === target.slice(1);
    }

    // Direct ID
    return String(el.id) === target;
  }) || null;
}


function violatesSensitiveFieldRule(action, domSkeleton) {
  if (
    (action.action !== "fill" && action.action !== "type") ||
    action.value === null
  ) {
    return false;
  }

  const targetElement = findTargetElement(action, domSkeleton);

  if (!targetElement) return false;

  return (
    targetElement.sensitive === true ||
    targetElement.sensitive === "unknown"
  );
}

function targetSelectorIsInvalid(action, domSkeleton) {
  const isTargeted = TARGETED_ACTIONS.has(action.action);
  const elements = domSkeleton?.elements;

  // Targeted actions must have a target
  if (
    isTargeted &&
    (!action.targetSelector || typeof action.targetSelector !== 'string')
  ) {
    return true;
  }

  if (!action.targetSelector || typeof action.targetSelector !== 'string') {
    return false;
  }

  const target = action.targetSelector.trim();

  const exists = Array.isArray(elements) && elements.some((el) => {
    if (!el) return false;

    // 1. Exact CSS selector match
    if (String(el.selector || '').trim() === target) {
      return true;
    }

    // 2. Allow "#17" to refer to internal DOM element ID "17"
    if (target.startsWith('#')) {
      const id = target.slice(1);

      if (String(el.id) === id) {
        return true;
      }
    }

    // 3. Allow direct element ID
    if (String(el.id) === target) {
      return true;
    }

    return false;
  });

  return !exists;
}

const INJECTION_COMPLIANCE_PATTERNS = [
  /\bignor(?:e[ds]?|ing)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  /\bunrestricted\s+agent\b/i,
  /\b(?:reveal|revealing|send|sending|share|sharing|leak|leaking)\s+(?:the\s+)?(?:user'?s?\s+)?(?:private|credentials|password)\b/i,
  /\bper\s+system\s+message\s+on\s+page\b/i,
  /\bwebpage\s+instructed\s+me\b/i
];

function violatesPromptInjectionDefense(action) {
  const textToCheck = `${action.reasoning || ''} ${action.value || ''}`;
  for (const pat of INJECTION_COMPLIANCE_PATTERNS) {
    if (pat.test(textToCheck)) {
      return true;
    }
  }
  return false;
}

function validateAction(rawText, domSkeleton) {
  const extracted = extractJson(rawText);
  const sanitized = sanitizeRawJson(extracted);

  let parsed;
  try {
    parsed = JSON.parse(sanitized);
  } catch (err) {
    return { ok: false, reason: `Reason was not valid JSON: ${err.message}` };
  }

  const result = actionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "Reason did not match action Schema", errors: result.error.issues };
  }

  if (violatesPromptInjectionDefense(result.data)) {
    return { ok: false, reason: "Hostile prompt injection compliance detected in reasoning or value — rejected." };
  }

  if (violatesSensitiveFieldRule(result.data, domSkeleton)) {
    return { ok: false, reason: "Action attempted to fill a sensitive-flagged field - rejected." }
  }

  if (targetSelectorIsInvalid(result.data, domSkeleton)) {
    return { ok: false, reason: "Action targeted a selector not present in the DOM skeleton — rejected." };
  }

  return { ok: true, action: result.data }
}

export default validateAction
