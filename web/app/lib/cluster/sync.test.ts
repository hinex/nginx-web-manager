import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────

// Mock DB — track calls to select/update
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockRun = vi.fn();

const mockWhere = vi.fn(() => ({ get: mockGet, all: mockAll, run: mockRun }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));

vi.mock("~/lib/db/connection", () => ({
  db: {
    select: () => ({ from: mockFrom }),
    update: () => ({ set: mockSet }),
  },
}));

vi.mock("~/lib/db/schema", () => ({
  clusterNodes: {
    id: "id",
    role: "role",
  },
  configSyncTags: {
    syncMode: "sync_mode",
  },
}));

vi.mock("~/lib/nginx/parser", () => ({
  listConfigFiles: vi.fn(() => ["/data/nginx/nginx.conf", "/data/nginx/conf.d/default.conf"]),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn((path: string) => `# config for ${path}`),
}));

import { syncToNode, syncToAllNodes } from "./sync";

// ─── Tests ──────────────────────────────────────────────

describe("syncToNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    // Default: no local-only sync tags
    mockAll.mockReturnValue([]);
  });

  it("returns error when node is not found", async () => {
    mockGet.mockReturnValueOnce(undefined);

    const result = await syncToNode(999);

    expect(result).toEqual({
      nodeId: 999,
      nodeName: "unknown",
      success: false,
      error: "Node not found",
    });
  });

  it("syncs successfully to a worker node", async () => {
    mockGet.mockReturnValueOnce({
      id: 1,
      name: "worker-1",
      url: "https://worker1.example.com",
      apiKey: "secret-key",
      role: "worker",
      status: "offline",
    });

    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ success: true }),
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

    const result = await syncToNode(1);

    expect(result).toEqual({
      nodeId: 1,
      nodeName: "worker-1",
      success: true,
    });

    // Verify fetch was called with correct URL and headers
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://worker1.example.com/api/cluster-receive",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cluster-Key": "secret-key",
        },
      })
    );

    // Verify status was set to "syncing" first, then "online"
    expect(mockSet).toHaveBeenCalledWith({ status: "syncing" });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "online", lastError: null })
    );
  });

  it("sets error status when fetch fails", async () => {
    mockGet.mockReturnValueOnce({
      id: 2,
      name: "worker-2",
      url: "https://worker2.example.com",
      apiKey: "key-2",
      role: "worker",
      status: "offline",
    });

    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Connection refused")
    );

    const result = await syncToNode(2);

    expect(result).toEqual({
      nodeId: 2,
      nodeName: "worker-2",
      success: false,
      error: "Connection refused",
    });

    // Verify error status was set
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", lastError: "Connection refused" })
    );
  });

  it("handles non-ok HTTP response", async () => {
    mockGet.mockReturnValueOnce({
      id: 3,
      name: "worker-3",
      url: "https://worker3.example.com",
      apiKey: "key-3",
      role: "worker",
      status: "offline",
    });

    const mockResponse = {
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

    const result = await syncToNode(3);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
    expect(result.error).toContain("Internal Server Error");
  });
});

describe("syncToAllNodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    // Default: no local-only sync tags
    mockAll.mockReturnValue([]);
  });

  it("syncs to all worker nodes", async () => {
    // First call: syncToAllNodes queries all workers
    mockAll.mockReturnValueOnce([
      { id: 1, name: "worker-1", url: "https://w1.example.com", apiKey: "k1", role: "worker", status: "offline" },
      { id: 2, name: "worker-2", url: "https://w2.example.com", apiKey: "k2", role: "worker", status: "offline" },
    ]);

    // Each syncToNode call will query for the individual node
    mockGet
      .mockReturnValueOnce({ id: 1, name: "worker-1", url: "https://w1.example.com", apiKey: "k1", role: "worker", status: "offline" })
      .mockReturnValueOnce({ id: 2, name: "worker-2", url: "https://w2.example.com", apiKey: "k2", role: "worker", status: "offline" });

    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const results = await syncToAllNodes();

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
  });
});
