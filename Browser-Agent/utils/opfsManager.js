/**
 * utils/opfsManager.js
 *
 * OPFS storage status (claude/v25-master-implementation-guide.md Part 3,
 * Task 1.2 — "OPFS Storage System"). v25's own architecture doc (Part 2,
 * "Memory Management") already settles what actually manages the model
 * cache: WebLLM (agent/webllmEngine.js, once vendored — see
 * lib/webllm/README.md) handles OPFS-backed model-weight caching
 * automatically — download once, cache forever, no manual cache-key
 * bookkeeping needed on this extension's side. Building a second, custom
 * cache manager that duplicates that would repeat exactly the mistake
 * v25 Part 9 names as a lesson already learned ("Building Custom Wheels
 * ... Prefer proven libraries over custom implementations").
 *
 * What this module actually is, then: a thin, honest wrapper around the
 * two OPFS-adjacent questions this extension can usefully answer WITHOUT
 * reaching into WebLLM's own private cache internals or assuming
 * anything about its file layout — (1) does OPFS exist at all in this
 * browser (see also utils/featureDetection.js's detectOPFS(), which this
 * duplicates on purpose so this file has no load-order dependency on
 * that one), and (2) how much of this origin's storage quota is already
 * used versus free, which matters directly here since the on-device
 * model WebLLM requests is roughly 500MB-800MB (see
 * lib/webllm/README.md) — worth surfacing before that download starts,
 * not after it fails partway through a nearly-full quota.
 *
 * fileExists() below is a genuinely separate, generic OPFS existence
 * check — not tied to WebLLM's cache at all, since this extension
 * doesn't know or assume WebLLM's internal file naming. It exists for
 * this extension's own possible future direct OPFS use; nothing in this
 * codebase calls it yet.
 *
 * Honesty note: unverified in a real browser for the same reason as
 * utils/featureDetection.js (no browser in this sandbox). formatQuotaSummary()'s
 * pure formatting logic is unit-tested against synthetic input; the
 * actual navigator.storage calls are not.
 */
(function (root) {
  function isSupported() {
    try {
      return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
    } catch (_) {
      return false;
    }
  }

  /**
   * @returns {Promise<{supported: boolean, usageBytes: number|null, quotaBytes: number|null, usageRatio: number|null, error: string|null}>}
   */
  async function checkStorageQuota() {
    if (!isSupported()) {
      return { supported: false, usageBytes: null, quotaBytes: null, usageRatio: null, error: 'OPFS/StorageManager is not available in this browser.' };
    }
    if (typeof navigator.storage.estimate !== 'function') {
      return { supported: true, usageBytes: null, quotaBytes: null, usageRatio: null, error: 'navigator.storage.estimate() is not available — OPFS itself is supported, but quota cannot be measured.' };
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const usageBytes = typeof usage === 'number' ? usage : null;
      const quotaBytes = typeof quota === 'number' ? quota : null;
      const usageRatio = (usageBytes != null && quotaBytes) ? usageBytes / quotaBytes : null;
      return { supported: true, usageBytes, quotaBytes, usageRatio, error: null };
    } catch (err) {
      return { supported: true, usageBytes: null, quotaBytes: null, usageRatio: null, error: err.message };
    }
  }

  /**
   * Best-effort existence check for a named file directly under the OPFS
   * root (or a given subdirectory path). Deliberately generic — this is
   * NOT a WebLLM cache lookup; see this file's header for why.
   *
   * @param {string} fileName
   * @param {string[]} [dirPath] - subdirectory path segments; root if omitted
   * @returns {Promise<boolean>}
   */
  async function fileExists(fileName, dirPath = []) {
    if (!isSupported() || !fileName) return false;
    try {
      let dir = await navigator.storage.getDirectory();
      for (const segment of dirPath) {
        dir = await dir.getDirectoryHandle(segment, { create: false });
      }
      await dir.getFileHandle(fileName, { create: false });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Pure formatting: turns a checkStorageQuota() result into one
   * human-readable line for a settings/status panel.
   *
   * @param {{supported: boolean, usageBytes: number|null, quotaBytes: number|null, usageRatio: number|null, error: string|null}} quota
   * @returns {string}
   */
  function formatQuotaSummary(quota) {
    if (!quota || !quota.supported) {
      return 'Persistent on-device model storage (OPFS) is not available in this browser.';
    }
    if (quota.usageBytes == null || quota.quotaBytes == null) {
      return 'OPFS is available, but storage usage could not be measured' + (quota.error ? ` (${quota.error})` : '') + '.';
    }
    const usedMB = Math.round(quota.usageBytes / (1024 * 1024));
    const quotaMB = Math.round(quota.quotaBytes / (1024 * 1024));
    const pct = quota.usageRatio != null ? Math.round(quota.usageRatio * 100) : null;
    return `${usedMB}MB used of ${quotaMB}MB available${pct != null ? ` (${pct}%)` : ''} in this origin's storage. ` +
      `The on-device model WebLLM requests, once vendored (see lib/webllm/README.md), is roughly 500MB-800MB.`;
  }

  root.__BA_OpfsManager = {
    isSupported,
    checkStorageQuota,
    fileExists,
    formatQuotaSummary,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__BA_OpfsManager;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
