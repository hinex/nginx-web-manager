import { describe, it, expect } from "vitest";
import { applyEdits } from "./apply";
import type { ClassifiedEdit } from "./classify";
import type { HostConfig } from "~/lib/nginx/templates/server-block";

const baseHost: HostConfig = {
  id: 7,
  groupId: null,
  domains: ["example.com"],
  enabled: true,
  sslType: "none",
  sslForceHttps: false,
  sslCertPath: null,
  sslKeyPath: null,
  hsts: false,
  http2: false,
  compression: false,
  redirectWww: false,
  clientMaxBodySize: "1m",
  locations: [
    {
      path: "/api",
      matchType: "prefix",
      type: "proxy",
      upstreams: [{ server: "10.0.0.1", port: 8080, weight: 1 }],
      balanceMethod: "round_robin",
      staticDir: "",
      cacheExpires: "",
      forwardScheme: "https",
      forwardDomain: "",
      forwardPath: "/",
      preservePath: false,
      statusCode: 301,
      headers: { "X-Real-IP": "$remote_addr" },
      accessListId: 3,
      basicAuth: {
        enabled: true,
        users: [
          { username: "office", password: "x" },
          { username: "dev", password: "y" },
        ],
      },
    },
    {
      path: "/static",
      matchType: "prefix",
      type: "static",
      upstreams: [],
      balanceMethod: "round_robin",
      staticDir: "/var/www",
      cacheExpires: "",
      forwardScheme: "http",
      forwardDomain: "",
      forwardPath: "/",
      preservePath: true,
      statusCode: 301,
      headers: {},
      accessListId: null,
      basicAuth: null,
    },
  ],
  advancedNginx: null,
  webhookUrl: null,
  errorPagesDir: null,
  basicAuth: null,
  dnsResolver: null,
  dnsResolverValid: null,
  customPrelude: null,
};

describe("applyEdits", () => {
  it("returns a structurally equal host for an empty edit list", () => {
    const result = applyEdits(baseHost, []);
    expect(result).toEqual(baseHost);
  });

  it("does not mutate the input host", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "field", field: "clientMaxBodySize", from: "1m", to: "50m", label: "x" },
    ];
    applyEdits(baseHost, edits);
    expect(baseHost.clientMaxBodySize).toBe("1m");
  });

  it("replaces the value for a top-level field edit", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "field", field: "clientMaxBodySize", from: "1m", to: "50m", label: "x" },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.clientMaxBodySize).toBe("50m");
  });

  it("applies a location-field edit to the right index", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "location-field", index: 1, field: "staticDir", from: "/var/www", to: "/srv/www", label: "x" },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.locations[1].staticDir).toBe("/srv/www");
    // other index untouched
    expect(result.locations[0]).toEqual(baseHost.locations[0]);
  });

  it("appends location-advanced text to existing text rather than replacing", () => {
    const hostWithAdvanced: HostConfig = {
      ...baseHost,
      locations: [
        { ...baseHost.locations[0], advanced: "proxy_read_timeout 60s;" },
        baseHost.locations[1],
      ],
    };
    const edits: ClassifiedEdit[] = [
      { kind: "location-advanced", index: 0, text: "proxy_connect_timeout 5s;", label: "x" },
    ];
    const result = applyEdits(hostWithAdvanced, edits);
    expect(result.locations[0].advanced).toBe("proxy_read_timeout 60s;\nproxy_connect_timeout 5s;");
  });

  it("sets location-advanced text when none existed before", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "location-advanced", index: 1, text: "gzip_static on;", label: "x" },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.locations[1].advanced).toBe("gzip_static on;");
  });

  it("splices the array on location-removed and leaves the other index intact", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "location-removed", index: 0, label: "x", losing: [] },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toEqual(baseHost.locations[1]);
  });

  it("appends a location-added block with the right type", () => {
    const edits: ClassifiedEdit[] = [
      {
        kind: "location-added",
        path: "/new",
        matchType: "prefix",
        type: "redirect",
        body: "return 301 https://example.com/new;",
        label: "x",
      },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.locations).toHaveLength(3);
    const added = result.locations[2];
    expect(added.path).toBe("/new");
    expect(added.matchType).toBe("prefix");
    expect(added.type).toBe("redirect");
    expect(added.advanced).toBe("return 301 https://example.com/new;");
  });

  it("keeps location-field edits addressed correctly alongside a location-removed in the same batch", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "location-field", index: 1, field: "staticDir", from: "/var/www", to: "/srv/www", label: "x" },
      { kind: "location-removed", index: 0, label: "x", losing: [] },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].staticDir).toBe("/srv/www");
  });

  it("appends to customPrelude on a prelude edit", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "prelude", text: "upstream mine { server 1.2.3.4; }", label: "x" },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.customPrelude).toBe("upstream mine { server 1.2.3.4; }");
  });

  it("appends further prelude edits with a newline separator", () => {
    const hostWithPrelude: HostConfig = { ...baseHost, customPrelude: "map $a $b { default 0; }" };
    const edits: ClassifiedEdit[] = [
      { kind: "prelude", text: "upstream mine { server 1.2.3.4; }", label: "x" },
    ];
    const result = applyEdits(hostWithPrelude, edits);
    expect(result.customPrelude).toBe("map $a $b { default 0; }\nupstream mine { server 1.2.3.4; }");
  });

  it("appends to advancedNginx on a server-advanced edit", () => {
    const edits: ClassifiedEdit[] = [
      { kind: "server-advanced", text: "large_client_header_buffers 4 16k;", label: "x" },
    ];
    const result = applyEdits(baseHost, edits);
    expect(result.advancedNginx).toBe("large_client_header_buffers 4 16k;");
  });

  it("appends further server-advanced edits to existing advancedNginx text", () => {
    const hostWithAdv: HostConfig = { ...baseHost, advancedNginx: "keepalive_timeout 65;" };
    const edits: ClassifiedEdit[] = [
      { kind: "server-advanced", text: "large_client_header_buffers 4 16k;", label: "x" },
    ];
    const result = applyEdits(hostWithAdv, edits);
    expect(result.advancedNginx).toBe("keepalive_timeout 65;\nlarge_client_header_buffers 4 16k;");
  });
});
