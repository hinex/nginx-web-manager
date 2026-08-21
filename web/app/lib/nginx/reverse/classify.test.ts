import { describe, it, expect } from "vitest";
import { parse } from "~/lib/nginx/parser";
import { diffAst, type AstDelta } from "./match";
import { classifyDelta, type ClassifiedEdit } from "./classify";
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
