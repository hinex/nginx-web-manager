import { describe, it, expect } from "vitest";
import { render } from "./renderer";
import { parse } from "./ast";

describe("render", () => {
  it("renders a simple directive", () => {
    const config = parse("worker_processes auto;");
    expect(render(config)).toBe("worker_processes auto;\n");
  });

  it("renders a block directive", () => {
    const config = parse("events {\n    worker_connections 1024;\n}");
    const output = render(config);
    expect(output).toContain("events {");
    expect(output).toContain("    worker_connections 1024;");
    expect(output).toContain("}");
  });

  it("renders nested blocks with proper indentation", () => {
    const input = "http {\n    server {\n        listen 80;\n    }\n}";
    const config = parse(input);
    const output = render(config);
    expect(output).toContain("http {");
    expect(output).toContain("    server {");
    expect(output).toContain("        listen 80;");
    expect(output).toContain("    }");
  });

  it("preserves comments", () => {
    const config = parse("# Main config\nworker_processes auto;");
    const output = render(config);
    expect(output).toContain("# Main config");
    expect(output).toContain("worker_processes auto;");
  });

  it("round-trips simple config", () => {
    const input = "worker_processes auto;\nerror_log /var/log/nginx/error.log warn;\n";
    const config = parse(input);
    const output = render(config);
    expect(output.trim()).toBe(input.trim());
  });

  it("round-trips a full server block", () => {
    const input = `server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://backend;
    }
}`;
    const config = parse(input);
    const output = render(config);
    expect(output).toContain("listen 80;");
    expect(output).toContain("server_name example.com;");
    expect(output).toContain("proxy_pass http://backend;");
  });

  it("renders empty block", () => {
    const config = parse("events { }");
    const output = render(config);
    expect(output).toContain("events {");
    expect(output).toContain("}");
  });
});
