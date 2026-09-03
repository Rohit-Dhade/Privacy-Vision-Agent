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

function violatesSensitiveFieldRule(action, domSkeleton) {
  if ((action.action !== "fill" && action.action !== "type") || action.value === null) return false;

  const targetElement = domSkeleton?.elements?.find(
    (el) => el.selector === action.targetSelector
  );

  if (!targetElement) return false;

  return targetElement.sensitive === true || targetElement.sensitive === "unknown";
}

function targetSelectorIsInvalid(action, domSkeleton) {
  const isTargeted = TARGETED_ACTIONS.has(action.action);
  
  // If targeted action has no selector, it's invalid
  if (isTargeted && (!action.targetSelector || typeof action.targetSelector !== 'string')) {
    return true;
  }

  // If selector is provided, verify existence in DOM skeleton
  if (action.targetSelector && typeof action.targetSelector === 'string') {
    const exists = domSkeleton?.elements?.some((el) => el.selector === action.targetSelector);
    return !exists;
  }

  return false;
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
















/***
node test/testCloudProvider.js
--- Request being sent ---
{
  "model": "pixtral-12b-2409",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "system",
      "content": "You are a browser automation agent. You receive a screenshot where sensitive regions have already been redacted (blacked out or blurred) by the client for privacy. The accompanying DOM skeleton tells you exactly what each redacted region represents via a redactionTag (e.g. REDACTED_PASSWORD, REDACTED_ID_DOCUMENT). Treat these as real, existing fields/content — never ask for their actual values, never assume they are empty. Your job is to decide the next single UI action to progress the given task. Respond ONLY with valid JSON matching this schema: { \"action\": \"click|scroll|fill|wait|done\", \"targetSelector\": string, \"value\": string|null, \"reasoning\": string }. Never propose a 'fill' action with a value for any selector whose element is flagged sensitive."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Task: Click the submit button\n\nDOM skeleton (JSON):\n{\"url\":\"https://example.com\",\"elements\":[{\"id\":\"el_1\",\"tag\":\"button\",\"selector\":\"#submit-btn\",\"box\":{\"x\":10,\"y\":10,\"width\":80,\"height\":30},\"sensitive\":false}]}\n\nRedaction map (JSON):\n[]\n\nAction history so far:\n[]\n\nHere is the current (redacted) screenshot:"
        },
        {
          "type": "image_url",
          "imageUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
    }
  ]
}

--- Raw VLM response ---
```json
{
  "action": "click",
  "targetSelector": "#submit-btn",
  "value": null,
  "reasoning": "The DOM skeleton explicitly identifies a non-sensitive button element with the selector `#submit-btn` (ID: `el_1`), which is the target for submitting the form. No redaction conflicts exist, and the task explicitly requires clicking the submit button. This is the correct next action."
}
```
***/