---
trigger: always_on
---

We are going to incrementally enhance the existing browser-agent project.

**IMPORTANT: This is an enhancement task, NOT a rewrite or architectural migration.**

Before making any changes, scan and understand the existing repository and follow the current architecture.

The existing system is already working and contains:

* Browser extension frontend
* Content scripts
* Background/service worker
* Existing screenshot capture
* Local PII detection
* Local face detection
* Local redaction/sanitization
* DOM extraction
* Remote LLM/VLM agent reasoning
* Existing action validation
* Existing browser action execution
* Existing Human-in-the-Loop (HITL) workflow
* Existing UI/UX for highlighting fields and guiding the user

These existing capabilities must continue working.

## PRIMARY RULE

**Do not replace the existing architecture. Extend it.**

Make the smallest, cleanest changes necessary to introduce the new functionality.

Do NOT:

* rewrite the extension architecture
* replace the frontend framework
* replace the service worker/content-script architecture
* replace the existing PII/redaction pipeline
* replace the existing VLM
* replace the existing LLM unless absolutely unavoidable
* replace the existing backend
* redesign the communication protocol unnecessarily
* remove working functionality
* duplicate existing functionality
* introduce a second parallel architecture for something that already exists

Prefer:

* extending existing functions
* extending existing schemas
* adding small modules where separation is genuinely useful
* reusing existing state management
* reusing existing action execution
* reusing existing HITL UI
* reusing existing DOM extraction
* reusing existing privacy mechanisms

Before modifying a file, understand how it currently participates in the system.

If an existing function can be extended safely, extend it rather than creating a duplicate implementation.

If an architectural change appears necessary, STOP and explain why before making that change.

---

# NEW FUNCTIONALITY WE ARE BUILDING

We want to evolve the current browser agent into a more context-aware agent with two execution modes.

## MODE 1 — Human-in-the-Loop (HITL)

This is the EXISTING behavior and must remain functional.

Example:

User asks:

"Complete this form."

Agent analyzes the form.

If a field requires user input:

1. Identify the field.
2. Tell the user what needs to be filled.
3. Use the existing field-highlighting / visual-guide UI.
4. User manually enters the information.
5. User resumes the agent.
6. Agent analyzes the updated page.
7. Continue until the task is complete.

Do NOT remove or redesign this existing workflow.

---

# MODE 2 — Complete Agent Mode

Add a second mode where the user can explicitly instruct the agent to complete a task automatically when possible.

Example:

"Complete this form using my stored information."

The agent should:

1. Understand the current form.
2. Identify the fields.
3. Determine what information each field requires.
4. Check whether the required information exists in the LOCAL private information store.
5. If it exists, fill the field locally.
6. If it does not exist, fall back to the existing HITL workflow.
7. Ask the user for the missing information using the existing highlighting/UI system.
8. Resume automatically after the user provides the missing information.
9. Continue processing remaining fields.
10. Finish when the form/task is complete.

---

# LOCAL PRIVATE INFORMATION STORE

Introduce a small local key-value data layer.

Example:

```text
name       → user value
email      → user value
phone      → user value
address    → user value
college    → user value
company    → user value
etc.
```

The user should be able to store arbitrary personal information.

IMPORTANT PRIVACY REQUIREMENT:

The actual values in this store must remain LOCAL to the browser/device.

The values must NEVER be included in:

* LLM prompts
* VLM prompts
* AI context
* backend requests
* action history sent to the server
* server logs
* telemetry
* network payloads

The remote LLM/VLM must never receive the actual stored values.

---

# REMOTE AI / LOCAL DATA SEPARATION

The remote LLM should reason about WHAT needs to be done, not the private value itself.

BAD:

```json
{
  "action": "fill",
  "target": "#email",
  "value": "actual-user-email"
}
```

GOOD:

```json
{
  "action": "fill_from_local",
  "targetSelector": "#email"
}
```

The local browser execution layer should then:

1. Determine what semantic information the field requires.
2. Match it against the local information store.
3. Retrieve the actual value locally.
4. Fill the DOM locally.

The actual value should never enter the remote AI context.

---

# IMPORTANT SECOND PRIVACY BOUNDARY

After local automatic filling, the actual value will exist in the webpage.

