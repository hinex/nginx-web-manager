import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudflareDnsProvider } from "./cloudflare";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function cfResponse(result: unknown, success = true, errors: any[] = []) {
  return {
    ok: success,
    json: async () => ({ success, result, errors }),
  };
}

describe("CloudflareDnsProvider", () => {
  let provider: CloudflareDnsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudflareDnsProvider("test-api-token");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch.mockResolvedValueOnce(cfResponse([]));

    await provider.listZones();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones?per_page=50",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-token",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  describe("listZones", () => {
    it("returns mapped zones", async () => {
      mockFetch.mockResolvedValueOnce(
        cfResponse([
          { id: "z1", name: "example.com", status: "active", extra: "ignored" },
          { id: "z2", name: "test.com", status: "pending" },
        ])
      );

      const zones = await provider.listZones();

      expect(zones).toEqual([
        { id: "z1", name: "example.com", status: "active" },
        { id: "z2", name: "test.com", status: "pending" },
      ]);
    });

    it("returns empty array when no zones", async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));

      const zones = await provider.listZones();

      expect(zones).toEqual([]);
    });
  });

  describe("listRecords", () => {
    it("returns mapped records", async () => {
      mockFetch.mockResolvedValueOnce(
        cfResponse([
          {
            id: "r1",
            type: "A",
            name: "example.com",
            content: "1.2.3.4",
            ttl: 300,
            proxied: true,
            priority: undefined,
          },
          {
            id: "r2",
            type: "MX",
            name: "example.com",
            content: "mail.example.com",
            ttl: 3600,
            proxied: false,
            priority: 10,
          },
        ])
      );

      const records = await provider.listRecords("z1");

      expect(records).toEqual([
        {
          id: "r1",
          type: "A",
          name: "example.com",
          content: "1.2.3.4",
          ttl: 300,
          proxied: true,
          priority: undefined,
        },
        {
          id: "r2",
          type: "MX",
          name: "example.com",
          content: "mail.example.com",
          ttl: 3600,
          proxied: false,
          priority: 10,
        },
      ]);
    });

    it("calls correct URL with zoneId", async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));

      await provider.listRecords("zone-abc");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones/zone-abc/dns_records?per_page=100",
        expect.any(Object)
      );
    });
  });

  describe("createRecord", () => {
    it("sends POST with record body and returns created record", async () => {
      mockFetch.mockResolvedValueOnce(
        cfResponse({
          id: "new-r1",
          type: "A",
          name: "sub.example.com",
          content: "5.6.7.8",
          ttl: 1,
          proxied: true,
          priority: undefined,
        })
      );

      const record = await provider.createRecord("z1", {
        type: "A",
        name: "sub.example.com",
        content: "5.6.7.8",
        ttl: 1,
        proxied: true,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones/z1/dns_records",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "A",
            name: "sub.example.com",
            content: "5.6.7.8",
            ttl: 1,
            proxied: true,
          }),
        })
      );

      expect(record).toEqual({
        id: "new-r1",
        type: "A",
        name: "sub.example.com",
        content: "5.6.7.8",
        ttl: 1,
        proxied: true,
        priority: undefined,
      });
    });
  });

  describe("updateRecord", () => {
    it("sends PATCH with partial record and returns updated record", async () => {
      mockFetch.mockResolvedValueOnce(
        cfResponse({
          id: "r1",
          type: "A",
          name: "example.com",
          content: "9.8.7.6",
          ttl: 600,
          proxied: false,
          priority: undefined,
        })
      );

      const record = await provider.updateRecord("z1", "r1", {
        content: "9.8.7.6",
        ttl: 600,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ content: "9.8.7.6", ttl: 600 }),
        })
      );

      expect(record).toEqual({
        id: "r1",
        type: "A",
        name: "example.com",
        content: "9.8.7.6",
        ttl: 600,
        proxied: false,
        priority: undefined,
      });
    });
  });

  describe("deleteRecord", () => {
    it("sends DELETE request and returns void", async () => {
      mockFetch.mockResolvedValueOnce(cfResponse({ id: "r1" }));

      await provider.deleteRecord("z1", "r1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });
  });

  describe("error handling", () => {
    it("throws error with Cloudflare error message", async () => {
      mockFetch.mockResolvedValueOnce(
        cfResponse(null, false, [{ message: "Invalid API token" }])
      );

      await expect(provider.listZones()).rejects.toThrow("Invalid API token");
    });

    it("throws generic error when no error message provided", async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null, false, []));

      await expect(provider.listZones()).rejects.toThrow(
        "Cloudflare API error"
      );
    });

    it("throws generic error when errors array is undefined", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false }),
      });

      await expect(provider.listRecords("z1")).rejects.toThrow(
        "Cloudflare API error"
      );
    });
  });
});
