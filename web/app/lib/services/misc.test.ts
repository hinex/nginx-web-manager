import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/nginx/validator", () => ({ validateNginxConfig: vi.fn(() => ({ valid: true })) }));
vi.mock("~/lib/nginx/reload", () => ({ reloadNginx: vi.fn(() => true) }));
vi.mock("~/lib/system/stats", () => ({ getSystemStats: vi.fn(() => ({ cpu: 1 })) }));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));
vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from"]) chain[m] = vi.fn(() => chain);
  chain.all = vi.fn(() => [{ id: 1 }]);
  return { db: chain };
});
vi.mock("~/lib/db/schema", () => ({ hosts: {} }));

import { logAudit } from "~/lib/audit/log";
import { reloadNginx } from "~/lib/nginx/reload";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import { ForbiddenError } from "./errors";
import { validate, reload } from "./nginx";
import { getStats } from "./stats";
import { listHosts } from "./hosts";

const ctx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "admin",
  via: "token",
  tokenId: 3,
  scopes,
});

beforeEach(() => vi.clearAllMocks());

describe("nginx service", () => {
  it("validate requires nginx:validate", () => {
    expect(() => validate(ctx([]))).toThrow(ForbiddenError);
    expect(validate(ctx(["nginx:validate"]))).toEqual({ valid: true });
  });

  it("reload requires nginx:reload and audits with tokenId", () => {
    expect(() => reload(ctx([]))).toThrow(ForbiddenError);
    expect(reload(ctx(["nginx:reload"]))).toEqual({ reloaded: true });
    expect(reloadNginx).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reload",
        entity: "nginx",
        details: expect.objectContaining({ tokenId: 3, via: "token" }),
      })
    );
  });
});

describe("stats service", () => {
  it("requires stats:read", () => {
    expect(() => getStats(ctx([]))).toThrow(ForbiddenError);
    expect(getStats(ctx(["stats:read"]))).toEqual({ cpu: 1 });
  });
});

describe("hosts service", () => {
  it("requires hosts:read", () => {
    expect(() => listHosts(ctx([]))).toThrow(ForbiddenError);
    expect(listHosts(ctx(["hosts:read"]))).toEqual([{ id: 1 }]);
  });
});
