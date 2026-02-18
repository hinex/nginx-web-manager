import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock DB before imports
vi.mock("~/lib/db/connection", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnValue(null), // No settings rows = use defaults
  };
  return { db: mockDb };
});

vi.mock("~/lib/db/schema", () => ({
  settings: { key: "key", value: "value" },
}));

import {
  checkRateLimit,
  recordFailedAttempt,
  resetAttempts,
} from "./rate-limit";

describe("rate-limit", () => {
  beforeEach(() => {
    resetAttempts("test-ip");
  });

  it("allows first attempt", () => {
    expect(checkRateLimit("test-ip").allowed).toBe(true);
  });

  it("allows up to default max attempts - 1 failed attempts", () => {
    // Default max_login_attempts is 10, so 9 attempts should be allowed
    for (let i = 0; i < 9; i++) {
      recordFailedAttempt("test-ip");
    }
    expect(checkRateLimit("test-ip").allowed).toBe(true);
  });

  it("blocks after default max attempts failed attempts", () => {
    // Default max_login_attempts is 10
    for (let i = 0; i < 10; i++) {
      recordFailedAttempt("test-ip");
    }
    const result = checkRateLimit("test-ip");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets attempts on success", () => {
    for (let i = 0; i < 9; i++) {
      recordFailedAttempt("test-ip");
    }
    resetAttempts("test-ip");
    expect(checkRateLimit("test-ip").allowed).toBe(true);
  });
});
