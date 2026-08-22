import { describe, it, expect } from "vitest";
import { parse } from "~/lib/nginx/parser";
import { diffAst, scopeKey } from "./match";

const expected = parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`);

describe("scopeKey", () => {
  it("distinguishes match types on the same path", () => {
    const a = parse("location = /api { }").directives[0];
    const b = parse("location /api { }").directives[0];
    expect(scopeKey(a)).not.toBe(scopeKey(b));
  });
});

describe("diffAst", () => {
  it("returns an empty delta for identical configs", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`));
    expect(delta).toEqual({ added: [], removed: [], changed: [] });
  });

  it("ignores whitespace and comment differences", () => {
    const delta = diffAst(expected, parse(`
# hand written note
server {
  listen 80;
      server_name example.com;

  client_max_body_size 1m;
  location /api { proxy_pass http://10.0.0.1:8080; }
}
`));
    expect(delta).toEqual({ added: [], removed: [], changed: [] });
  });

  it("detects a changed argument and reports its line in the edited file", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 50m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`));
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].before.args).toEqual(["1m"]);
    expect(delta.changed[0].after.args).toEqual(["50m"]);
    expect(delta.changed[0].after.name).toBe("client_max_body_size");
    expect(delta.changed[0].after.line).toBe(5);
    expect(delta.changed[0].after.scope).toEqual(["server"]);
  });

  it("detects a directive added inside a location and scopes it correctly", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
        proxy_read_timeout 300s;
    }
}
`));
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].name).toBe("proxy_read_timeout");
    expect(delta.added[0].scope).toEqual(["server", "location /api"]);
    expect(delta.added[0].text).toBe("proxy_read_timeout 300s;");
  });

  it("detects a removed directive", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`));
    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0].name).toBe("client_max_body_size");
  });

  it("detects a whole location block added, with its body in text", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
    location /health {
        return 200 "ok";
    }
}
`));
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].name).toBe("location");
    expect(delta.added[0].args).toEqual(["/health"]);
    expect(delta.added[0].text).toContain("return 200");
  });

  it("detects a whole location block removed", () => {
    const delta = diffAst(expected, parse(`
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
}
`));
    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0].name).toBe("location");
    expect(delta.removed[0].args).toEqual(["/api"]);
  });

  it("detects a block added outside the server block", () => {
    const delta = diffAst(expected, parse(`
upstream backend {
    server 10.0.0.5:9000;
}
server {
    listen 80;
    server_name example.com;
    client_max_body_size 1m;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`));
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].name).toBe("upstream");
    expect(delta.added[0].scope).toEqual([]);
  });

  it("pairs repeated same-name directives positionally", () => {
    const base = parse(`server { add_header A 1; add_header B 2; }`);
    const delta = diffAst(base, parse(`server { add_header A 1; add_header B 3; }`));
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].after.args).toEqual(["B", "3"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });
});

const twoServers = parse(`
server {
    listen 80;
    server_name www.example.com;
    return 301 https://example.com$request_uri;
}
server {
    listen 443 ssl;
    server_name example.com;
    client_max_body_size 5m;
}
`);

describe("sibling blocks that share a scope key", () => {
  it("detects an edit inside the first of two server blocks", () => {
    const delta = diffAst(twoServers, parse(`
server {
    listen 8080;
    server_name www.example.com;
    return 301 https://example.com$request_uri;
}
server {
    listen 443 ssl;
    server_name example.com;
    client_max_body_size 5m;
}
`));
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].after.args).toEqual(["8080"]);
    expect(delta.changed[0].after.scope).toEqual(["server"]);
  });

  it("suffixes the scope key of later occurrences only", () => {
    const delta = diffAst(twoServers, parse(`
server {
    listen 80;
    server_name www.example.com;
    return 301 https://example.com$request_uri;
}
server {
    listen 443 ssl;
    server_name example.com;
    client_max_body_size 50m;
}
`));
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].after.scope).toEqual(["server#1"]);
  });

  it("does not silently swallow the removal of the first server block", () => {
    const delta = diffAst(twoServers, parse(`
server {
    listen 443 ssl;
    server_name example.com;
    client_max_body_size 5m;
}
`));
    expect(delta.added.length + delta.removed.length + delta.changed.length).toBeGreaterThan(0);
  });

  it("still pairs a lone server block on the bare key", () => {
    const one = parse(`server { listen 80; }`);
    const delta = diffAst(one, parse(`server { listen 81; }`));
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].after.scope).toEqual(["server"]);
  });
});

describe("keyed directives", () => {
  it("pairs add_header by header name, not by position", () => {
    const before = `server {\n  location /api {\n    add_header X-Real-IP "$remote_addr";\n  }\n}`;
    const after = `server {\n  location /api {\n    add_header X-Frame-Options DENY;\n    add_header X-Real-IP "$remote_addr";\n  }\n}`;
    const d = diffAst(parse(before), parse(after));
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].args[0]).toBe("X-Frame-Options");
  });

  it("still reports a real edit of an existing header", () => {
    const before = `server {\n  location /api {\n    add_header X-Real-IP "$remote_addr";\n  }\n}`;
    const after = `server {\n  location /api {\n    add_header X-Real-IP "$http_x_real_ip";\n  }\n}`;
    const d = diffAst(parse(before), parse(after));
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].after.args.join(" ")).toBe('X-Real-IP "$http_x_real_ip"');
    expect(d.added).toEqual([]);
  });

  it("reports a deleted header as removed, not as a change of its neighbour", () => {
    const before = `server {\n  location /api {\n    add_header A 1;\n    add_header B 2;\n  }\n}`;
    const after = `server {\n  location /api {\n    add_header B 2;\n  }\n}`;
    const d = diffAst(parse(before), parse(after));
    expect(d.changed).toEqual([]);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].args[0]).toBe("A");
  });

  it("keeps duplicate header keys distinct by occurrence", () => {
    const before = `server {\n  location /api {\n    add_header A 1;\n    add_header A 2;\n  }\n}`;
    const after = `server {\n  location /api {\n    add_header A 1;\n    add_header A 3;\n  }\n}`;
    const d = diffAst(parse(before), parse(after));
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].before.args.join(" ")).toBe("A 2");
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("pairs proxy_set_header by header name too", () => {
    const before = `server {\n  location /api {\n    proxy_set_header Host $host;\n  }\n}`;
    const after = `server {\n  location /api {\n    proxy_set_header X-Custom 1;\n    proxy_set_header Host $host;\n  }\n}`;
    const d = diffAst(parse(before), parse(after));
    expect(d.changed).toEqual([]);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].args[0]).toBe("X-Custom");
  });
});
