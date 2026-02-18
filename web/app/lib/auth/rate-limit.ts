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
  const entry = store.get(ip);
  if (!entry) return { allowed: true };

  // Check if locked
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
  }

  // Lock expired, reset
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    store.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordFailedAttempt(ip: string): void {
  const entry = store.get(ip) ?? { attempts: 0, lockedUntil: null };
  entry.attempts++;

  const maxAttempts = getMaxAttempts();
  const banDurationMs = getBanDurationMs();

  if (entry.attempts >= maxAttempts) {
    entry.lockedUntil = Date.now() + banDurationMs;
  }

  store.set(ip, entry);
}

export function resetAttempts(ip: string): void {
  store.delete(ip);
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
