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
