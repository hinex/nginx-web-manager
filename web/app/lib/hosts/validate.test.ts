import { describe, it, expect } from "vitest";
import { validatePublishData } from "./validate";

const proxyLoc = (path = "/", overrides: Record<string, any> = {}) => ({
  path,
  matchType: "prefix" as const,
  type: "proxy",
  upstreams: [{ server: "127.0.0.1", port: 8080, protocol: "http" }],
  ...overrides,
});

const streamPort = (port = 443, overrides: Record<string, any> = {}) => ({
  port,
  upstreams: [{ server: "127.0.0.1", port: 8443 }],
  ...overrides,
});

describe("validatePublishData", () => {
  // ─── domains check ───────────────────────────────────────
  it("returns null when no locations and no stream ports — caught by the ≥1 rule first", () => {
    const err = validatePublishData({ locations: [], streamPorts: [] });
    expect(err).toBe("At least one location or stream port is required");
  });

  it("requires domain when http locations exist", () => {
    const err = validatePublishData({
      domains: [],
      locations: [proxyLoc()],
      streamPorts: [],
    });
    expect(err).toBe("At least one domain is required for HTTP locations");
  });

  it("allows no domains when only stream ports exist", () => {
    const err = validatePublishData({
      domains: [],
      locations: [],
      streamPorts: [streamPort()],
    });
    expect(err).toBeNull();
  });

  it("passes when domains and locations present", () => {
    const err = validatePublishData({
      domains: ["example.com"],
      locations: [proxyLoc()],
      streamPorts: [],
    });
    expect(err).toBeNull();
  });

  // ─── ≥1 location or stream port ─────────────────────────
  it("rejects if no locations and no stream ports", () => {
    const err = validatePublishData({ domains: ["example.com"], locations: [], streamPorts: [] });
    expect(err).toBe("At least one location or stream port is required");
  });

  // ─── duplicate matchType+path ────────────────────────────
  it("rejects duplicate prefix paths", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc("/"), proxyLoc("/")],
      streamPorts: [],
    });
    expect(err).toMatch(/Duplicate location/);
    expect(err).toContain('"/"');
  });

  it("rejects duplicate exact paths", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("/health", { matchType: "exact" }),
        proxyLoc("/health", { matchType: "exact" }),
      ],
      streamPorts: [],
    });
    expect(err).toMatch(/Duplicate location/);
    expect(err).toContain('"= /health"');
  });

  it("rejects duplicate regex paths", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("\\.php$", { matchType: "regex" }),
        proxyLoc("\\.php$", { matchType: "regex" }),
      ],
      streamPorts: [],
    });
    expect(err).toMatch(/Duplicate location/);
  });

  it("allows same path with different matchTypes", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("/health", { matchType: "prefix" }),
        proxyLoc("/health", { matchType: "exact" }),
      ],
      streamPorts: [],
    });
    expect(err).toBeNull();
  });

  // ─── proxy upstream checks ────────────────────────────────
  it("rejects proxy location with no upstreams", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc("/", { upstreams: [] })],
      streamPorts: [],
    });
    expect(err).toMatch(/needs at least one upstream/);
  });

  it("rejects upstream with empty server", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc("/", { upstreams: [{ server: "  ", port: 80, protocol: "http" }] })],
      streamPorts: [],
    });
    expect(err).toBe("All upstreams must have a server address");
  });

  it("rejects upstream port 0", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc("/", { upstreams: [{ server: "app", port: 0, protocol: "http" }] })],
      streamPorts: [],
    });
    expect(err).toBe("Upstream port must be 1-65535");
  });

  it("rejects upstream port 65536", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc("/", { upstreams: [{ server: "app", port: 65536, protocol: "http" }] })],
      streamPorts: [],
    });
    expect(err).toBe("Upstream port must be 1-65535");
  });

  it("rejects mixed upstream protocols in same location", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("/", {
          upstreams: [
            { server: "a", port: 80, protocol: "http" },
            { server: "b", port: 443, protocol: "https" },
          ],
        }),
      ],
      streamPorts: [],
    });
    expect(err).toMatch(/mixed upstream protocols/);
  });

  it("allows single protocol across multiple upstreams", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("/", {
          upstreams: [
            { server: "a", port: 80, protocol: "http" },
            { server: "b", port: 80, protocol: "http" },
          ],
        }),
      ],
      streamPorts: [],
    });
    expect(err).toBeNull();
  });

  it("treats missing protocol as 'http' for dedup check", () => {
    // two upstreams: one explicit http, one undefined — should be treated the same
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [
        proxyLoc("/", {
          upstreams: [
            { server: "a", port: 80, protocol: undefined },
            { server: "b", port: 80, protocol: "http" },
          ],
        }),
      ],
      streamPorts: [],
    });
    expect(err).toBeNull();
  });

  // ─── static / file ───────────────────────────────────────
  it("rejects static location without staticDir", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [{ path: "/files", matchType: "prefix", type: "static", staticDir: "" }],
      streamPorts: [],
    });
    expect(err).toMatch(/needs a directory path/);
  });

  it("rejects file location without staticDir", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [{ path: "/dl", matchType: "prefix", type: "file", staticDir: "  " }],
      streamPorts: [],
    });
    expect(err).toMatch(/needs a file path/);
  });

  // ─── redirect ────────────────────────────────────────────
  it("rejects redirect location without forwardDomain", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [{ path: "/old", matchType: "prefix", type: "redirect", forwardDomain: "" }],
      streamPorts: [],
    });
    expect(err).toMatch(/needs a forward domain/);
  });

  it("accepts redirect location with forwardDomain", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [{ path: "/old", matchType: "prefix", type: "redirect", forwardDomain: "new.com" }],
      streamPorts: [],
    });
    expect(err).toBeNull();
  });

  // ─── stream ports ─────────────────────────────────────────
  it("rejects stream port 0", () => {
    const err = validatePublishData({
      locations: [],
      streamPorts: [streamPort(0)],
    });
    expect(err).toBe("Stream port must be 1-65535");
  });

  it("rejects stream port 65536", () => {
    const err = validatePublishData({
      locations: [],
      streamPorts: [streamPort(65536)],
    });
    expect(err).toBe("Stream port must be 1-65535");
  });

  it("rejects stream port with no upstreams", () => {
    const err = validatePublishData({
      locations: [],
      streamPorts: [{ port: 9000, upstreams: [] }],
    });
    expect(err).toMatch(/needs at least one upstream/);
  });

  it("accepts valid stream port with upstream", () => {
    const err = validatePublishData({
      locations: [],
      streamPorts: [streamPort(8443)],
    });
    expect(err).toBeNull();
  });

  // ─── custom SSL ──────────────────────────────────────────
  it("rejects custom ssl without cert path", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc()],
      streamPorts: [],
      sslType: "custom",
      sslCertPath: "",
      sslKeyPath: "/key.pem",
    });
    expect(err).toBe("Custom SSL requires both certificate and key paths");
  });

  it("rejects custom ssl without key path", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc()],
      streamPorts: [],
      sslType: "custom",
      sslCertPath: "/cert.pem",
      sslKeyPath: "",
    });
    expect(err).toBe("Custom SSL requires both certificate and key paths");
  });

  it("accepts custom ssl with both paths", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc()],
      streamPorts: [],
      sslType: "custom",
      sslCertPath: "/cert.pem",
      sslKeyPath: "/key.pem",
    });
    expect(err).toBeNull();
  });

  it("passes ssl check when sslType is not custom", () => {
    const err = validatePublishData({
      domains: ["a.com"],
      locations: [proxyLoc()],
      streamPorts: [],
      sslType: "letsencrypt",
    });
    expect(err).toBeNull();
  });
});
