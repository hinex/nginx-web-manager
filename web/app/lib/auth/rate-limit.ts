import { db } from "~/lib/db/connection";
import { settings } from "~/lib/db/schema";
import { eq } from "drizzle-orm";

interface RateLimitEntry {
  attempts: number;
  lockedUntil: number | null; // timestamp
}

const store = new Map<string, RateLimitEntry>();

const MAX_ATTEMPTS = 5;
const BAN_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Active lockouts are persisted to the settings table so a server restart
// does not lift bans. Attempt counters are intentionally kept in memory only.
const LOCKOUT_STATE_KEY = "login_lockout_state";
let lockoutsLoaded = false;

function loadPersistedLockouts(): void {
  if (lockoutsLoaded) return;
  lockoutsLoaded = true;
  try {
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, LOCKOUT_STATE_KEY))
      .get();
    if (!row?.value) return;
    const parsed = JSON.parse(row.value) as Record<string, RateLimitEntry>;
    const now = Date.now();
    for (const [ip, entry] of Object.entries(parsed)) {
      if (entry?.lockedUntil && entry.lockedUntil > now && !store.has(ip)) {
        store.set(ip, entry);
      }
    }
  } catch {
    // Corrupted or missing state — start fresh
  }
}

function persistLockouts(): void {
  try {
    const now = Date.now();
    const active: Record<string, RateLimitEntry> = {};
    for (const [ip, entry] of store) {
      if (entry.lockedUntil && entry.lockedUntil > now) {
        active[ip] = entry;
      }
    }
    const value = JSON.stringify(active);
    const existing = db
      .select()
      .from(settings)
      .where(eq(settings.key, LOCKOUT_STATE_KEY))
      .get();
    if (existing) {
      db.update(settings)
        .set({ value })
        .where(eq(settings.key, LOCKOUT_STATE_KEY))
        .run();
    } else {
      db.insert(settings).values({ key: LOCKOUT_STATE_KEY, value }).run();
    }
  } catch {
    // Persistence is best-effort; in-memory state still applies
  }
}

function getSetting(key: string, defaultValue: string): string {
  try {
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

function getMaxAttempts(): number {
  return Number(getSetting("max_login_attempts", "10")) || MAX_ATTEMPTS;
}

function getBanDurationMs(): number {
  const minutes = Number(getSetting("login_ban_duration_minutes", "10"));
  return (minutes || 15) * 60 * 1000;
}

export function checkRateLimit(ip: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  loadPersistedLockouts();
  const entry = store.get(ip);
  if (!entry) return { allowed: true };

  // Check if locked
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
  }

  // Lock expired, reset
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    store.delete(ip);
    persistLockouts();
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordFailedAttempt(ip: string): void {
  loadPersistedLockouts();
  const entry = store.get(ip) ?? { attempts: 0, lockedUntil: null };
  entry.attempts++;

  const maxAttempts = getMaxAttempts();
  const banDurationMs = getBanDurationMs();

  const justLocked = entry.attempts >= maxAttempts && !entry.lockedUntil;
  if (entry.attempts >= maxAttempts) {
    entry.lockedUntil = Date.now() + banDurationMs;
  }

  store.set(ip, entry);
  if (justLocked) persistLockouts();
}

export function resetAttempts(ip: string): void {
  const hadLockout = store.get(ip)?.lockedUntil != null;
  store.delete(ip);
  if (hadLockout) persistLockouts();
}

// Cleanup old entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of store) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      store.delete(ip);
    }
  }
}, 60_000); // every minute

// Prevent the interval from keeping the process alive in tests
if (typeof cleanupInterval === "object" && "unref" in cleanupInterval) {
  cleanupInterval.unref();
}
