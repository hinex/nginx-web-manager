import { describe, it, expect } from "vitest";
import { parse } from "~/lib/nginx/parser";
import { diffAst, type AstDelta } from "./match";
import { classifyDelta, classifyStreamDelta, type ClassifiedEdit, type StreamHostConfig } from "./classify";
import type { HostConfig } from "~/lib/nginx/templates/server-block";
import { buildStreamBlock } from "~/lib/nginx/templates/stream";
import { buildServerBlock } from "~/lib/nginx/templates/server-block";

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
  ],
  advancedNginx: null,
  webhookUrl: null,
  errorPagesDir: null,
  basicAuth: null,
  dnsResolver: null,
  dnsResolverValid: null,
};

const BASE_SERVER = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;

const expected = parse(BASE_SERVER);

function deltaFor(actualText: string) {
  return diffAst(expected, parse(actualText));
}

function findEdit(edits: ClassifiedEdit[], kind: ClassifiedEdit["kind"]) {
  return edits.find((e) => e.kind === kind);
}

describe("classifyDelta", () => {
  it("maps a changed client_max_body_size to the host field", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 50m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual({
      kind: "field",
      field: "clientMaxBodySize",
      from: "1m",
      to: "50m",
      label: "client_max_body_size 1m → 50m",
    });
  });

  it("maps changed server_name to domains[]", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name a.com b.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual({
      kind: "field",
      field: "domains",
      from: ["example.com"],
      to: ["a.com", "b.com"],
      label: "server_name example.com → a.com b.com",
    });
  });

  it("maps a changed proxy_pass to the location upstream", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.2:9090;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "location-field",
        index: 0,
        field: "upstreams",
        to: [{ server: "10.0.0.2", port: 9090, weight: 1, protocol: undefined }],
      })
    );
  });

  it("puts an unrecognised directive inside a location into location-advanced", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
`),
      baseHost
    );
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "location-advanced",
        index: 0,
        text: "proxy_read_timeout 300s;",
      })
    );
  });

  it("puts an unrecognised directive inside server{} into server-advanced", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    server_tokens off;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "server-advanced",
        text: "server_tokens off;",
      })
    );
  });

  it("puts an upstream block outside server{} into the prelude", () => {
    const c = classifyDelta(
      deltaFor(`
upstream backend {
    server 10.0.0.5:9000;
}
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "prelude",
      })
    );
    const prelude = findEdit(c.edits, "prelude");
    expect(prelude && "text" in prelude ? prelude.text : "").toContain("upstream backend");
  });

  it("classifies a new location with no recognisable core as type advanced", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location /health {
        return 200 "ok";
    }
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "location-added",
        path: "/health",
        matchType: "prefix",
        type: "advanced",
      })
    );
  });

  it("classifies a new location with proxy_pass as a proxy location", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location /new {
        proxy_pass http://10.0.0.9:9999;
    }
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({
        kind: "location-added",
        path: "/new",
        matchType: "prefix",
        type: "proxy",
      })
    );
  });

  it("enumerates by name everything lost with a removed location", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    const removed = findEdit(c.edits, "location-removed");
    expect(removed && "losing" in removed ? removed.losing : []).toEqual([
      "access list #3",
      "basic auth (2 users)",
      "header X-Real-IP",
    ]);
    expect(removed && "index" in removed ? removed.index : -1).toBe(0);
  });

  it("turns a removed Strict-Transport-Security header into hsts:false", () => {
    const withHsts = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;
    const delta = diffAst(parse(withHsts), parse(BASE_SERVER));
    const c = classifyDelta(delta, { ...baseHost, hsts: true });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "field", field: "hsts", from: true, to: false })
    );
  });

  it("turns a removed gzip directive into compression:false", () => {
    const withGzip = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    gzip on;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;
    const delta = diffAst(parse(withGzip), parse(BASE_SERVER));
    const c = classifyDelta(delta, { ...baseHost, compression: true });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "field", field: "compression", from: true, to: false })
    );
  });

  it("refuses a ssl_certificate change on a letsencrypt host", () => {
    const sslExpected = `
server {
    listen 80;
    listen 443 ssl;
    server_name example.com;
    ssl_certificate /etc/nginx/certs/example.com.pem;
    ssl_certificate_key /etc/nginx/certs/example.com.key;
}
`;
    const sslActual = `
server {
    listen 80;
    listen 443 ssl;
    server_name example.com;
    ssl_certificate /custom/example.com.pem;
    ssl_certificate_key /etc/nginx/certs/example.com.key;
}
`;
    const certChange = diffAst(parse(sslExpected), parse(sslActual));

    const c = classifyDelta(certChange, { ...baseHost, sslType: "letsencrypt" });
    expect(c.edits).toEqual([]);
    expect(c.refusals[0].reason).toMatch(/ACME/);
    expect(c.refusals[0].line).toBeGreaterThan(0);
  });

  it("accepts a ssl_certificate change on a custom-ssl host", () => {
    const sslExpected = `
server {
    listen 80;
    listen 443 ssl;
    server_name example.com;
    ssl_certificate /etc/nginx/certs/example.com.pem;
    ssl_certificate_key /etc/nginx/certs/example.com.key;
}
`;
    const sslActual = `
server {
    listen 80;
    listen 443 ssl;
    server_name example.com;
    ssl_certificate /custom/example.com.pem;
    ssl_certificate_key /etc/nginx/certs/example.com.key;
}
`;
    const certChange = diffAst(parse(sslExpected), parse(sslActual));

    const c = classifyDelta(certChange, { ...baseHost, sslType: "custom" });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(expect.objectContaining({ kind: "field", field: "sslCertPath" }));
  });

  it("refuses an edited resolver directive", () => {
    const resolverExpected = `
server {
    listen 80;
    server_name example.com;
    location /api {
        resolver 8.8.8.8 valid=30s;
        proxy_pass http://10.0.0.1:8080;
    }
}
`;
    const resolverActual = `
server {
    listen 80;
    server_name example.com;
    location /api {
        resolver 1.1.1.1 valid=30s;
        proxy_pass http://10.0.0.1:8080;
    }
}
`;
    const delta = diffAst(parse(resolverExpected), parse(resolverActual));
    const c = classifyDelta(delta, baseHost);
    expect(c.edits).toEqual([]);
    expect(c.refusals[0].reason).toMatch(/global settings/);
  });

  it("refuses set $backend_1 edits", () => {
    const setExpected = `
server {
    listen 80;
    server_name example.com;
    location /api {
        set $backend_host_7_loc_0 "http://10.0.0.1:8080";
        proxy_pass $backend_host_7_loc_0;
    }
}
`;
    const setActual = `
server {
    listen 80;
    server_name example.com;
    location /api {
        set $backend_host_7_loc_0 "http://10.0.0.2:8080";
        proxy_pass $backend_host_7_loc_0;
    }
}
`;
    const delta = diffAst(parse(setExpected), parse(setActual));
    const c = classifyDelta(delta, baseHost);
    expect(c.refusals.some((r) => r.reason.match(/global settings/))).toBe(true);
  });

  it("refuses deleting listen 443 ssl", () => {
    const sslExpected = `
server {
    listen 80;
    listen 443 ssl;
    server_name example.com;
}
`;
    const sslActual = `
server {
    listen 80;
    server_name example.com;
}
`;
    const delta = diffAst(parse(sslExpected), parse(sslActual));
    const c = classifyDelta(delta, { ...baseHost, sslType: "custom" });
    expect(c.edits).toEqual([]);
    expect(c.refusals[0].reason).toMatch(/SSL tab/);
  });

  it("refuses renaming a stream_host upstream", () => {
    const upExpected = `
upstream host_7_loc_0 {
    server 10.0.0.1:8080;
}
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://host_7_loc_0;
    }
}
`;
    const upActual = `
upstream mine {
    server 10.0.0.1:8080;
}
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://mine;
    }
}
`;
    const delta = diffAst(parse(upExpected), parse(upActual));
    const c = classifyDelta(delta, baseHost);
    expect(c.refusals[0].reason).toMatch(/internal link identifier/);
    // The paired "added" upstream must not also leak out as an accepted prelude edit.
    expect(c.edits.some((e) => e.kind === "prelude")).toBe(false);
  });

  it("refuses a second server block", () => {
    // diffAst cannot represent two `server {}` blocks distinctly: match.ts's
    // block pairing keys directives by scopeKey (`${name} ${args}`), and two
    // unnamed `server {}` blocks share the identical key "server" — so the
    // second one is silently dropped by the `Map` construction in match.ts's
    // walk(), never surfacing as an `added` entry. This refusal is, in
    // practice, caught entirely by syntax.ts's character-level scanner before
    // parse() ever runs (see classifyFor in Task 4). We still implement the
    // defensive check classifyDelta's own contract describes, and exercise
    // it here with a hand-built delta rather than one from diffAst. See
    // NUANCES.md #15.
    const delta: AstDelta = {
      added: [
        {
          name: "server",
          args: [],
          line: 12,
          scope: [],
          text: "server {\n    listen 80;\n}",
        },
      ],
      removed: [],
      changed: [],
    };
    const c = classifyDelta(delta, baseHost);
    expect(c.edits).toEqual([]);
    expect(c.refusals[0].reason).toMatch(/second server block/);
    expect(c.refusals[0].line).toBe(12);
  });

  it("refuses two unmatchable locations at once", () => {
    const twoLocExpected = `
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
    location /other {
        proxy_pass http://10.0.0.2:8080;
    }
}
`;
    const twoLocActual = `
server {
    listen 80;
    server_name example.com;
}
`;
    const delta = diffAst(parse(twoLocExpected), parse(twoLocActual));
    const c = classifyDelta(delta, baseHost);
    expect(c.edits.filter((e) => e.kind === "location-removed" || e.kind === "location-added")).toEqual([]);
    expect(c.refusals[0].reason).toBe(
      "Two or more locations changed at once and cannot be matched to model entries"
    );
    expect(c.refusals[0].line).toBeGreaterThan(0);
  });

  // ── Unmappable removals must refuse, not silently revert (see NUANCES.md #16) ──

  it("refuses removing client_max_body_size at server scope", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`),
      baseHost
    );
    expect(c.edits).toEqual([]);
    expect(c.refusals).toHaveLength(1);
    expect(c.refusals[0].directive).toBe("client_max_body_size");
    expect(c.refusals[0].reason).toMatch(/cannot be mapped back to a host field/);
    expect(c.refusals[0].line).toBeGreaterThan(0);
  });

  it("refuses removing a single proxy_set_header inside a matched location", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`),
      baseHost
    );
    expect(c.edits).toEqual([]);
    expect(c.refusals).toHaveLength(1);
    expect(c.refusals[0].directive).toBe("proxy_set_header");
    expect(c.refusals[0].reason).toMatch(/cannot be mapped back to a host field/);
  });

  it("refuses removing a prelude map block that is not an upstream rename", () => {
    const withMap = `
map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
}
${BASE_SERVER}`;
    const delta = diffAst(parse(withMap), parse(BASE_SERVER));
    const c = classifyDelta(delta, baseHost);
    expect(c.edits).toEqual([]);
    expect(c.refusals).toHaveLength(1);
    expect(c.refusals[0].directive).toBe("map");
    expect(c.refusals[0].reason).toMatch(/cannot be mapped back to a host field/);
  });

  it("still turns a removed http2 on into http2:false with no refusal", () => {
    const withHttp2 = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    http2 on;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;
    const delta = diffAst(parse(withHttp2), parse(BASE_SERVER));
    const c = classifyDelta(delta, { ...baseHost, http2: true });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "field", field: "http2", from: true, to: false })
    );
  });

  it("still turns a removed force-https if block into sslForceHttps:false with no refusal", () => {
    const withForceHttps = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    if ($scheme = http) {
        return 301 https://$host$request_uri;
    }
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;
    const delta = diffAst(parse(withForceHttps), parse(BASE_SERVER));
    const c = classifyDelta(delta, { ...baseHost, sslForceHttps: true });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "field", field: "sslForceHttps", from: true, to: false })
    );
  });

  it("still turns a removed www-redirect if block into redirectWww:false with no refusal", () => {
    const withWwwRedirect = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    if ($host ~ ^www\\.(.+)$) {
        return 301 $scheme://example.com$request_uri;
    }
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;
    const delta = diffAst(parse(withWwwRedirect), parse(BASE_SERVER));
    const c = classifyDelta(delta, { ...baseHost, redirectWww: true });
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "field", field: "redirectWww", from: true, to: false })
    );
  });

  it("still removes a whole location block as location-removed with no refusal", () => {
    const c = classifyDelta(
      deltaFor(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
}
`),
      baseHost
    );
    expect(c.refusals).toEqual([]);
    const removed = findEdit(c.edits, "location-removed");
    expect(removed).toBeDefined();
  });
});

describe("classifyStreamDelta", () => {
  const baseStreamHost: StreamHostConfig = {
    id: 7,
    streamPorts: [
      {
        port: 9000,
        protocol: "tcp",
        upstreams: [{ server: "10.0.0.1", port: 9000, weight: 1 }],
        balanceMethod: "round_robin",
      },
    ],
  };

  function streamDeltaFor(host: StreamHostConfig, actualText: string) {
    const expectedText = buildStreamBlock(host.id, host.streamPorts, null, null);
    return diffAst(parse(expectedText), parse(actualText));
  }

  it("maps a changed listen port to streamPorts[i].port", () => {
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000;
}
server {
    listen 9001;
    listen [::]:9001;
    proxy_pass stream_host_7_port_0;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "port", from: 9000, to: 9001 })
    );
  });

  it("maps a changed protocol (tcp -> udp) to streamPorts[i].protocol", () => {
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000;
}
server {
    listen 9000 udp;
    listen [::]:9000 udp;
    proxy_pass stream_host_7_port_0;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "protocol", from: "tcp", to: "udp" })
    );
  });

  it("maps a changed upstream server address/port to streamPorts[i].upstreams", () => {
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.2:9100;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    expect(c.refusals).toEqual([]);
    const edit = c.edits.find((e) => e.kind === "stream-field" && e.field === "upstreams") as any;
    expect(edit).toBeDefined();
    expect(edit.to).toEqual([{ server: "10.0.0.2", port: 9100, weight: 1 }]);
    // Core trap: an unrelated field change must never flip balanceMethod.
    expect(c.edits.some((e) => e.kind === "stream-field" && e.field === "balanceMethod")).toBe(false);
  });

  it("refuses renaming a stream_host_<id>_port_<i> upstream via a real diffAst delta", () => {
    const actual = `
upstream mine {
    server 10.0.0.1:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass mine;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    const renameRefusals = c.refusals.filter((r) => r.reason.match(/internal link identifier/));
    // Exactly one refusal for the rename itself — the removed+added pair
    // must not be double-counted.
    expect(renameRefusals).toHaveLength(1);
  });

  it("refuses an unrecognised directive inside a stream upstream block (no advanced/raw field exists)", () => {
    const actual = `
upstream stream_host_7_port_0 {
    keepalive 32;
    server 10.0.0.1:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    expect(c.edits).toEqual([]);
    expect(c.refusals[0].reason).toMatch(/no equivalent stream host field/);
  });

  it("refuses an edited resolver directive inside a stream server block", () => {
    const dnsHost: StreamHostConfig = baseStreamHost;
    const expectedText = buildStreamBlock(dnsHost.id, dnsHost.streamPorts, "8.8.8.8", "30s");
    const actual = `
server {
    listen 9000;
    listen [::]:9000;
    resolver 1.1.1.1 valid=30s;
    set $backend_stream_host_7_port_0 "10.0.0.1:9000";
    proxy_pass $backend_stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, dnsHost);
    expect(c.refusals.some((r) => r.reason.match(/global settings/))).toBe(true);
  });

  it("refuses set $backend_* edits inside a stream server block", () => {
    const dnsHost: StreamHostConfig = baseStreamHost;
    const expectedText = buildStreamBlock(dnsHost.id, dnsHost.streamPorts, "8.8.8.8", "30s");
    const actual = `
server {
    listen 9000;
    listen [::]:9000;
    resolver 8.8.8.8 valid=30s;
    set $backend_stream_host_7_port_0 "10.0.0.2:9100";
    proxy_pass $backend_stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, dnsHost);
    expect(c.refusals.some((r) => r.reason.match(/global settings/))).toBe(true);
  });

  // ── balanceMethod round-trip: one test per value (the core trap) ──

  const twoUpstreamHost: StreamHostConfig = {
    id: 7,
    streamPorts: [
      {
        port: 9000,
        protocol: "tcp",
        upstreams: [
          { server: "10.0.0.1", port: 9000, weight: 1 },
          { server: "10.0.0.2", port: 9000, weight: 1 },
        ],
        balanceMethod: "round_robin",
      },
    ],
  };

  it("balanceMethod round_robin -> least_conn: an added `least_conn;` directive wins", () => {
    const expectedText = buildStreamBlock(twoUpstreamHost.id, twoUpstreamHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    least_conn;
    server 10.0.0.1:9000;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, twoUpstreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "round_robin", to: "least_conn" })
    );
  });

  it("balanceMethod round_robin -> ip_hash: an added `ip_hash;` directive wins", () => {
    const expectedText = buildStreamBlock(twoUpstreamHost.id, twoUpstreamHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    ip_hash;
    server 10.0.0.1:9000;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, twoUpstreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "round_robin", to: "ip_hash" })
    );
  });

  it("balanceMethod round_robin -> random: an added `random;` directive wins", () => {
    const expectedText = buildStreamBlock(twoUpstreamHost.id, twoUpstreamHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    random;
    server 10.0.0.1:9000;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, twoUpstreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "round_robin", to: "random" })
    );
  });

  const leastConnHost: StreamHostConfig = {
    id: 7,
    streamPorts: [{ ...twoUpstreamHost.streamPorts[0], balanceMethod: "least_conn" }],
  };

  it("balanceMethod least_conn -> round_robin: removing the directive with no weight evidence anywhere", () => {
    const expectedText = buildStreamBlock(leastConnHost.id, leastConnHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, leastConnHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "least_conn", to: "round_robin" })
    );
  });

  it("balanceMethod round_robin -> weighted: adding weight= on a server line with no directive involved", () => {
    const expectedText = buildStreamBlock(twoUpstreamHost.id, twoUpstreamHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000 weight=5;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, twoUpstreamHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "round_robin", to: "weighted" })
    );
    const upstreamsEdit = c.edits.find((e) => e.kind === "stream-field" && e.field === "upstreams") as any;
    expect(upstreamsEdit.to).toEqual([
      { server: "10.0.0.1", port: 9000, weight: 5 },
      { server: "10.0.0.2", port: 9000, weight: 1 },
    ]);
  });

  const weightedHost: StreamHostConfig = {
    id: 7,
    streamPorts: [
      {
        port: 9000,
        protocol: "tcp",
        upstreams: [
          { server: "10.0.0.1", port: 9000, weight: 5 },
          { server: "10.0.0.2", port: 9000, weight: 1 },
        ],
        balanceMethod: "weighted",
      },
    ],
  };

  it("balanceMethod weighted -> round_robin: removing the last weight>1 annotation with no directive involved", () => {
    const expectedText = buildStreamBlock(weightedHost.id, weightedHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000;
    server 10.0.0.2:9000;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, weightedHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", field: "balanceMethod", from: "weighted", to: "round_robin" })
    );
  });

  it("balanceMethod: does not flip weighted->round_robin from an unrelated server address change", () => {
    const expectedText = buildStreamBlock(weightedHost.id, weightedHost.streamPorts, null, null);
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.1:9000 weight=5;
    server 10.0.0.99:9200;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const delta = diffAst(parse(expectedText), parse(actual));
    const c = classifyStreamDelta(delta, weightedHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits.some((e) => e.kind === "stream-field" && e.field === "balanceMethod")).toBe(false);
    const upstreamsEdit = c.edits.find((e) => e.kind === "stream-field" && e.field === "upstreams") as any;
    expect(upstreamsEdit.to).toEqual([
      { server: "10.0.0.1", port: 9000, weight: 5 },
      { server: "10.0.0.99", port: 9200, weight: 1 },
    ]);
  });

  it("balanceMethod: does not flip round_robin->weighted when nothing weight-related changed", () => {
    const actual = `
upstream stream_host_7_port_0 {
    server 10.0.0.2:9100;
}
server {
    listen 9000;
    listen [::]:9000;
    proxy_pass stream_host_7_port_0;
}
`;
    const c = classifyStreamDelta(streamDeltaFor(baseStreamHost, actual), baseStreamHost);
    expect(c.edits.some((e) => e.kind === "stream-field" && e.field === "balanceMethod")).toBe(false);
  });
  // Two-port hosts: every anonymous `server {}` renders with the identical
  // scope key, so before match.ts indexed them by occurrence an edit to any
  // port but the last one produced zero edits AND zero refusals.
  const twoPortHost: StreamHostConfig = {
    id: 7,
    streamPorts: [
      {
        port: 9000,
        protocol: "tcp",
        upstreams: [{ server: "10.0.0.1", port: 9000, weight: 1 }],
        balanceMethod: "round_robin",
      },
      {
        port: 9500,
        protocol: "tcp",
        upstreams: [{ server: "10.0.0.2", port: 9500, weight: 1 }],
        balanceMethod: "round_robin",
      },
    ],
  };

  it("maps an edit to the FIRST port of a two-port host", () => {
    const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
    const actual = expectedText
      .replace("listen 9000;", "listen 9010;")
      .replace("listen [::]:9000;", "listen [::]:9010;");
    expect(actual).not.toBe(expectedText);
    const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", index: 0, field: "port", from: 9000, to: 9010 })
    );
  });

  it("maps an edit to the SECOND port of a two-port host", () => {
    const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
    const actual = expectedText
      .replace("listen 9500;", "listen 9510;")
      .replace("listen [::]:9500;", "listen [::]:9510;");
    expect(actual).not.toBe(expectedText);
    const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toContainEqual(
      expect.objectContaining({ kind: "stream-field", index: 1, field: "port", from: 9500, to: 9510 })
    );
  });

  it("never returns an empty result for an edited two-port host", () => {
    const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
    for (const [from, to] of [["9000", "9010"], ["9500", "9510"]]) {
      const actual = expectedText
        .replace(`listen ${from};`, `listen ${to};`)
        .replace(`listen [::]:${from};`, `listen [::]:${to};`);
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.edits.length + c.refusals.length).toBeGreaterThan(0);
    }
  });
  describe("stream port advanced bucket", () => {
    it("routes an unrecognised server-scope directive to the port's advanced bucket", () => {
      const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
      const actual = expectedText.replace(
        "    proxy_pass stream_host_7_port_0;",
        "    proxy_pass stream_host_7_port_0;\n    proxy_timeout 30s;"
      );
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.refusals).toEqual([]);
      expect(c.edits).toContainEqual(
        expect.objectContaining({ kind: "stream-field", index: 0, field: "advanced" })
      );
      const e = c.edits.find((x) => x.kind === "stream-field" && x.field === "advanced")!;
      expect((e as { to: string }).to).toContain("proxy_timeout 30s;");
    });

    it("attributes the bucket to the SECOND port when that is where the line sits", () => {
      const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
      const actual = expectedText.replace(
        "    proxy_pass stream_host_7_port_1;",
        "    proxy_pass stream_host_7_port_1;\n    proxy_timeout 45s;"
      );
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.refusals).toEqual([]);
      expect(c.edits).toContainEqual(
        expect.objectContaining({ kind: "stream-field", index: 1, field: "advanced" })
      );
    });

    it("still refuses a whole added server block", () => {
      const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
      const actual = expectedText + "\n\nserver {\n    listen 7777;\n    proxy_pass somewhere;\n}";
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.refusals.length).toBeGreaterThan(0);
    });

    it("still refuses an added listen line that pairs with no port", () => {
      const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
      const actual = expectedText.replace(
        "    listen 9000;",
        "    listen 9000;\n    listen 9001;"
      );
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.refusals.length).toBeGreaterThan(0);
    });

    it("still refuses an unrecognised directive inside the upstream block", () => {
      const expectedText = buildStreamBlock(twoPortHost.id, twoPortHost.streamPorts, null, null);
      const actual = expectedText.replace(
        "    server 10.0.0.1:9000;",
        "    server 10.0.0.1:9000;\n    keepalive 32;"
      );
      const c = classifyStreamDelta(diffAst(parse(expectedText), parse(actual)), twoPortHost);
      expect(c.refusals.length).toBeGreaterThan(0);
    });

    it("renders the bucket back into the port's server block", () => {
      const text = buildStreamBlock(
        7,
        [{ ...twoPortHost.streamPorts[0], advanced: "proxy_timeout 30s;" }],
        null,
        null
      );
      expect(text).toContain("proxy_timeout 30s;");
    });
  });

});

// ─── Flag removals against real parser output ───────────
//
// These cases exist to stop trusting `classify.ts`'s substring matching on
// `if` arguments (`includes("www")` / `includes("scheme")`). Every fixture is
// built from a REAL host row → buildServerBlock → text → delete the rendered
// fragment → parse both sides → diffAst → classifyDelta. Nothing here is a
// hand-built DirectiveRef, so a mismatch between what the tokenizer emits and
// what the heuristic looks for shows up as a failure instead of passing on a
// delta that could never occur in production.

const sslBase: HostConfig = {
  ...baseHost,
  sslType: "custom",
  sslCertPath: "/c.pem",
  sslKeyPath: "/k.pem",
};

/**
 * Delete exactly the text the template emits for `field`.
 *
 * The template pushes each flag's lines contiguously, so the ON rendering is
 * the OFF rendering with one contiguous run inserted. Stripping the common
 * leading and trailing lines isolates precisely that run. (A line-multiset
 * difference is NOT equivalent and is actively wrong here: the closing `}` of
 * an `if` block also occurs in the OFF text as a location's `}`, so it would
 * be spared and left orphaned, corrupting the brace structure and turning the
 * test into a parser-confusion test instead of a heuristics test.)
 */
function removeRenderedFragmentFor(host: HostConfig, field: keyof HostConfig) {
  const original = buildServerBlock(host, new Map());
  const on = original.split("\n");
  const off = buildServerBlock({ ...host, [field]: false }, new Map()).split("\n");

  let head = 0;
  while (head < off.length && on[head] === off[head]) head++;
  let tail = 0;
  while (
    tail < off.length - head &&
    on[on.length - 1 - tail] === off[off.length - 1 - tail]
  ) {
    tail++;
  }
  const edited = [...on.slice(0, head), ...on.slice(on.length - tail)].join("\n");
  return { original, edited, fragment: on.slice(head, on.length - tail).join("\n") };
}

describe("flag removals against real parser output", () => {
  it.each([
    ["hsts", { ...sslBase, hsts: true }],
    ["http2", { ...sslBase, http2: true }],
    ["compression", { ...sslBase, compression: true }],
    ["redirectWww", { ...sslBase, domains: ["www.example.com", "example.com"], redirectWww: true }],
    ["sslForceHttps", { ...sslBase, sslForceHttps: true }],
  ] as Array<[string, HostConfig]>)(
    "removing the %s output yields a single field edit and zero refusals",
    (field, host) => {
      const { original, edited } = removeRenderedFragmentFor(host, field as keyof HostConfig);
      expect(edited).not.toBe(original); // the flag really renders something

      const c = classifyDelta(diffAst(parse(original), parse(edited)), host);
      expect(c.refusals).toEqual([]);
      expect(c.edits).toContainEqual(
        expect.objectContaining({ kind: "field", field, from: true, to: false })
      );
    }
  );
  it("still refuses a lone gzip_vary removal, with gzip on left in place", () => {
    const host = { ...sslBase, compression: true };
    const original = buildServerBlock(host, new Map());
    const edited = original
      .split("\n")
      .filter((l) => !l.includes("gzip_vary"))
      .join("\n");
    expect(edited).not.toBe(original);

    const c = classifyDelta(diffAst(parse(original), parse(edited)), host);
    expect(c.refusals).toContainEqual(expect.objectContaining({ directive: "gzip_vary" }));
    expect(c.edits).toEqual([]);
  });
});

// The fixtures above diff against the hand-written BASE_SERVER constant, which
// contains `proxy_set_header X-Real-IP $remote_addr;` and no `add_header` at
// all — even though baseHost.headers is non-empty. That fixture was written to
// match the classifier rather than the generator, and that divergence is
// exactly why the header direction bug survived the suite (NUANCES §49).
// These cases diff against real generator output instead.
const HEADER_HOST: HostConfig = {
  ...baseHost,
  locations: [{ ...baseHost.locations[0], accessListId: null, basicAuth: null }],
};
const deltaFrom = (before: string, after: string) => diffAst(parse(before), parse(after));

describe("response headers", () => {
  it("maps an edited add_header to the location's headers map", () => {
    const before = buildServerBlock(HEADER_HOST, new Map());
    const after = before.replace(
      'add_header X-Real-IP "$remote_addr";',
      'add_header X-Real-IP "$http_x_real_ip";'
    );
    expect(after).not.toBe(before);
    const c = classifyDelta(deltaFrom(before, after), HEADER_HOST);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toEqual([
      expect.objectContaining({
        kind: "location-field",
        index: 0,
        field: "headers",
        to: { "X-Real-IP": "$http_x_real_ip" },
      }),
    ]);
  });

  it("maps a hand-added add_header into headers, with no fabricated second edit", () => {
    const before = buildServerBlock(HEADER_HOST, new Map());
    const after = before.replace(
      'add_header X-Real-IP "$remote_addr";',
      'add_header X-Real-IP "$remote_addr";\n        add_header X-Frame-Options "DENY";'
    );
    const c = classifyDelta(deltaFrom(before, after), HEADER_HOST);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toHaveLength(1);
    expect(c.edits[0]).toEqual(
      expect.objectContaining({
        field: "headers",
        to: { "X-Real-IP": "$remote_addr", "X-Frame-Options": "DENY" },
      })
    );
  });

  it("refuses an edit to the generated proxy_set_header boilerplate", () => {
    const before = buildServerBlock(HEADER_HOST, new Map());
    const after = before.replace(
      "proxy_set_header Host $host;",
      "proxy_set_header Host $custom_host;"
    );
    expect(after).not.toBe(before);
    const c = classifyDelta(deltaFrom(before, after), HEADER_HOST);
    expect(c.edits).toEqual([]);
    expect(c.refusals).toHaveLength(1);
    expect(c.refusals[0].directive).toBe("proxy_set_header");
    expect(c.refusals[0].reason).toContain("Advanced");
    expect(c.refusals[0].line).toBeGreaterThan(0);
  });

  it("refuses a hand-added proxy_set_header instead of inventing a response header", () => {
    const before = buildServerBlock(HEADER_HOST, new Map());
    const after = before.replace(
      "proxy_http_version 1.1;",
      "proxy_http_version 1.1;\n        proxy_set_header X-Tenant acme;"
    );
    const c = classifyDelta(deltaFrom(before, after), HEADER_HOST);
    expect(c.edits).toEqual([]);
    expect(c.refusals).toHaveLength(1);
    expect(c.refusals[0].directive).toBe("proxy_set_header");
  });

  it("still routes Strict-Transport-Security to the hsts flag, not to headers", () => {
    const host: HostConfig = {
      ...HEADER_HOST,
      hsts: true,
      sslType: "custom",
      sslCertPath: "/c.pem",
      sslKeyPath: "/k.pem",
    };
    const before = buildServerBlock(host, new Map());
    const after = before
      .split("\n")
      .filter((l) => !l.includes("Strict-Transport-Security"))
      .join("\n");
    expect(after).not.toBe(before);
    const c = classifyDelta(deltaFrom(before, after), host);
    expect(c.refusals).toEqual([]);
    expect(c.edits).toEqual([expect.objectContaining({ kind: "field", field: "hsts", to: false })]);
  });
});
