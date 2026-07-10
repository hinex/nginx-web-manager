import { describe, it, expect, vi } from "vitest";

// Mock DB modules
vi.mock("~/lib/db/connection", () => ({ db: {} }));
vi.mock("~/lib/db/schema", () => ({}));

import { buildUpstreamBlock } from "./templates/upstream";
import { buildSslDirectives } from "./templates/ssl";
import {
  buildAccessDirectives,
  buildHtpasswdContent,
  buildBasicAuthDirectives,
  buildBasicAuthOff,
} from "./templates/access";
import { buildServerBlock, type HostConfig } from "./templates/server-block";
import { buildStreamBlock } from "./templates/stream";

// ─── Upstream Block ─────────────────────────────────────

describe("buildUpstreamBlock", () => {
  it("generates round_robin upstream (no directive)", () => {
    const result = buildUpstreamBlock(
      "host_1_loc_0",
      [{ server: "10.0.0.1", port: 8080, weight: 1 }],
      "round_robin"
    );
    expect(result).toContain("upstream host_1_loc_0 {");
    expect(result).toContain("server 10.0.0.1:8080;");
    expect(result).not.toContain("least_conn");
    expect(result).not.toContain("ip_hash");
  });

  it("generates least_conn upstream", () => {
    const result = buildUpstreamBlock(
      "host_1_loc_0",
      [
        { server: "10.0.0.1", port: 8080, weight: 1 },
        { server: "10.0.0.2", port: 8080, weight: 1 },
      ],
      "least_conn"
    );
    expect(result).toContain("least_conn;");
    expect(result).toContain("server 10.0.0.1:8080;");
    expect(result).toContain("server 10.0.0.2:8080;");
  });

  it("generates ip_hash upstream", () => {
    const result = buildUpstreamBlock(
      "test",
      [{ server: "10.0.0.1", port: 80, weight: 1 }],
      "ip_hash"
    );
    expect(result).toContain("ip_hash;");
  });

  it("generates random upstream", () => {
    const result = buildUpstreamBlock(
      "test",
      [{ server: "10.0.0.1", port: 80, weight: 1 }],
      "random"
    );
    expect(result).toContain("random;");
  });

  it("generates weighted upstream with weight= on servers", () => {
    const result = buildUpstreamBlock(
      "test",
      [
        { server: "10.0.0.1", port: 80, weight: 3 },
        { server: "10.0.0.2", port: 80, weight: 1 },
      ],
      "weighted"
    );
    expect(result).toContain("server 10.0.0.1:80 weight=3;");
    expect(result).toContain("server 10.0.0.2:80;");
  });

  it("returns empty string for empty upstreams", () => {
    const result = buildUpstreamBlock("test", [], "round_robin");
    expect(result).toBe("");
  });
});

// ─── SSL Directives ─────────────────────────────────────

describe("buildSslDirectives", () => {
  it("returns empty for ssl type 'none'", () => {
    expect(buildSslDirectives("none", null, null, "example.com")).toBe("");
  });

  it("generates Let's Encrypt SSL paths", () => {
    const result = buildSslDirectives("letsencrypt", null, null, "example.com");
    expect(result).toContain(
      "ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;"
    );
    expect(result).toContain(
      "ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;"
    );
    expect(result).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
  });

  it("generates custom SSL paths", () => {
    const result = buildSslDirectives(
      "custom",
      "/ssl/cert.pem",
      "/ssl/key.pem",
      "example.com"
    );
    expect(result).toContain("ssl_certificate /ssl/cert.pem;");
    expect(result).toContain("ssl_certificate_key /ssl/key.pem;");
  });
});

// ─── Access Directives ──────────────────────────────────

