import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  parseFile,
  listConfigFiles,
  resolveIncludes,
  writeConfig,
} from "./index";

const TEST_DIR = "/tmp/nginx-parser-test";

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "conf.d"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "nginx.conf"),
    "worker_processes auto;\nhttp {\n    include /tmp/nginx-parser-test/conf.d/*.conf;\n}\n"
  );
  writeFileSync(
    join(TEST_DIR, "conf.d", "site.conf"),
    "server {\n    listen 80;\n    server_name test.com;\n}\n"
  );
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseFile", () => {
  it("parses a config file from disk", () => {
    const config = parseFile(join(TEST_DIR, "nginx.conf"));
    expect(config.filePath).toBe(join(TEST_DIR, "nginx.conf"));
    expect(config.directives.length).toBeGreaterThan(0);
    expect(config.directives[0].name).toBe("worker_processes");
  });
});

describe("listConfigFiles", () => {
  it("lists all .conf files recursively", () => {
    const files = listConfigFiles(TEST_DIR);
    expect(files).toContain(join(TEST_DIR, "nginx.conf"));
    expect(files).toContain(join(TEST_DIR, "conf.d", "site.conf"));
  });
});

describe("resolveIncludes", () => {
  it("resolves include directives to actual file paths", () => {
    const config = parseFile(join(TEST_DIR, "nginx.conf"));
    const resolved = resolveIncludes(config);
    const http = resolved.directives.find(d => d.name === "http");
    expect(http).toBeDefined();
    expect(resolved.includes).toBeDefined();
    expect(resolved.includes!.length).toBeGreaterThan(0);
    expect(resolved.includes![0].filePath).toContain("site.conf");
  });
});

describe("writeConfig", () => {
  it("writes AST back to a file", () => {
    const config = parseFile(join(TEST_DIR, "conf.d", "site.conf"));
    const outPath = join(TEST_DIR, "conf.d", "output.conf");
    writeConfig(config, outPath);
    const reparsed = parseFile(outPath);
    expect(reparsed.directives[0].name).toBe("server");
  });
});
