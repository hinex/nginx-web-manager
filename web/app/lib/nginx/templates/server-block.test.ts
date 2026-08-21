import { describe, it, expect } from "vitest";
import { parse } from "~/lib/nginx/parser";
import { buildServerBlock, type HostConfig } from "./server-block";

type LocationConfig = HostConfig["locations"][number];

function makeLocation(overrides: Partial<LocationConfig> = {}): LocationConfig {
  return {
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
    preservePath: true,
    statusCode: 301,
    headers: {},
    accessListId: null,
    ...overrides,
  };
}

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
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
    locations: [],
    advancedNginx: null,
    webhookUrl: null,
    errorPagesDir: null,
    basicAuth: null,
    dnsResolver: null,
    dnsResolverValid: null,
    customPrelude: null,
    ...overrides,
  };
}

describe("buildServerBlock — raw escape hatches", () => {
  it("renders customPrelude before the server block", () => {
    const out = buildServerBlock(
      makeHost({ customPrelude: "map $http_x $y {\n  default 0;\n}" }),
      new Map()
    );
    expect(out.indexOf("map $http_x $y")).toBeLessThan(out.indexOf("server {"));
  });

  it("renders locations[].advanced inside the location body", () => {
    const out = buildServerBlock(
      makeHost({
        locations: [
          makeLocation({ path: "/api", type: "proxy", advanced: "proxy_read_timeout 300s;" }),
        ],
      }),
      new Map()
    );
    expect(out).toContain("        proxy_read_timeout 300s;");
    expect(out.indexOf("proxy_read_timeout")).toBeGreaterThan(out.indexOf("location /api"));
  });

  it("renders a type:advanced location as a raw body with a generated header", () => {
    const out = buildServerBlock(
      makeHost({
        locations: [
          makeLocation({
            path: "/health",
            matchType: "prefix",
            type: "advanced",
            advanced: 'return 200 "ok";',
          }),
        ],
      }),
      new Map()
    );
    expect(out).toContain("location /health {");
    expect(out).toContain('        return 200 "ok";');
    expect(out).not.toContain("proxy_pass");
  });

  it("round-trips: parsing the rendered output yields the same directives", () => {
    const host = makeHost({
      customPrelude: "upstream backend {\n  server 10.0.0.5:9000;\n}",
    });
    const out = buildServerBlock(host, new Map());
    expect(() => parse(out)).not.toThrow();
    expect(parse(out).directives.some((d) => d.name === "upstream")).toBe(true);
  });

  it("locations[].advanced content parses back to exactly the raw text's directives (type: advanced)", () => {
    // This is the property the classifier (Task 2) depends on: a raw remainder
    // it captured from a hand edit must come back out of the template as the
    // *same* directives, or the next diff reports it as a spurious delta.
    const rawBody = 'return 200 "ok";\nadd_header X-Debug 1;';
    const host = makeHost({
      locations: [
        makeLocation({ path: "/health", matchType: "prefix", type: "advanced", advanced: rawBody }),
      ],
    });
    const rendered = buildServerBlock(host, new Map());
    const serverBlock = parse(rendered).directives.find((d) => d.name === "server")!;
    const locationBlock = serverBlock.block!.directives.find(
      (d) => d.name === "location" && d.args[0] === "/health"
    )!;
    const actual = locationBlock.block!.directives.map((d) => ({ name: d.name, args: d.args }));
    const standalone = parse(rawBody).directives.map((d) => ({ name: d.name, args: d.args }));
    expect(actual).toEqual(standalone);
  });

  it("locations[].advanced content parses back to exactly the raw text's directives (recognised location)", () => {
    const rawExtra = "proxy_read_timeout 300s;\nproxy_buffering off;";
    const host = makeHost({
      locations: [makeLocation({ path: "/api", type: "proxy", advanced: rawExtra })],
    });
    const rendered = buildServerBlock(host, new Map());
    const serverBlock = parse(rendered).directives.find((d) => d.name === "server")!;
    const locationBlock = serverBlock.block!.directives.find(
      (d) => d.name === "location" && d.args[0] === "/api"
    )!;
    const locDirectives = locationBlock.block!.directives.map((d) => ({ name: d.name, args: d.args }));
    const standalone = parse(rawExtra).directives.map((d) => ({ name: d.name, args: d.args }));
    // The recognised proxy directives come first; the raw remainder must be present, untouched, at the end.
    expect(locDirectives.slice(-standalone.length)).toEqual(standalone);
  });

  it("customPrelude content parses back to exactly the raw text's directives", () => {
    const rawPrelude = "upstream backend {\n    server 10.0.0.5:9000;\n    server 10.0.0.6:9000;\n}";
    const host = makeHost({ customPrelude: rawPrelude });
    const rendered = buildServerBlock(host, new Map());
    const upstream = parse(rendered).directives.find((d) => d.name === "upstream")!;
    const actual = upstream.block!.directives.map((d) => ({ name: d.name, args: d.args }));
    const standalone = parse(rawPrelude).directives[0].block!.directives.map((d) => ({
      name: d.name,
      args: d.args,
    }));
    expect(actual).toEqual(standalone);
  });

  it("does not render an accessList, basic auth or headers for a type:advanced location", () => {
    const out = buildServerBlock(
      makeHost({
        locations: [
          makeLocation({
            path: "/health",
            type: "advanced",
            advanced: 'return 200 "ok";',
            accessListId: 3,
            headers: { "X-Test": "1" },
          }),
        ],
      }),
      new Map()
    );
    expect(out).not.toContain("X-Test");
    expect(out).not.toContain("allow ");
  });
});