Example:

```text
Local store
    ↓
Local DOM fill
    ↓
Email field contains actual email
    ↓
Screenshot captured
```

Before any screenshot/context is sent remotely, the EXISTING local PII detection and redaction pipeline must continue to sanitize that information.

Do not bypass or weaken the existing privacy pipeline.

The intended flow is:

```text
Local Data Store
      ↓
Local DOM Fill
      ↓
Actual PII appears in webpage
      ↓
Existing local PII detection
      ↓
Existing local redaction
      ↓
Sanitized screenshot/context
      ↓
Remote LLM
```

---

# CONTEXT AWARENESS IMPROVEMENTS

Improve the existing context passed to the remote agent without replacing the current context pipeline.

Where appropriate, preserve useful semantic information that is already extracted locally, such as:

* element text
* aria-label
* placeholder
* semantic field type
* button labels
* link labels
* form information
* element state
* bounding boxes

Currently some useful information is extracted but stripped before the LLM context is built.

Prefer extending the existing DOM skeleton rather than creating a completely new extraction system.

---

# USER INTERACTION AWARENESS

Add lightweight tracking of relevant user interactions where it fits naturally into the existing extension architecture.

Examples:

* user clicked an element
* user typed into a field
* user changed a field
* user scrolled
* user navigated

Do not build a huge analytics system.

The purpose is only to give the agent enough context to understand what the user has done between agent steps.

Do not record or transmit actual sensitive values.

For typing events, record metadata such as:

```text
user edited element #5
```

rather than:

```text
user typed "actual sensitive value"
```

---

# BASIC PREVIOUS-STATE / STATE-DIFF AWARENESS

Extend the current agent loop so it can maintain a lightweight previous page state.

We do NOT need a complicated memory architecture.

The system should be able to identify useful changes such as:

```text
URL changed
new form appeared
field became populated
button appeared/disappeared
error message appeared
page section changed
```

Conceptually:

```text
Previous State
      ↓
Current State
      ↓
State Diff
      ↓
Context for agent
```

Reuse existing extraction/state mechanisms wherever possible.

---

# CONTEXT-AWARE SUGGESTIONS

The existing agent primarily produces low-level actions such as:

* click
* fill
* scroll
* wait
* done

Keep these actions working.

But improve the reasoning context so the agent can produce more meaningful suggestions when appropriate.

Examples:

Instead of simply:

"Fill this field."

the system should be capable of understanding:

"This form has 5 fields; 4 can be completed from local information and 1 requires user input."

Or:

"The previous action moved the workflow to the shipping-address step."

The suggestion system should remain compatible with the existing action execution architecture.

Do not build an unrelated recommendation engine.

---

# AGENT LOOP

The desired enhanced flow is:

```text
Observe
   ↓
Understand current context
   ↓
Consider task + previous state + relevant user/agent actions
   ↓
Decide next step
   ↓
If automatic:
    execute locally
   ↓
If information is missing:
    use existing HITL UI
   ↓
Observe updated page
   ↓
Detect state changes
   ↓
Continue
   ↓
Complete
```

The existing agent loop should be extended rather than replaced.

---

# IMPLEMENTATION PRINCIPLES

1. First inspect the repository.
2. Identify the exact existing files/functions responsible for each capability.
3. Reuse them.
4. Make incremental changes.
5. Keep interfaces backward compatible where practical.
6. Keep existing behavior working.
7. Avoid unnecessary dependencies.
8. Avoid unnecessary architectural layers.
9. Do not duplicate existing logic.
10. Keep privacy-sensitive data entirely local.
11. Do not send local-store values to either AI.
12. Do not put actual user-entered values into action history sent to the backend.
13. Preserve the existing extension/frontend integration.

## BEFORE CODING

First give me:

1. Current architecture relevant to these changes.
2. Files you intend to modify.
3. Files you intend to add.
4. How each new feature will integrate with the existing implementation.
5. Any potential architectural risks.

Then implement incrementally.

Do not make unrelated changes.
Do not refactor unrelated code.
Do not rewrite working components just for style.

The goal is:

**"Extend the current working browser agent into a context-aware dual-mode agent while preserving the existing architecture and behavior."**
