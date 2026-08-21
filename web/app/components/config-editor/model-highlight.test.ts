import { describe, it, expect } from "vitest";
import { modelLines } from "./model-highlight";

describe("modelLines", () => {
  it("reports a client_max_body_size line with the host field it maps to", () => {
    const content = `
server {
    listen 80;
    server_name example.com;
    client_max_body_size 50m;
}
`;
    const lines = modelLines(content);
    const hit = lines.find((l) => l.field === "clientMaxBodySize");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(5);
  });

  it("does not report an unrecognised directive inside server{}", () => {
    const content = `
server {
    listen 80;
    server_name example.com;
    proxy_read_timeout 300s;
}
`;
    const lines = modelLines(content);
    expect(lines.some((l) => l.field.includes("proxy_read_timeout"))).toBe(false);
    // Nothing about the unrecognised directive's line should be reported at all.
    expect(lines.some((l) => l.line === 5)).toBe(false);
  });

  it("reports a proxy_pass inside location /api scoped to its location index", () => {
    const content = `
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`;
    const lines = modelLines(content);
    const hit = lines.find((l) => l.field === "locations[0].upstreams");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(6);
  });

  it("reports a server_name line as the domains field", () => {
    const content = `
server {
    listen 80;
    server_name example.com www.example.com;
}
`;
    const lines = modelLines(content);
    const hit = lines.find((l) => l.field === "domains");
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(4);
  });

  it("returns an empty array for an empty config", () => {
    expect(modelLines("")).toEqual([]);
  });

  it("scopes a second location's fields to index 1", () => {
    const content = `
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
    location /health {
        alias /var/www/health;
    }
}
`;
    const lines = modelLines(content);
    expect(lines.find((l) => l.field === "locations[0].upstreams")).toBeDefined();
    const secondLoc = lines.find((l) => l.field === "locations[1].staticDir");
    expect(secondLoc).toBeDefined();
    expect(secondLoc!.line).toBe(9);
  });

  it("re-exports syntaxError from the reverse-sync scanner without duplicating it", async () => {
    const mod = await import("./model-highlight");
    const { syntaxError } = await import("~/lib/nginx/reverse/syntax");
    expect(mod.syntaxError).toBe(syntaxError);
  });
});
