// web/app/lib/config/versions.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB before imports
vi.mock("~/lib/db/connection", () => {
  const mockDb = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ id: 1, filePath: "/data/nginx/conf.d/test.conf", content: "server {}", changeType: "manual_edit", userId: 1, message: null, createdAt: new Date() }),
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  };
  return { db: mockDb };
});

vi.mock("~/lib/db/schema", () => ({
  configVersions: { filePath: "file_path", id: "id", createdAt: "created_at" },
}));

import { saveVersion, getVersions, getVersion, diffVersions } from "./versions";

describe("saveVersion", () => {
  it("creates a version record", async () => {
    const version = await saveVersion({
      filePath: "/data/nginx/conf.d/test.conf",
      content: "server { listen 80; }",
      changeType: "manual_edit",
      userId: 1,
    });
    expect(version).toBeDefined();
    expect(version.id).toBe(1);
  });
});

describe("diffVersions", () => {
  it("returns diff between two strings", () => {
    const old = "line1\nline2\nline3";
    const current = "line1\nline2-changed\nline3";
    const diff = diffVersions(old, current);
    expect(diff.length).toBeGreaterThan(0);
    // Should have at least one change that's added or removed
    const hasChanges = diff.some(d => d.added || d.removed);
    expect(hasChanges).toBe(true);
  });

  it("returns no changes for identical strings", () => {
    const diff = diffVersions("same\ncontent", "same\ncontent");
    expect(diff.every(d => !d.added && !d.removed)).toBe(true);
  });
});