describe("buildAccessDirectives", () => {
  it("generates IP rules with deny all", () => {
    const result = buildAccessDirectives({
      id: 1,
      name: "test",
      satisfy: "any",
      clients: [{ address: "10.0.0.0/8", directive: "allow" }],
      auth: [],
    });
    expect(result).toContain("allow 10.0.0.0/8;");
    expect(result).toContain("deny all;");
    expect(result).not.toContain("satisfy");
  });

  it("generates auth rules", () => {
    const result = buildAccessDirectives({
      id: 1,
      name: "test",
      satisfy: "any",
      clients: [],
      auth: [{ username: "admin", password: "$2b$..." }],
    });
    expect(result).toContain('auth_basic "Restricted";');
    expect(result).toContain(
      "auth_basic_user_file /data/nginx/auth/access-list-1.htpasswd;"
    );
    expect(result).not.toContain("satisfy");
  });

  it("generates satisfy directive when both IP and auth exist", () => {
    const result = buildAccessDirectives({
      id: 2,
      name: "combined",
      satisfy: "all",
      clients: [{ address: "192.168.1.0/24", directive: "allow" }],
      auth: [{ username: "admin", password: "$2b$..." }],
    });
    expect(result).toContain("satisfy all;");
    expect(result).toContain("allow 192.168.1.0/24;");
    expect(result).toContain("deny all;");
    expect(result).toContain('auth_basic "Restricted";');
  });
});

describe("buildHtpasswdContent", () => {
  it("generates htpasswd format", () => {
    const result = buildHtpasswdContent([
      { username: "admin", password: "$2b$10$hash1" },
      { username: "user", password: "$2b$10$hash2" },
    ]);
    expect(result).toBe("admin:$2b$10$hash1\nuser:$2b$10$hash2");
  });

  it("returns empty for no entries", () => {
    expect(buildHtpasswdContent([])).toBe("");
  });
});

// ─── Stream Block ───────────────────────────────────────

describe("buildStreamBlock", () => {
  it("generates TCP stream block", () => {
    const result = buildStreamBlock(1, [
      {
        port: 3306,
        protocol: "tcp",
        upstreams: [{ server: "db.internal", port: 3306, weight: 1 }],
        balanceMethod: "round_robin",
      },
    ]);
    expect(result).toContain("upstream stream_host_1_port_0 {");
    expect(result).toContain("server db.internal:3306;");
    expect(result).toContain("listen 3306;");
    expect(result).toContain("proxy_pass stream_host_1_port_0;");
  });

  it("generates UDP stream block", () => {
    const result = buildStreamBlock(1, [
      {
        port: 5353,
        protocol: "udp",
        upstreams: [{ server: "dns.internal", port: 53, weight: 1 }],
        balanceMethod: "round_robin",
      },
    ]);
    expect(result).toContain("listen 5353 udp;");
    expect(result).toContain("listen [::]:5353 udp;");
  });

  it("returns empty for no stream ports", () => {
    expect(buildStreamBlock(1, [])).toBe("");
  });

  it("skips stream ports with no upstreams", () => {
    const result = buildStreamBlock(1, [
      { port: 3306, protocol: "tcp", upstreams: [], balanceMethod: "round_robin" },
    ]);
    expect(result).toBe("");
  });
});

// ─── Server Block ───────────────────────────────────────

