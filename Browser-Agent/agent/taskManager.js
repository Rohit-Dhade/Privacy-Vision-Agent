/**
 * agent/taskManager.js
 *
 * General Hierarchical Task Planning & Lifecycle Management
 * Decomposes natural-language user requests into:
 *   USER GOAL
 *     ↓
 *   SUBGOALS
 *     ↓
 *   ACTIONS
 *
 * Tracks:
 * - objective & extracted constraints
 * - provisional subgoals & progress
 * - completion condition verification
 * - gathered information & extracted data
 * - dynamic replanning on obstacle or failure
 */
(function (root) {
  function extractConstraints(text) {
    const constraints = [];
    if (!text) return constraints;

    // Price constraints: e.g. "under ₹5000", "< $100", "below 500"
    const priceMatch = text.match(/(under|below|less than|max(?:imum)?|cheaper than)\s*([₹$€£]?\s*\d+(?:,\d+)?)/i);
    if (priceMatch) constraints.push(`Price: ${priceMatch[0]}`);

    // Time/date constraints: e.g. "tomorrow", "next week", "on Monday"
    const dateMatch = text.match(/\b(today|tomorrow|yesterday|next week|this weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (dateMatch) constraints.push(`Date/Timing: ${dateMatch[0]}`);

    // Optimization constraints: e.g. "cheapest", "fastest", "highest rated"
    const optMatch = text.match(/\b(cheapest|lowest price|fastest|highest rated|best rated|nearest|shortest)\b/i);
    if (optMatch) constraints.push(`Preference: ${optMatch[0]}`);

    // Domain specific: origin/destination
    const fromToMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|tomorrow|today|under|below)|$)/i);
    if (fromToMatch) {
      constraints.push(`Route: from ${fromToMatch[1].trim()} to ${fromToMatch[2].trim()}`);
    }

    return constraints;
  }

  /**
   * Resolves a target navigation URL from a natural language user instruction
   * when navigation is required (e.g. starting from an internal chrome:// or blank page).
   */
  function resolveNavigationUrl(taskText) {
    if (!taskText || typeof taskText !== 'string') return null;
    const text = taskText.trim();
    const lower = text.toLowerCase();

    // 1. Direct full URL in prompt (e.g. "https://leetcode.com", "http://localhost:8000/testing-form.html")
    const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      return { url: urlMatch[0], siteName: urlMatch[0], isDirectUrl: true };
    }

    // 2. Explicit domain pattern in prompt (e.g. "leetcode.com", "www.amazon.in", "github.com")
    const domainMatch = text.match(/\b(?:www\.)?([a-zA-Z0-9-]+\.(?:com|org|net|in|io|dev|edu|gov|co|ai|app|tech)(?:\/[^\s"'<>]*)?)/i);
    if (domainMatch) {
      return { url: `https://${domainMatch[0]}`, siteName: domainMatch[1], isDirectUrl: false };
    }

    // 3. Search query directives (e.g. "search for laptops on amazon", "search for AI on google")
    const googleSearchMatch = text.match(/(?:search|look)\s+(?:for\s+)?(.+?)\s+on\s+google/i);
    if (googleSearchMatch) {
      const q = encodeURIComponent(googleSearchMatch[1].trim());
      return { url: `https://www.google.com/search?q=${q}`, siteName: 'Google Search', isSearch: true };
    }

    const amazonSearchMatch = text.match(/(?:search|look|find)\s+(?:for\s+)?(.+?)\s+on\s+amazon/i);
    if (amazonSearchMatch) {
      const q = encodeURIComponent(amazonSearchMatch[1].trim());
      return { url: `https://www.amazon.com/s?k=${q}`, siteName: 'Amazon Search', isSearch: true };
    }

    // 4. Well-known named service mapping
    const WELL_KNOWN_SITES = [
      { name: 'leetcode', patterns: [/\bleetcode\b/i], url: 'https://leetcode.com' },
      { name: 'google', patterns: [/\bgoogle\b/i], url: 'https://www.google.com' },
      { name: 'amazon', patterns: [/\bamazon\b/i], url: 'https://www.amazon.com' },
      { name: 'github', patterns: [/\bgithub\b/i], url: 'https://github.com' },
      { name: 'wikipedia', patterns: [/\bwikipedia\b/i], url: 'https://www.wikipedia.org' },
      { name: 'youtube', patterns: [/\byoutube\b/i], url: 'https://www.youtube.com' },
      { name: 'reddit', patterns: [/\breddit\b/i], url: 'https://www.reddit.com' },
      { name: 'twitter', patterns: [/\btwitter\b/i, /\bx\.com\b/i], url: 'https://x.com' },
      { name: 'hackernews', patterns: [/\bhacker\s*news\b/i], url: 'https://news.ycombinator.com' },
      { name: 'stackoverflow', patterns: [/\bstack\s*overflow\b/i], url: 'https://stackoverflow.com' },
      { name: 'coursera', patterns: [/\bcoursera\b/i], url: 'https://www.coursera.org' },
      { name: 'nptel', patterns: [/\bnptel\b/i], url: 'https://nptel.ac.in' },
      { name: 'zerodha', patterns: [/\bzerodha\b/i], url: 'https://zerodha.com' },
      { name: 'linkedin', patterns: [/\blinkedin\b/i], url: 'https://www.linkedin.com' },
      { name: 'mdn', patterns: [/\bmdn\b/i, /\bmozilla\s*docs\b/i], url: 'https://developer.mozilla.org' }
    ];

    // Check if task contains explicit navigation intent: "open", "go to", "navigate to", "visit", "launch"
    const hasNavIntent = /(open|go to|navigate to|visit|launch|check|access|load)/i.test(lower);

    for (const site of WELL_KNOWN_SITES) {
      if (site.patterns.some(p => p.test(lower))) {
        if (hasNavIntent || lower.startsWith(site.name) || lower.includes(`on ${site.name}`)) {
          return { url: site.url, siteName: site.name, isWellKnown: true };
        }
      }
    }

    return null;
  }

  function decomposeTaskIntoSubgoals(taskText, pageContext) {
    const text = (taskText || '').trim();
    const lower = text.toLowerCase();

    // 1. Search, Find, Filter, or Comparison task
    if (/(find|search|look for|compare|check price|show me|cheapest|lowest)/i.test(lower)) {
      return [
        { id: 'sg_1', title: 'Locate Search', description: 'Locate search inputs or search interface', status: 'IN_PROGRESS', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_2', title: 'Enter Query & Criteria', description: 'Enter search parameters and filter criteria', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_3', title: 'Execute Search', description: 'Trigger search and wait for results to populate', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_4', title: 'Evaluate Results', description: 'Read candidate items and filter against constraints', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_5', title: 'Verify & Present', description: 'Select and present final verified answer/item', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false }
      ];
    }

    // 2. Form completion or KYC task
    if (/(complete|fill|sign up|register|apply|kyc|checkout)/i.test(lower)) {
      return [
        { id: 'sg_1', title: 'Inspect Form', description: 'Identify required form fields and dropdowns', status: 'IN_PROGRESS', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_2', title: 'Populate Information', description: 'Fill values from local store or gather from user', status: 'PENDING', requiresUserInput: true, requiresConfirmation: false },
        { id: 'sg_3', title: 'Review Entries', description: 'Verify all required fields have valid populated values', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_4', title: 'Authorize Submission', description: 'Seek human confirmation for final submission', status: 'PENDING', requiresUserInput: false, requiresConfirmation: true }
      ];
    }

    // 3. Navigation or Multi-step exploration
    if (/(go to|navigate|open|click|toggle|switch)/i.test(lower)) {
      return [
        { id: 'sg_1', title: 'Navigate / Locate', description: 'Reach target page section or control', status: 'IN_PROGRESS', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_2', title: 'Interact', description: 'Perform required interaction sequence', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
        { id: 'sg_3', title: 'Verify Progress', description: 'Verify expected page state mutation', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false }
      ];
    }

    // 4. Default general task decomposition
    return [
      { id: 'sg_1', title: 'Understand Page', description: 'Analyze current page elements and layout', status: 'IN_PROGRESS', requiresUserInput: false, requiresConfirmation: false },
      { id: 'sg_2', title: 'Perform Actions', description: 'Execute action sequence to advance task objective', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false },
      { id: 'sg_3', title: 'Verify Goal', description: 'Confirm task completion condition is fully satisfied', status: 'PENDING', requiresUserInput: false, requiresConfirmation: false }
    ];
  }

  class TaskManager {
    constructor() {
      this.task = null;
      this.objective = null;
      this.constraints = [];
      this.subgoals = [];
      this.currentSubgoalIndex = 0;
      this.collectedInfo = {};
      this.gatheredInformation = {};
      this.completionCondition = null;
      this.isVerifiedComplete = false;
      this.replanHistory = [];
    }

    setTask(taskText, pageContext = null) {
      this.task = (taskText || '').trim();
      this.objective = this.task;
      this.constraints = extractConstraints(this.task);
      this.subgoals = decomposeTaskIntoSubgoals(this.task, pageContext);
      this.currentSubgoalIndex = 0;
      this.collectedInfo = {};
      this.gatheredInformation = {};
      this.completionCondition = `Task "${this.task}" verified complete with satisfied criteria.`;
      this.isVerifiedComplete = false;
      this.replanHistory = [];
      return this.task;
    }

    get activeSubgoal() {
      return this.subgoals[this.currentSubgoalIndex] || null;
    }

    advanceSubgoal(reason = '') {
      if (this.currentSubgoalIndex < this.subgoals.length) {
        this.subgoals[this.currentSubgoalIndex].status = 'COMPLETED';
        this.currentSubgoalIndex++;
        if (this.currentSubgoalIndex < this.subgoals.length) {
          this.subgoals[this.currentSubgoalIndex].status = 'IN_PROGRESS';
        }
      }
    }

    recordGatheredInfo(keyOrObject, value = undefined) {
      if (typeof keyOrObject === 'object' && keyOrObject !== null) {
        this.gatheredInformation = { ...this.gatheredInformation, ...keyOrObject };
      } else if (typeof keyOrObject === 'string') {
        this.gatheredInformation[keyOrObject] = value;
      }
    }

    recordUserInfo(values) {
      this.collectedInfo = { ...this.collectedInfo, ...values };
    }

    clearCollectedInfo() {
      this.collectedInfo = {};
      this.gatheredInformation = {};
    }

    replan(reason, pageContext = null) {
      this.replanHistory.push({
        timestamp: Date.now(),
        reason,
        atSubgoalIndex: this.currentSubgoalIndex
      });

      // If obstacle is active modal, prepend modal resolution subgoal
      if (pageContext?.activeModal?.isOpen) {
        const modalSubgoal = {
          id: `modal_${Date.now()}`,
          title: 'Resolve Active Modal',
          description: `Interact with or dismiss active modal dialog ("${pageContext.activeModal.title || 'Dialog'}")`,
          status: 'IN_PROGRESS',
          requiresUserInput: false,
          requiresConfirmation: false
        };
        if (this.subgoals[this.currentSubgoalIndex]) {
          this.subgoals[this.currentSubgoalIndex].status = 'PENDING';
        }
        this.subgoals.splice(this.currentSubgoalIndex, 0, modalSubgoal);
        return;
      }

      // If an action failed, ensure current subgoal records recovery
      if (this.activeSubgoal) {
        this.activeSubgoal.recoveryNote = reason;
      }
    }

    updateProgress({ action, outcome, verified, plan, extractedData }) {
      if (extractedData) {
        this.recordGatheredInfo(extractedData);
      }

      if (plan?.gatheredInfo) {
        this.recordGatheredInfo(plan.gatheredInfo);
      }

      if (plan?.subgoalCompleted) {
        this.advanceSubgoal('Model indicated subgoal completion');
      }

      // If action is done and criteria met
      if (action === 'done' || plan?.isTaskComplete) {
        this.isVerifiedComplete = true;
        this.subgoals.forEach(sg => { if (sg.status !== 'COMPLETED') sg.status = 'COMPLETED'; });
      }
    }

    getPlanSummary() {
      return {
        objective: this.objective,
        constraints: this.constraints,
        currentSubgoal: this.activeSubgoal ? this.activeSubgoal.description : 'All subgoals completed',
        currentSubgoalIndex: this.currentSubgoalIndex,
        totalSubgoals: this.subgoals.length,
        subgoals: this.subgoals.map(s => ({
          id: s.id,
          title: s.title,
          description: s.description,
          status: s.status
        })),
        gatheredInformation: this.gatheredInformation,
        isTaskComplete: this.isVerifiedComplete || (this.currentSubgoalIndex >= this.subgoals.length)
      };
    }

    formatPlanSummary() {
      const summary = this.getPlanSummary();
      let lines = [`📋 **Plan: ${summary.objective}**`];
      if (summary.constraints.length > 0) {
        lines.push(`*Constraints:* ${summary.constraints.join(', ')}`);
      }
      lines.push('*Subgoals:*');
      summary.subgoals.forEach((sg, idx) => {
        const icon = sg.status === 'COMPLETED' ? '✅' : (sg.status === 'IN_PROGRESS' ? '👉' : '⏳');
        lines.push(`${icon} **Step ${idx + 1}:** ${sg.description}`);
      });
      return lines.join('\n');
    }
  }

  TaskManager.resolveNavigationUrl = resolveNavigationUrl;
  root.__BA_TaskManager = TaskManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TaskManager, resolveNavigationUrl };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));