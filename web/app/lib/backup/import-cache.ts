/**
 * In-memory cache for parsed import data.
 *
 * When a user uploads a tar.gz (or encrypted) backup for preview,
 * the parsed data is stored here keyed by a random import ID.
 * The apply step then retrieves the data by ID, avoiding a second upload.
 *
 * Entries expire after 10 minutes to avoid unbounded memory growth.
 */

import { randomBytes } from "crypto";

export interface ParsedBackup {
  version: number;
  exportedAt?: string;
  configs: Record<string, string>;
  database: Record<string, unknown[]>;
  customTemplates?: unknown[];
}

interface CacheEntry {
  data: ParsedBackup;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

const cache = new Map<string, CacheEntry>();

/**
 * Store parsed backup data and return a unique import ID.
 */
export function storeImport(data: ParsedBackup): string {
  // Clean expired entries first
  pruneExpired();

  const id = randomBytes(16).toString("hex");
  cache.set(id, { data, createdAt: Date.now() });
  return id;
}

/**
 * Retrieve parsed backup data by import ID.
 * Returns null if not found or expired.
 */
export function getImport(id: string): ParsedBackup | null {
  const entry = cache.get(id);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > EXPIRY_MS) {
    cache.delete(id);
    return null;
  }

  return entry.data;
}

/**
 * Remove an import entry (e.g., after applying it).
 */
export function removeImport(id: string): void {
  cache.delete(id);
}

/**
 * Remove all expired entries.
 */
function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.createdAt > EXPIRY_MS) {
      cache.delete(id);
    }
  }
}
