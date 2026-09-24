/**
 * agent/contextManager.js
 *
 * Persistent Cross-Task Context Manager (v25 Part 3, Task 1.3):
 * IndexedDB-backed checkpoint/resume so switching between tasks — or
 * closing and reopening the popup — doesn't throw away everything
 * agent/taskManager.js (the plan) and agent/taskMemory.js (the short-term
 * action history) already know about a task in progress.
 *
 * agent/taskMemory.js's own header already covers in-memory short-term
 * memory for the CURRENT task, for the lifetime of one popup session
 * ("History = context, Live DOM = truth"). This module is the piece v25
 * specified that doesn't exist yet: durable storage across (a) switching
 * to a second task and later switching back, and (b) closing the popup
 * and reopening it later.
 *
 * Deliberately additive: TaskManager and TaskMemory are not modified.
 * Both classes already expose their state as plain public instance
 * properties (no private fields, no closures hiding the data), so
 * buildSnapshotFromLiveState() / applySnapshotToLiveState() below read and
 * write those properties directly rather than requiring new serialize()/
 * hydrate() methods on either class — lower risk of regressing already-
 * shipped, working code.
 *
 * PRIVACY: a checkpoint stores task planning/progress metadata (the
 * objective text, subgoal titles, action history, page URLs visited) —
 * the same category of information taskMemory.formatContext() already
 * puts in front of the reasoning model every step. It does NOT store PII
 * values: agent/privateDataStore.js (the actual private data) is
 * untouched by this module and is never written here. Checkpoints live
 * only in this browser's local IndexedDB; nothing in this module makes a
 * network request.
 */
