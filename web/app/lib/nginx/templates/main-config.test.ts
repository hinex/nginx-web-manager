import { describe, it, expect } from "vitest";
import {
  renderMainConfig,
  parseHashSize,
  validateHashSize,
  DEFAULT_MAP_HASH_MAX_SIZE,
  DEFAULT_MAP_HASH_BUCKET_SIZE,
  MAX_HASH_SIZE,
} from "./main-config";

const lines = (cfg: string) => cfg.split("\n").map((l) => l.trim());

describe("renderMainConfig map hash sizing", () => {
  const cfg = renderMainConfig({ mapHashMaxSize: 262144, mapHashBucketSize: 256 });

  it("renders the configured values", () => {
    expect(lines(cfg)).toContain("map_hash_max_size 262144;");
    expect(lines(cfg)).toContain("map_hash_bucket_size 256;");
  });

  // nginx fixes both values when it parses the first `map` in http; set after
  // that point they are rejected as "duplicate" (NUANCES #68). So they must
  // precede every map and the host includes, where user maps live.
  it("declares both before the first map and before the host includes", () => {
    const l = lines(cfg);
    const firstMap = l.findIndex((x) => x.startsWith("map "));
    const include = l.findIndex((x) => x.startsWith("include /data/nginx/conf.d/"));
    const maxAt = l.indexOf("map_hash_max_size 262144;");
    const bucketAt = l.indexOf("map_hash_bucket_size 256;");
    expect(firstMap).toBeGreaterThan(-1);
    expect(include).toBeGreaterThan(-1);
    for (const at of [maxAt, bucketAt]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstMap);
      expect(at).toBeLessThan(include);
    }
  });

  it("declares each directive exactly once", () => {
    expect(cfg.match(/map_hash_max_size /g)).toHaveLength(1);
    expect(cfg.match(/map_hash_bucket_size /g)).toHaveLength(1);
  });

  it("keeps nginx variables literal", () => {
    expect(cfg).toContain("map $upstream_http_x_request_id $req_id {");
    expect(cfg).toContain("'$remote_addr - $remote_user");
  });
});

describe("hash size settings", () => {
  it("accepts positive whole numbers up to the cap", () => {
    expect(validateHashSize("262144")).toBe(262144);
    expect(validateHashSize(" 256 ")).toBe(256);
    expect(validateHashSize(String(MAX_HASH_SIZE))).toBe(MAX_HASH_SIZE);
  });

  it("rejects anything nginx would not take", () => {
    for (const bad of ["0", "-1", "1.5", "1e3", "abc", "256k", "", String(MAX_HASH_SIZE + 1), "1; include x"]) {
      expect(validateHashSize(bad)).toBeNull();
    }
  });

  it("falls back to the default when unset, empty or invalid", () => {
    expect(parseHashSize(undefined, DEFAULT_MAP_HASH_MAX_SIZE)).toBe(8192);
    expect(parseHashSize(null, DEFAULT_MAP_HASH_BUCKET_SIZE)).toBe(128);
    expect(parseHashSize("  ", 8192)).toBe(8192);
    expect(parseHashSize("garbage", 8192)).toBe(8192);
    expect(parseHashSize("262144", 8192)).toBe(262144);
  });
});