describe("buildServerBlock", () => {
  const baseHost: HostConfig = {
    id: 1,
    groupId: null,
    domains: ["example.com"],
    enabled: true,
    sslType: "none",
    sslForceHttps: false,
    sslCertPath: null,
    sslKeyPath: null,
    hsts: false,
    http2: true,
    compression: false,
    redirectWww: false,
    clientMaxBodySize: "1m",
    locations: [],
    advancedNginx: null,
    webhookUrl: null,
    errorPagesDir: null,
  };

  it("generates basic HTTP server block", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("listen 80;");
    expect(result).toContain("server_name example.com;");
    expect(result).toContain("upstream host_1_loc_0 {");
    expect(result).toContain("proxy_pass http://host_1_loc_0;");
    expect(result).toContain("proxy_set_header Host $host;");
    expect(result).not.toContain("listen 443");
  });

  it("generates SSL server block with HTTPS redirect", () => {
    const host: HostConfig = {
      ...baseHost,
      sslType: "letsencrypt",
      sslForceHttps: true,
      hsts: true,
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("listen 443 ssl;");
    expect(result).toContain("http2 on;");
    expect(result).toContain("ssl_certificate");
    expect(result).toContain("return 301 https://$host$request_uri;");
    expect(result).toContain("Strict-Transport-Security");
  });

  it("generates SSL without http2 when disabled", () => {
    const host: HostConfig = {
      ...baseHost,
      sslType: "letsencrypt",
      http2: false,
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("listen 443 ssl;");
    expect(result).not.toContain("http2");
  });

  it("includes compression directives", () => {
    const host: HostConfig = { ...baseHost, compression: true };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("gzip on;");
    expect(result).toContain("gzip_vary on;");
    expect(result).toContain("gzip_types");
  });

  it("includes client_max_body_size when not default", () => {
    const host: HostConfig = { ...baseHost, clientMaxBodySize: "50m" };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("client_max_body_size 50m;");
  });

  it("omits client_max_body_size when default 1m", () => {
    const result = buildServerBlock(baseHost, new Map());
    expect(result).not.toContain("client_max_body_size");
  });

  it("generates static location with alias and expires", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/static",
          matchType: "prefix",
          type: "static",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "/var/www/static",
          cacheExpires: "30d",
          forwardScheme: "",
          forwardDomain: "",
          forwardPath: "",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("location /static {");
    expect(result).toContain("alias /var/www/static;");
    expect(result).toContain("expires 30d;");
    expect(result).toContain('Cache-Control "public, no-transform"');
    expect(result).toContain("try_files $uri $uri/ =404;");
  });

  it("generates redirect location", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/old",
          matchType: "exact",
          type: "redirect",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "https",
          forwardDomain: "newsite.com",
          forwardPath: "/new",
          preservePath: false,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("location = /old {");
    expect(result).toContain("return 301 https://newsite.com/new;");
  });

  it("generates redirect with preservePath", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "redirect",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "https",
          forwardDomain: "newsite.com",
          forwardPath: "/",
          preservePath: true,
          statusCode: 302,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("return 302 https://newsite.com$request_uri;");
  });

  it("generates regex location", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "\\.(jpg|png|gif)$",
          matchType: "regex",
          type: "static",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "/var/www/images",
          cacheExpires: "7d",
          forwardScheme: "",
          forwardDomain: "",
          forwardPath: "",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("location ~ \\.(jpg|png|gif)$ {");
  });

  it("includes custom headers in location", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: { "X-Custom": "value", "X-Frame-Options": "DENY" },
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain('add_header X-Custom "value";');
    expect(result).toContain('add_header X-Frame-Options "DENY";');
  });

  it("includes advanced nginx directives", () => {
    const host: HostConfig = {
      ...baseHost,
      advancedNginx: "proxy_buffer_size 128k;\nproxy_buffers 4 256k;",
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("# Advanced directives");
    expect(result).toContain("proxy_buffer_size 128k;");
    expect(result).toContain("proxy_buffers 4 256k;");
  });

  it("includes access list directives in location", () => {
    const accessLists = new Map<number, any>();
    accessLists.set(1, {
      id: 1,
      name: "Office",
      satisfy: "any",
      clients: [{ address: "10.0.0.0/8", directive: "allow" }],
      auth: [{ username: "admin", password: "$2b$hash" }],
    });

    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: 1,
        },
      ],
    };
    const result = buildServerBlock(host, accessLists);
    expect(result).toContain("satisfy any;");
    expect(result).toContain("allow 10.0.0.0/8;");
    expect(result).toContain("deny all;");
    expect(result).toContain('auth_basic "Restricted";');
  });

  it("includes ACME challenge location", () => {
    const result = buildServerBlock(baseHost, new Map());
    expect(result).toContain("location /.well-known/acme-challenge/");
    expect(result).toContain("alias /data/acme-challenge/;");
  });

  it("includes per-host log paths", () => {
    const result = buildServerBlock(baseHost, new Map());
    expect(result).toContain("access_log /data/logs/host-1_access.log main;");
    expect(result).toContain("error_log /data/logs/host-1_error.log warn;");
  });

  it("returns empty for host with no domains", () => {
    const host: HostConfig = { ...baseHost, domains: [] };
    expect(buildServerBlock(host, new Map())).toBe("");
  });

  it("handles WWW redirect", () => {
    const host: HostConfig = {
      ...baseHost,
      domains: ["example.com", "www.example.com"],
      redirectWww: true,
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("if ($host ~ ^www\\.(.+)$)");
    expect(result).toContain("return 301 $scheme://example.com$request_uri;");
  });

  it("handles mixed location types (proxy + static + redirect)", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
        {
          path: "/assets",
          matchType: "prefix",
          type: "static",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "/var/www/assets",
          cacheExpires: "30d",
          forwardScheme: "",
          forwardDomain: "",
          forwardPath: "",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
        {
          path: "/old-page",
          matchType: "exact",
          type: "redirect",
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "https",
          forwardDomain: "example.com",
          forwardPath: "/new-page",
          preservePath: false,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("proxy_pass http://host_1_loc_0;");
    expect(result).toContain("alias /var/www/assets;");
    expect(result).toContain("return 301 https://example.com/new-page;");
  });
});

