/**
 * Minimal ambient typing for the slice of the WebExtension API we use.
 * Firefox exposes `browser` in content scripts with promise-based methods.
 */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

declare const browser: { storage: { local: StorageArea } } | undefined;
declare const chrome: { storage: { local: StorageArea } } | undefined;

export const storage: StorageArea =
  (typeof browser !== 'undefined' && browser?.storage?.local) ||
  (typeof chrome !== 'undefined' && chrome?.storage?.local) ||
  // Fallback keeps the content script alive if storage is somehow unavailable.
  {
    async get() { return {}; },
    async set() { /* no-op */ },
    async remove() { /* no-op */ },
  };
