import { describe, it, expect } from "vitest";
import { hostIdFromConfigPath, hostConfigFileNames } from "./config-link";

describe("hostIdFromConfigPath", () => {
  it("reads the id of an HTTP host file", () => {
    expect(hostIdFromConfigPath("/data/nginx/conf.d/host-15.conf")).toBe(15);
  });
  it("reads the id of a stream host file", () => {
    expect(hostIdFromConfigPath("/data/nginx/stream.d/host-7-stream.conf")).toBe(7);
  });
  it("ignores files that are not generated per host", () => {
    for (const p of ["/etc/nginx/nginx.conf", "/x/host-.conf", "/x/myhost-3.conf", "/x/host-3.conf.bak", "/x/host-3-other.conf"]) {
      expect(hostIdFromConfigPath(p)).toBeNull();
    }
  });
  it("round-trips with hostConfigFileNames", () => {
    for (const name of hostConfigFileNames(42)) expect(hostIdFromConfigPath(`/d/${name}`)).toBe(42);
  });
});
