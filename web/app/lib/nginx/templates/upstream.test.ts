import { describe, expect, it } from "vitest";
import { buildUpstreamBlock } from "./upstream";

// The form shows a Weight input on every upstream regardless of the balance
// method, and nginx honours `weight=` under round-robin, least_conn, ip_hash
// and random alike. Rendering it only for the synthetic "weighted" method
// dropped the operator's weight silently (NUANCES §64).
describe("buildUpstreamBlock weight", () => {
  const ups = [
    { server: "10.0.0.1", port: 80, weight: 5 },
    { server: "10.0.0.2", port: 80, weight: 1 },
  ];
  for (const method of ["round_robin", "weighted", "least_conn", "ip_hash", "random"]) {
    it(`renders weight>1 under ${method}`, () => {
      const out = buildUpstreamBlock("u", ups, method);
      expect(out).toContain("server 10.0.0.1:80 weight=5;");
      expect(out).toContain("server 10.0.0.2:80;");
    });
  }
});