// ─── Protocol Support ───────────────────────────────────

describe("buildServerBlock protocol support", () => {
  const baseHost: HostConfig = {
    id: 1,
    groupId: null,
    domains: ["example.com"],
    enabled: true,
    sslType: "none",
    sslForceHttps: false,
    sslCertPath: null,
    sslKeyPath: null,
    hsts: false,
    http2: true,
    compression: false,
    redirectWww: false,
    clientMaxBodySize: "1m",
    locations: [],
    advancedNginx: null,
    webhookUrl: null,
    errorPagesDir: null,
  };

  it("generates proxy_pass with http protocol (default, no protocol field)", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("proxy_pass http://host_1_loc_0;");
    expect(result).toContain("proxy_set_header Host $host;");
  });

  it("generates proxy_pass with https protocol", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 443, weight: 1, protocol: "https" }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("proxy_pass https://host_1_loc_0;");
    expect(result).toContain("proxy_set_header Host $host;");
  });

  it("generates grpc_pass for grpc protocol", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 50051, weight: 1, protocol: "grpc" }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("grpc_pass grpc://host_1_loc_0;");
    expect(result).not.toContain("proxy_set_header");
    expect(result).not.toContain("proxy_pass");
  });

  it("generates grpc_pass for grpcs protocol", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 50051, weight: 1, protocol: "grpcs" }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("grpc_pass grpcs://host_1_loc_0;");
    expect(result).not.toContain("proxy_set_header");
  });

  it("generates fastcgi_pass for fastcgi protocol", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "127.0.0.1", port: 9000, weight: 1, protocol: "fastcgi" }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("fastcgi_pass host_1_loc_0;");
    expect(result).toContain("include fastcgi_params;");
    expect(result).toContain("fastcgi_param SCRIPT_FILENAME");
    expect(result).not.toContain("proxy_pass");
    expect(result).not.toContain("proxy_set_header");
  });
});

// ─── Edge Cases ─────────────────────────────────────────

