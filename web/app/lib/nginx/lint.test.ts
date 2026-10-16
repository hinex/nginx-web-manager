import { describe, it, expect } from "vitest";
import { lintConfig } from "./lint";

describe("lintConfig — long-lived Cache-Control with `always`", () => {
  it("warns on an immutable Cache-Control sent with `always`, with its line", () => {
    const text = [
      "location /assets/ {",
      "    root /srv/static;",
      "    try_files $uri =404;",
      '    add_header Cache-Control "public, max-age=31536000, immutable" always;',
      "}",
    ].join("\n");
    const warnings = lintConfig(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(4);
    expect(warnings[0].message).toContain("always");
  });

  it("warns on a long max-age without immutable", () => {
    expect(lintConfig('add_header Cache-Control "max-age=86400" always;')).toHaveLength(1);
  });

  it("warns on a long s-maxage (what a CDN honours)", () => {
    expect(lintConfig('add_header Cache-Control "public, s-maxage=600000" always;')).toHaveLength(1);
  });

  it("matches the header name case-insensitively, quoted or not", () => {
    expect(lintConfig("add_header 'cache-control' immutable always;")).toHaveLength(1);
  });

  it("finds the directive at server scope and in nested blocks", () => {
    const text = [
      "server {",
      '    add_header Cache-Control "immutable" always;',
      "    location / {",
      "        if ($x) {",
      '            add_header Cache-Control "max-age=31536000" always;',
      "        }",
      "    }",
      "}",
    ].join("\n");
    expect(lintConfig(text).map((w) => w.line)).toEqual([2, 5]);
  });

  it("is silent without `always` — nginx then skips error responses", () => {
    expect(lintConfig('add_header Cache-Control "public, max-age=31536000, immutable";')).toEqual([]);
  });

  it("is silent for short-lived or non-caching values", () => {
    expect(lintConfig('add_header Cache-Control "max-age=60" always;')).toEqual([]);
    expect(lintConfig('add_header Cache-Control "no-store" always;')).toEqual([]);
    expect(lintConfig('add_header Cache-Control "public, no-transform" always;')).toEqual([]);
  });

  it("is silent for other headers sent with `always`", () => {
    expect(lintConfig('add_header Strict-Transport-Security "max-age=31536000" always;')).toEqual([]);
  });

  it("returns no warnings for text it cannot parse instead of throwing", () => {
    expect(() => lintConfig("location / {")).not.toThrow();
    expect(() => lintConfig('add_header "unterminated')).not.toThrow();
  });
});