(function (root) {
  const DB_NAME = 'PrivacyVisionAgentContext';
  const DB_VERSION = 1;
  const STORE_NAME = 'taskCheckpoints';

  function hasIndexedDb() {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch (_) {
      return false;
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!hasIndexedDb()) {
        reject(new Error('IndexedDB is not available in this context.'));
        return;
      }
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'taskId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB open request blocked (another tab holding an older version?).'));
    });
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  class ContextManager {
    constructor() {
      this._dbPromise = null;
      // Fail-closed-but-usable fallback: if IndexedDB genuinely can't be
      // opened (blocked storage, a private-browsing restriction, etc.),
      // checkpoints still work for the lifetime of this popup session via
      // an in-memory Map — never a silent no-op, and never an error every
      // caller has to specially handle. This is the same "fail closed,
      // never fail silently" precedent as models/ocr/README.md and
      // lib/webllm/README.md, adapted here to mean "degrade to
      // session-only and say so" rather than "refuse to run" — there's no
      // safety reason to refuse a checkpoint write, only a durability one.
      this._memoryFallback = new Map();
      this._usingFallback = false;
    }

    async _getDb() {
      if (this._usingFallback) return null;
      if (!this._dbPromise) {
        this._dbPromise = openDb().catch((err) => {
          console.warn(
            '[ContextManager] IndexedDB unavailable, falling back to in-memory (this-session-only) checkpoints:',
            err && err.message
          );
          this._usingFallback = true;
          return null;
        });
      }
      return this._dbPromise;
    }

    /** True once a real IndexedDB open failed and this instance is using the non-durable in-memory fallback. Surfaced in the popup UI so "resume later" isn't silently promised when it can't be kept. */
    isUsingDurableStorage() {
      return !this._usingFallback;
    }

    /**
     * @param {string} taskId
     * @param {object} [snapshot] Plain JSON-serializable checkpoint body,
     *   normally built with ContextManager.buildSnapshotFromLiveState().
     *   A `label`, `savedAt` (first save only) and `updatedAt` are
     *   attached automatically.
     * @returns {Promise<object>} The stored record.
     */
    async saveCheckpoint(taskId, snapshot = {}) {
      if (!taskId) throw new Error('ContextManager.saveCheckpoint requires a taskId.');
      const now = Date.now();
      const existing = await this.loadCheckpoint(taskId);
      const record = {
        taskId,
        label: snapshot.label || (existing && existing.label) || taskId,
        savedAt: (existing && existing.savedAt) || now,
        updatedAt: now,
        snapshot,
      };

      const db = await this._getDb();
      if (!db) {
        this._memoryFallback.set(taskId, record);
        return record;
      }

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      await promisifyRequest(store.put(record));
      return record;
    }

    /**
     * @param {string} taskId
     * @returns {Promise<object|null>} The full stored record
     *   ({taskId, label, savedAt, updatedAt, snapshot}), or null if no
     *   checkpoint exists yet for this taskId.
     */
    async loadCheckpoint(taskId) {
      if (!taskId) return null;
      const db = await this._getDb();
      if (!db) {
        return this._memoryFallback.get(taskId) || null;
      }
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const result = await promisifyRequest(store.get(taskId));
      return result || null;
    }

    /**
     * @returns {Promise<Array<{taskId, label, savedAt, updatedAt}>>}
     *   Metadata only (no snapshot body) for a "resume a previous task"
     *   list in the popup UI, newest-first.
     */
    async listCheckpoints() {
      const db = await this._getDb();
      let records;
      if (!db) {
        records = Array.from(this._memoryFallback.values());
      } else {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        records = await promisifyRequest(store.getAll());
      }
      return records
        .map((r) => ({ taskId: r.taskId, label: r.label, savedAt: r.savedAt, updatedAt: r.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async deleteCheckpoint(taskId) {
      if (!taskId) return;
      const db = await this._getDb();
      if (!db) {
        this._memoryFallback.delete(taskId);
        return;
      }
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      await promisifyRequest(store.delete(taskId));
    }

    /**
     * Switches the active task: checkpoints the outgoing task (if a
     * taskId + snapshot for it are given) then loads whatever checkpoint
     * already exists for the incoming task.
     *
     * @param {string} newTaskId
     * @param {{ currentTaskId?: string, currentSnapshot?: object }} [opts]
     * @returns {Promise<object|null>} The incoming task's stored
     *   checkpoint record, or null if it's a fresh task with no saved
     *   history yet (the normal, expected case for a brand-new task).
     */
    async switchTask(newTaskId, { currentTaskId, currentSnapshot } = {}) {
      if (!newTaskId) throw new Error('ContextManager.switchTask requires a newTaskId.');
      if (currentTaskId && currentSnapshot) {
        await this.saveCheckpoint(currentTaskId, currentSnapshot);
      }
      return this.loadCheckpoint(newTaskId);
    }

    /**
     * Builds a plain-object snapshot straight from a live TaskManager +
     * TaskMemory pair's public instance properties. Deliberately reads
     * the raw fields, not the classes' own summary methods
     * (getPlanSummary() / getSummary()) — those are lossy display
     * projections meant for a prompt string, whereas this needs enough to
     * fully reconstruct state via applySnapshotToLiveState() below.
     */
    static buildSnapshotFromLiveState({ taskManager, taskMemory, privacyDialMode, lastUrl, label } = {}) {
      const snapshot = {
        privacyDialMode: privacyDialMode || null,
        lastUrl: lastUrl || null,
        label: label || (taskManager && taskManager.task) || null,
      };

      if (taskManager) {
        snapshot.taskManagerState = {
          task: taskManager.task,
          objective: taskManager.objective,
          constraints: taskManager.constraints,
          subgoals: taskManager.subgoals,
          currentSubgoalIndex: taskManager.currentSubgoalIndex,
          collectedInfo: taskManager.collectedInfo,
          gatheredInformation: taskManager.gatheredInformation,
          completionCondition: taskManager.completionCondition,
          isVerifiedComplete: taskManager.isVerifiedComplete,
          replanHistory: taskManager.replanHistory,
        };
      }

      if (taskMemory) {
        snapshot.taskMemoryState = {
          pagesVisited: Array.from(taskMemory.pagesVisited || []),
          attemptedCount: taskMemory.attemptedCount,
          succeededCount: taskMemory.succeededCount,
          failedCount: taskMemory.failedCount,
          recentActions: taskMemory.recentActions,
          stateTransitions: taskMemory.stateTransitions,
          userInterventions: Array.from((taskMemory.userInterventions || new Map()).entries()),
          confirmations: taskMemory.confirmations,
          completedSubgoals: taskMemory.completedSubgoals,
          currentSubgoal: taskMemory.currentSubgoal,
          activeBlockers: taskMemory.activeBlockers,
          staleSelectors: Array.from(taskMemory.staleSelectors || []),
        };
      }

      return snapshot;
    }

    /**
     * Inverse of buildSnapshotFromLiveState(): restores a stored snapshot
     * onto already-constructed TaskManager/TaskMemory instances (call
     * `new TaskManager()` / `new TaskMemory()` first — this function does
     * not construct them, only populates them). A field missing from an
     * older/partial snapshot is left at whatever the fresh instance
     * already defaulted to, so restoring an older checkpoint degrades
     * gracefully instead of throwing.
     */
    static applySnapshotToLiveState({ taskManager, taskMemory, snapshot } = {}) {
      if (!snapshot) return;

      if (taskManager && snapshot.taskManagerState) {
        const s = snapshot.taskManagerState;
        if (s.task !== undefined) taskManager.task = s.task;
        if (s.objective !== undefined) taskManager.objective = s.objective;
        if (Array.isArray(s.constraints)) taskManager.constraints = s.constraints;
        if (Array.isArray(s.subgoals)) taskManager.subgoals = s.subgoals;
        if (typeof s.currentSubgoalIndex === 'number') taskManager.currentSubgoalIndex = s.currentSubgoalIndex;
        if (s.collectedInfo) taskManager.collectedInfo = s.collectedInfo;
        if (s.gatheredInformation) taskManager.gatheredInformation = s.gatheredInformation;
        if (s.completionCondition !== undefined) taskManager.completionCondition = s.completionCondition;
        taskManager.isVerifiedComplete = Boolean(s.isVerifiedComplete);
        if (Array.isArray(s.replanHistory)) taskManager.replanHistory = s.replanHistory;
      }

      if (taskMemory && snapshot.taskMemoryState) {
        const s = snapshot.taskMemoryState;
        taskMemory.pagesVisited = new Set(Array.isArray(s.pagesVisited) ? s.pagesVisited : []);
        taskMemory.attemptedCount = s.attemptedCount || 0;
        taskMemory.succeededCount = s.succeededCount || 0;
        taskMemory.failedCount = s.failedCount || 0;
        taskMemory.recentActions = Array.isArray(s.recentActions) ? s.recentActions : [];
        taskMemory.stateTransitions = Array.isArray(s.stateTransitions) ? s.stateTransitions : [];
        taskMemory.userInterventions = new Map(Array.isArray(s.userInterventions) ? s.userInterventions : []);
        taskMemory.confirmations = Array.isArray(s.confirmations) ? s.confirmations : [];
        taskMemory.completedSubgoals = Array.isArray(s.completedSubgoals) ? s.completedSubgoals : [];
        taskMemory.currentSubgoal = s.currentSubgoal || null;
        taskMemory.activeBlockers = Array.isArray(s.activeBlockers) ? s.activeBlockers : [];
        taskMemory.staleSelectors = new Set(Array.isArray(s.staleSelectors) ? s.staleSelectors : []);
      }
    }

    /** Deterministic-enough taskId derived from the task text plus a start timestamp, so the same task text started twice doesn't collide. */
    static generateTaskId(taskText) {
      const slug = (taskText || 'task')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 60)
        .replace(/^-+|-+$/g, '') || 'task';
      return `${slug}_${Date.now()}`;
    }
  }

  root.__BA_ContextManager = ContextManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ContextManager };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