describe("buildServerBlock edge cases", () => {
  const baseHost: HostConfig = {
    id: 1,
    groupId: null,
    domains: ["example.com"],
    enabled: true,
    sslType: "none",
    sslForceHttps: false,
    sslCertPath: null,
    sslKeyPath: null,
    hsts: false,
    http2: true,
    compression: false,
    redirectWww: false,
    clientMaxBodySize: "1m",
    locations: [],
    advancedNginx: null,
    webhookUrl: null,
    errorPagesDir: null,
  };

  it("handles XSS in domain names (passes through — nginx validates)", () => {
    const host: HostConfig = {
      ...baseHost,
      domains: ["<script>alert(1)</script>.com"],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("<script>alert(1)</script>.com");
  });

  it("handles null locations gracefully", () => {
    const host: HostConfig = { ...baseHost, locations: null as any };
    const result = buildServerBlock(host, new Map());
    // Should not throw
    expect(result).toContain("server {");
  });
});

// ─── Basic Auth Directives ──────────────────────────────

describe("buildBasicAuthDirectives", () => {
  it("generates auth_basic and auth_basic_user_file directives", () => {
    const result = buildBasicAuthDirectives("/data/nginx/auth/host-1.htpasswd");
    expect(result).toContain('auth_basic "Restricted";');
    expect(result).toContain("auth_basic_user_file /data/nginx/auth/host-1.htpasswd;");
  });
});

describe("buildBasicAuthOff", () => {
  it("generates auth_basic off directive", () => {
    const result = buildBasicAuthOff();
    expect(result).toBe("    auth_basic off;");
  });
});

// ─── Basic Auth in Server Block ─────────────────────────

describe("buildServerBlock basicAuth", () => {
  const baseHost: HostConfig = {
    id: 1,
    groupId: null,
    domains: ["example.com"],
    enabled: true,
    sslType: "none",
    sslForceHttps: false,
    sslCertPath: null,
    sslKeyPath: null,
    hsts: false,
    http2: true,
    compression: false,
    redirectWww: false,
    clientMaxBodySize: "1m",
    locations: [],
    advancedNginx: null,
    webhookUrl: null,
    errorPagesDir: null,
  };

  const baseLoc = {
    path: "/",
    matchType: "prefix" as const,
    type: "proxy" as const,
    upstreams: [{ server: "127.0.0.1", port: 3000, weight: 1 }],
    balanceMethod: "round_robin",
    staticDir: "",
    cacheExpires: "",
    forwardScheme: "http",
    forwardDomain: "",
    forwardPath: "/",
    preservePath: true,
    statusCode: 301,
    headers: {},
    accessListId: null,
  };

  it("inherits host-level auth when location has no basicAuth", () => {
    const host: HostConfig = {
      ...baseHost,
      basicAuth: {
        enabled: true,
        users: [{ username: "admin", password: "$2b$10$hash" }],
      },
      locations: [{ ...baseLoc }],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain('auth_basic "Restricted";');
    expect(result).toContain("auth_basic_user_file /data/nginx/auth/host-1.htpasswd;");
  });

  it("outputs auth_basic off when location explicitly disables auth", () => {
    const host: HostConfig = {
      ...baseHost,
      basicAuth: {
        enabled: true,
        users: [{ username: "admin", password: "$2b$10$hash" }],
      },
      locations: [{ ...baseLoc, basicAuth: { enabled: false } }],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain("auth_basic off;");
    expect(result).not.toContain("auth_basic_user_file");
  });

  it("uses location-level htpasswd when location has its own basicAuth", () => {
    const host: HostConfig = {
      ...baseHost,
      basicAuth: {
        enabled: true,
        users: [{ username: "admin", password: "$2b$10$hosthash" }],
      },
      locations: [
        {
          ...baseLoc,
          basicAuth: {
            enabled: true,
            users: [{ username: "locadmin", password: "$2b$10$lochash" }],
          },
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain('auth_basic "Restricted";');
    expect(result).toContain("auth_basic_user_file /data/nginx/auth/host-1-loc-0.htpasswd;");
    expect(result).not.toContain("auth_basic_user_file /data/nginx/auth/host-1.htpasswd;");
  });

  it("uses location htpasswd when only location has basicAuth", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [
        {
          ...baseLoc,
          basicAuth: {
            enabled: true,
            users: [{ username: "locuser", password: "$2b$10$hash" }],
          },
        },
      ],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).toContain('auth_basic "Restricted";');
    expect(result).toContain("auth_basic_user_file /data/nginx/auth/host-1-loc-0.htpasswd;");
  });

  it("outputs no auth directives when neither host nor location has basicAuth", () => {
    const host: HostConfig = {
      ...baseHost,
      locations: [{ ...baseLoc }],
    };
    const result = buildServerBlock(host, new Map());
    expect(result).not.toContain("auth_basic");
    expect(result).not.toContain("auth_basic_user_file");
  });
});
