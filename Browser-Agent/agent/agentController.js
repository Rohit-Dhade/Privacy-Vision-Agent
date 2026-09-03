/**
 * agent/agentController.js
 *
 * General-Purpose Agent Controller
 *
 * Orchestrates the explicit task lifecycle state machine:
 *   OBSERVE -> UNDERSTAND -> PLAN -> VALIDATE -> EXECUTE -> VERIFY -> UPDATE -> CONTINUE/COMPLETE
 */
(function (root) {
  const STATES = root.__BA_STATES || (typeof require !== 'undefined' ? require('./stateManager.js').STATES : {});
  const StateManager = root.__BA_StateManager || (typeof require !== 'undefined' ? require('./stateManager.js').StateManager : null);
  const TaskManager = root.__BA_TaskManager || (typeof require !== 'undefined' ? require('./taskManager.js').TaskManager : null);

  class AgentController {
    constructor() {
      this.stateManager = StateManager ? new StateManager() : new root.__BA_StateManager();
      this.taskManager = TaskManager ? new TaskManager() : new root.__BA_TaskManager();
      this.lastExtraction = null;
    }

    get state() {
      return this.stateManager.current;
    }

    onStateChange(fn) {
      this.stateManager.onChange(fn);
    }

    startTask(taskText) {
      this.stateManager.reset();
      this.taskManager.setTask(taskText);
      this.stateManager.transition(STATES.PLANNING);
    }

    beginObserving() {
      this.stateManager.transition(STATES.OBSERVING);
    }

    beginUnderstanding(extractionResult) {
      this.lastExtraction = extractionResult;
      this.stateManager.transition(STATES.UNDERSTANDING);
    }

    beginPlanning() {
      this.stateManager.transition(STATES.PLANNING);
    }

    waitForReasoner() {
      this.stateManager.transition(STATES.WAITING_FOR_REASONER);
    }

    beginValidating() {
      this.stateManager.transition(STATES.VALIDATING_ACTION);
    }

    beginExecuting(action) {
      this.stateManager.transition(STATES.EXECUTING_ACTION);
    }

    beginVerifying(action) {
      this.stateManager.transition(STATES.VERIFYING_ACTION);
    }

    waitForUser(fields) {
      this.stateManager.transition(STATES.WAITING_FOR_USER);
    }

    waitForConfirmation(consequential) {
      this.stateManager.transition(STATES.WAITING_FOR_CONFIRMATION);
    }

    triggerReplanning(reason) {
      this.stateManager.transition(STATES.REPLANNING);
    }

    markCompleted() {
      this.stateManager.transition(STATES.COMPLETED);
      this.taskManager.clearCollectedInfo();
    }

    markBlocked(reason) {
      this.stateManager.transition(STATES.BLOCKED);
    }

    markFailed(err) {
      this.stateManager.transition(STATES.FAILED);
      return err;
    }

    markStopped(reason) {
      this.stateManager.transition(STATES.STOPPED);
    }

    // ── Backward Compatible Legacy Aliases ───────────────────────────────────
    beginPageAnalysis() { this.beginObserving(); }
    onDomExtracted() { /* tracked in OBSERVING */ }
    onPiiDetected() { /* tracked in OBSERVING */ }
    onScreenshotCaptured() { /* tracked in OBSERVING */ }
    onScreenshotRedacted() { /* tracked in OBSERVING */ }
    evaluateReadiness(extractionResult) { this.beginUnderstanding(extractionResult); }
    submitUserInfo(values) {
      this.taskManager.recordUserInfo(values);
      this.stateManager.transition(STATES.UNDERSTANDING);
    }
    markExecuting() { this.beginExecuting(); }
    beginActionExecution(action) { this.beginExecuting(action); }
    markWaitingForUser() { this.waitForUser(); }
    markError(err) { return this.markFailed(err); }

    reset() {
      this.stateManager.reset();
      this.taskManager.clearCollectedInfo();
      this.lastExtraction = null;
    }
  }

  root.__BA_AgentController = AgentController;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentController };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));