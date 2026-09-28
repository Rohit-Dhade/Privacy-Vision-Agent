/**
 * agent/privateDataStore.js
 *
 * Local Private Information Store
 *
 * A small browser-local key-value data layer for storing personal information
 * (e.g. name, email, phone, address, college, arbitrary keys) entirely on-device.
 *
 * PRIVACY GUARANTEES:
 * 1. Storage is strictly local to the browser using `chrome.storage.local`.
 * 2. Values in this store are NEVER sent to any remote LLM/VLM, backend endpoint,
 *    telemetry, action history, or network request.
 * 3. Actual private values are NEVER logged to console/debug outputs.
 */
(function (root) {
  const STORAGE_KEY = 'pv_private_store';

  class PrivateDataStore {
    constructor() {
      this._storageKey = STORAGE_KEY;
    }

    /**
     * Internal helper to load the entire key-value dictionary from chrome.storage.local.
     * @private
     * @returns {Promise<Record<string, string>>}
     */
    async _readStore() {
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get([this._storageKey], (result) => {
              if (chrome.runtime && chrome.runtime.lastError) {
                console.warn('[PrivateDataStore] Error reading local store:', chrome.runtime.lastError.message);
                resolve({});
                return;
              }
              const store = result && result[this._storageKey];
              resolve(store && typeof store === 'object' ? { ...store } : {});
            });
          } else {
            // Fallback for non-extension / dev environments
            const raw = localStorage.getItem(this._storageKey);
            resolve(raw ? JSON.parse(raw) : {});
          }
        } catch (err) {
          console.warn('[PrivateDataStore] Read failed:', err.message);
          resolve({});
        }
      });
    }

    /**
     * Internal helper to persist the dictionary to chrome.storage.local.
     * @private
     * @param {Record<string, string>} store
     * @returns {Promise<void>}
     */
    async _writeStore(store) {
      return new Promise((resolve, reject) => {
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [this._storageKey]: store }, () => {
              if (chrome.runtime && chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve();
            });
          } else {
            localStorage.setItem(this._storageKey, JSON.stringify(store));
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    /**
     * Determines whether a stored value is valid and available (non-empty).
     * Missing: undefined, null, empty string, whitespace-only string.
     * Legitimate: boolean (false/true), numbers (0, etc.), non-empty strings.
     * @param {any} val
     * @returns {boolean}
     */
    static isValueAvailable(val) {
      if (val === undefined || val === null) return false;
      if (typeof val === 'string') {
        return val.trim().length > 0;
      }
      if (typeof val === 'boolean' || typeof val === 'number') {
        return true;
      }
      return false;
    }

    /**
     * Retrieves all stored key-value pairs with non-empty values.
     * @returns {Promise<Record<string, string>>}
     */
    async getAll() {
      const store = await this._readStore();
      const clean = {};
      for (const [k, v] of Object.entries(store)) {
        if (PrivateDataStore.isValueAvailable(v)) {
          clean[k] = v;
        }
      }
      return clean;
    }

    /**
     * Retrieves all stored keys that have non-empty available values.
     * @returns {Promise<string[]>}
     */
    async getAllKeys() {
      const store = await this._readStore();
      return Object.keys(store).filter((k) => PrivateDataStore.isValueAvailable(store[k]));
    }

    /**
     * Retrieves the stored value for a specific key.
     * Returns null if missing or empty/whitespace.
     * @param {string} key
     * @returns {Promise<string | null>}
     */
    async get(key) {
      if (!key || typeof key !== 'string') return null;
      const normalizedKey = key.trim().toLowerCase();
      const store = await this._readStore();
      if (!Object.prototype.hasOwnProperty.call(store, normalizedKey)) return null;
      const val = store[normalizedKey];
      return PrivateDataStore.isValueAvailable(val) ? val : null;
    }

    /**
     * Checks if a key exists in the local store AND has a non-empty available value.
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async has(key) {
      if (!key || typeof key !== 'string') return false;
      const normalizedKey = key.trim().toLowerCase();
      const store = await this._readStore();
      if (!Object.prototype.hasOwnProperty.call(store, normalizedKey)) return false;
      return PrivateDataStore.isValueAvailable(store[normalizedKey]);
    }

    /**
     * Stores or updates a key-value entry locally.
     * @param {string} key
     * @param {string} value
     * @returns {Promise<void>}
     */
    async set(key, value) {
      if (!key || typeof key !== 'string') {
        throw new Error('Invalid key: key must be a non-empty string.');
      }
      const normalizedKey = key.trim().toLowerCase();
      if (!normalizedKey) {
        throw new Error('Key cannot be empty.');
      }

      const store = await this._readStore();
      store[normalizedKey] = typeof value === 'string' ? value : String(value ?? '');
      await this._writeStore(store);

      // Metadata log only: NEVER log the value
      console.log(`[PrivateDataStore] Saved local entry for key: "${normalizedKey}"`);
    }

    /**
     * Removes a key-value entry from local storage.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async remove(key) {
      if (!key || typeof key !== 'string') return;
      const normalizedKey = key.trim().toLowerCase();
      const store = await this._readStore();
      if (Object.prototype.hasOwnProperty.call(store, normalizedKey)) {
        delete store[normalizedKey];
        await this._writeStore(store);
        console.log(`[PrivateDataStore] Removed local entry for key: "${normalizedKey}"`);
      }
    }

    /**
     * Wipes all entries from the local private store.
     * @returns {Promise<void>}
     */
    async clear() {
      await this._writeStore({});
      console.log('[PrivateDataStore] Cleared all local private entries.');
    }
  }

  root.__BA_PrivateDataStore = PrivateDataStore;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PrivateDataStore };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : self));
