import { describe, it, expect } from "vitest";
import { parse } from "./ast";

describe("parse", () => {
  it("parses a simple directive", () => {
    const config = parse("worker_processes auto;");
    expect(config.directives).toHaveLength(1);
    expect(config.directives[0].name).toBe("worker_processes");
    expect(config.directives[0].args).toEqual(["auto"]);
    expect(config.directives[0].block).toBeUndefined();
  });

  it("parses a block directive", () => {
    const config = parse("events {\n    worker_connections 1024;\n}");
    expect(config.directives).toHaveLength(1);
    const events = config.directives[0];
    expect(events.name).toBe("events");
    expect(events.block).toBeDefined();
    expect(events.block!.directives).toHaveLength(1);
    expect(events.block!.directives[0].name).toBe("worker_connections");
    expect(events.block!.directives[0].args).toEqual(["1024"]);
  });

  it("parses nested blocks", () => {
    const input = `
http {
    server {
        listen 80;
        server_name example.com;
        location / {
            proxy_pass http://backend;
        }
    }
}`;
    const config = parse(input);
    const http = config.directives[0];
    expect(http.name).toBe("http");
    const server = http.block!.directives[0];
    expect(server.name).toBe("server");
    const listen = server.block!.directives[0];
    expect(listen.name).toBe("listen");
    expect(listen.args).toEqual(["80"]);
    const location = server.block!.directives[2];
    expect(location.name).toBe("location");
    expect(location.args).toEqual(["/"]);
    expect(location.block!.directives[0].name).toBe("proxy_pass");
  });

  it("preserves comments", () => {
    const config = parse("# Main config\nworker_processes auto;");
    expect(config.directives[0].comments).toEqual(["# Main config"]);
  });

  it("parses location with modifier", () => {
    const config = parse("location = /health { return 200; }");
    const loc = config.directives[0];
    expect(loc.name).toBe("location");
    expect(loc.args).toEqual(["=", "/health"]);
  });

  it("parses multiple directives with same name", () => {
    const input = "listen 80;\nlisten [::]:80;";
    const config = parse(input);
    expect(config.directives).toHaveLength(2);
    expect(config.directives[0].args).toEqual(["80"]);
    expect(config.directives[1].args).toEqual(["[::]:80"]);
  });

  it("parses listen with ssl flag", () => {
    const config = parse("listen 443 ssl;");
    expect(config.directives[0].args).toEqual(["443", "ssl"]);
  });

  it("parses if block", () => {
    const config = parse('if ($scheme = http) {\n    return 301 https://$host$request_uri;\n}');
    const ifBlock = config.directives[0];
    expect(ifBlock.name).toBe("if");
    expect(ifBlock.args).toEqual(["($scheme", "=", "http)"]);
    expect(ifBlock.block!.directives[0].name).toBe("return");
  });

  it("handles empty blocks", () => {
    const config = parse("events { }");
    expect(config.directives[0].block!.directives).toHaveLength(0);
  });

  it("parses multi-value directives", () => {
    const config = parse('gzip_types text/plain text/css application/json;');
    expect(config.directives[0].name).toBe("gzip_types");
    expect(config.directives[0].args).toEqual(["text/plain", "text/css", "application/json"]);
  });
});
