/**
 * Route-level tests for /api/v1/hosts endpoints.
 * Services are mocked; toResponse is real (imported from shared.ts).
 * Every response must carry Content-Type: application/json.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── service mocks ──────────────────────────────────────────────────────────
vi.mock("~/lib/services/hosts", () => ({
  listHosts: vi.fn(() => []),
  getHost: vi.fn(() => ({ id: 1, domains: ["example.com"] })),
  createHost: vi.fn(async () => ({ id: 2, domains: ["new.example.com"], draft: {} })),
  updateHost: vi.fn(async () => ({ id: 1, domains: ["example.com"], draft: { domains: ["updated.example.com"] } })),
  discardHostDraft: vi.fn(() => ({ id: 1, domains: ["example.com"], draft: null })),
  publishHost: vi.fn(async () => ({ id: 1, domains: ["example.com"], draft: null, enabled: true })),
  deleteHost: vi.fn(async () => ({ deleted: true })),
}));

// ── auth mock ──────────────────────────────────────────────────────────────
vi.mock("~/lib/auth/authenticate", () => ({
  authenticate: vi.fn(),
}));

// ── DB / session mocks so authenticate import doesn't blow up ─────────────
vi.mock("~/lib/db/connection", () => ({ db: {} }));
vi.mock("~/lib/db/schema", () => ({ users: {}, settings: {}, hosts: {} }));
vi.mock("~/lib/auth/session.server", () => ({ getSessionUser: vi.fn(() => null) }));
vi.mock("~/lib/auth/middleware", () => ({
  checkIpWhitelist: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("~/lib/auth/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  recordFailedAttempt: vi.fn(),
}));
vi.mock("~/lib/auth/tokens", () => ({ verifyApiToken: vi.fn(() => ({ ok: false, reason: "no" })) }));

import { authenticate } from "~/lib/auth/authenticate";
import * as hostsService from "~/lib/services/hosts";
import { ForbiddenError, NotFoundError, HostValidationError, InputValidationError } from "~/lib/services/errors";
import { parsePositiveInt } from "./shared";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";

// ── route handlers under test ──────────────────────────────────────────────
import { loader as hostsLoader, action as hostsAction } from "./hosts";
import { loader as hostsIdLoader, action as hostsIdAction } from "./hosts.$id";
import { loader as hostsDraftLoader, action as hostsDraftAction } from "./hosts.$id.draft";
import { loader as hostsPublishLoader, action as hostsPublishAction } from "./hosts.$id.publish";

// ── helpers ────────────────────────────────────────────────────────────────
const authedCtx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "editor",
  via: "token",
  tokenId: 7,
  scopes,
});

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Request {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function assertJson(res: Response) {
  const ct = res.headers.get("content-type") ?? "";
  expect(ct, `Expected application/json Content-Type but got: ${ct}`).toContain(
    "application/json"
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: auth succeeds with full scopes
  vi.mocked(authenticate).mockResolvedValue(
    authedCtx(["hosts:read", "hosts:write", "hosts:publish"])
  );
  vi.mocked(hostsService.listHosts).mockReturnValue([] as any);
  vi.mocked(hostsService.getHost).mockReturnValue({ id: 1, domains: ["example.com"] } as any);
  vi.mocked(hostsService.createHost).mockResolvedValue({ id: 2, domains: ["new.example.com"], draft: {} } as any);
  vi.mocked(hostsService.updateHost).mockResolvedValue({ id: 1, domains: ["example.com"], draft: { domains: ["updated.example.com"] } } as any);
  vi.mocked(hostsService.discardHostDraft).mockReturnValue({ id: 1, domains: ["example.com"], draft: null } as any);
  vi.mocked(hostsService.publishHost).mockResolvedValue({ id: 1, domains: ["example.com"], draft: null, enabled: true } as any);
  vi.mocked(hostsService.deleteHost).mockResolvedValue({ deleted: true } as any);
});

// ═══════════════════════════════════════════════════════════════════════════
// 401 without Bearer
// ═══════════════════════════════════════════════════════════════════════════
describe("401 without Bearer", () => {
  beforeEach(() => {
    vi.mocked(authenticate).mockRejectedValue(
      Response.json({ error: "Authentication required" }, { status: 401 })
    );
  });

  it("GET /api/v1/hosts → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts", { method: "GET" });
    const res = await hostsLoader({ request: req, params: {} });
    expect(res.status).toBe(401);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("code");
  });

  it("GET /api/v1/hosts/1 → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1", { method: "GET" });
    const res = await hostsIdLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(401);
    assertJson(res);
  });

  it("DELETE /api/v1/hosts/1/draft → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1/draft", { method: "DELETE" });
    const res = await hostsDraftAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(401);
    assertJson(res);
  });

  it("POST /api/v1/hosts/1/publish → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1/publish", { method: "POST" });
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(401);
    assertJson(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 401 missing — POST /hosts, PATCH /hosts/:id, DELETE /hosts/:id
// ═══════════════════════════════════════════════════════════════════════════
describe("401 for mutating routes without Bearer", () => {
  beforeEach(() => {
    vi.mocked(authenticate).mockRejectedValue(
      Response.json({ error: "Authentication required" }, { status: 401 })
    );
  });

  it("POST /api/v1/hosts → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["x.com"] }),
    });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(401);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("code");
  });

  it("PATCH /api/v1/hosts/1 → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: ["x.com"] }),
    });
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(401);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("code");
  });

  it("DELETE /api/v1/hosts/1 → 401 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1", { method: "DELETE" });
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(401);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("code");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 400 on bad :id — many malformed variants
// ═══════════════════════════════════════════════════════════════════════════
describe("400 on bad :id", () => {
  const badIds = ["abc", "12abc", "1.5", "0", "-1", "-100", "NaN", " ", ""];

  for (const badId of badIds) {
    it(`GET /api/v1/hosts/${JSON.stringify(badId)} → 400`, async () => {
      const req = makeRequest("GET", `http://localhost/api/v1/hosts/${badId}`);
      const res = await hostsIdLoader({ request: req, params: { id: badId } });
      expect(res.status).toBe(400);
      assertJson(res);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("code");
    });

    it(`PATCH /api/v1/hosts/${JSON.stringify(badId)} → 400`, async () => {
      const req = makeRequest("PATCH", `http://localhost/api/v1/hosts/${badId}`, { domains: ["x.com"] });
      const res = await hostsIdAction({ request: req, params: { id: badId } });
      expect(res.status).toBe(400);
      assertJson(res);
    });

    it(`DELETE /api/v1/hosts/${JSON.stringify(badId)} → 400`, async () => {
      const req = makeRequest("DELETE", `http://localhost/api/v1/hosts/${badId}`);
      const res = await hostsIdAction({ request: req, params: { id: badId } });
      expect(res.status).toBe(400);
      assertJson(res);
    });

    it(`DELETE /api/v1/hosts/${JSON.stringify(badId)}/draft → 400`, async () => {
      const req = makeRequest("DELETE", `http://localhost/api/v1/hosts/${badId}/draft`);
      const res = await hostsDraftAction({ request: req, params: { id: badId } });
      expect(res.status).toBe(400);
      assertJson(res);
    });

    it(`POST /api/v1/hosts/${JSON.stringify(badId)}/publish → 400`, async () => {
      const req = makeRequest("POST", `http://localhost/api/v1/hosts/${badId}/publish`);
      const res = await hostsPublishAction({ request: req, params: { id: badId } });
      expect(res.status).toBe(400);
      assertJson(res);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 400 InputValidationError — unknown field / bad domain
// ═══════════════════════════════════════════════════════════════════════════
describe("400 InputValidationError → {error, code}", () => {
  it("POST /api/v1/hosts with unknown field → 400 with message in error", async () => {
    vi.mocked(hostsService.createHost).mockRejectedValue(
      new InputValidationError("Unknown field: labelIds")
    );
    const req = makeRequest("POST", "http://localhost/api/v1/hosts", { labelIds: [1] });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toBe("Unknown field: labelIds");
    // consistent with every other error shape in this API
    expect(body.code).toBe("input_validation_error");
  });

  it("PATCH /api/v1/hosts/:id with unknown field → 400 with message in error", async () => {
    vi.mocked(hostsService.updateHost).mockRejectedValue(
      new InputValidationError("Unknown field: foo")
    );
    const req = makeRequest("PATCH", "http://localhost/api/v1/hosts/1", { foo: "bar" });
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(400);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toBe("Unknown field: foo");
  });

  it("POST /api/v1/hosts with invalid domain → 400 with message in error", async () => {
    vi.mocked(hostsService.createHost).mockRejectedValue(
      new InputValidationError("Invalid domain: not_a_domain!")
    );
    const req = makeRequest("POST", "http://localhost/api/v1/hosts", { domains: ["not_a_domain!"] });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toContain("Invalid domain");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parsePositiveInt — MAX_SAFE_INTEGER boundary
// ═══════════════════════════════════════════════════════════════════════════
describe("parsePositiveInt — bounds", () => {
  it("accepts Number.MAX_SAFE_INTEGER", () => {
    expect(parsePositiveInt(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a 22-digit integer (> MAX_SAFE_INTEGER) → null", () => {
    expect(parsePositiveInt("9".repeat(22))).toBeNull();
  });

  it("rejects 9007199254740992 (MAX_SAFE_INTEGER + 1) → null", () => {
    expect(parsePositiveInt("9007199254740992")).toBeNull();
  });

  it("GET /api/v1/hosts/:id with astronomically large id → 400", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/99999999999999999999");
    const res = await hostsIdLoader({ request: req, params: { id: "99999999999999999999" } });
    expect(res.status).toBe(400);
    assertJson(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 403 ForbiddenError via service
// ═══════════════════════════════════════════════════════════════════════════
describe("403 ForbiddenError mapped", () => {
  it("GET /api/v1/hosts throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.listHosts).mockImplementation(() => {
      throw new ForbiddenError("hosts:read");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/hosts");
    const res = await hostsLoader({ request: req, params: {} });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
    expect(body.error).toContain("hosts:read");
  });

  it("POST /api/v1/hosts throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.createHost).mockRejectedValue(new ForbiddenError("hosts:write"));
    const req = makeRequest("POST", "http://localhost/api/v1/hosts", { domains: ["x.com"] });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });

  it("GET /api/v1/hosts/:id throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.getHost).mockImplementation(() => {
      throw new ForbiddenError("hosts:read");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/1");
    const res = await hostsIdLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });

  it("PATCH /api/v1/hosts/:id throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.updateHost).mockRejectedValue(new ForbiddenError("hosts:write"));
    const req = makeRequest("PATCH", "http://localhost/api/v1/hosts/1", { domains: ["x.com"] });
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });

  it("DELETE /api/v1/hosts/:id throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.deleteHost).mockRejectedValue(new ForbiddenError("hosts:publish"));
    const req = makeRequest("DELETE", "http://localhost/api/v1/hosts/1");
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });

  it("DELETE /api/v1/hosts/:id/draft throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.discardHostDraft).mockImplementation(() => {
      throw new ForbiddenError("hosts:write");
    });
    const req = makeRequest("DELETE", "http://localhost/api/v1/hosts/1/draft");
    const res = await hostsDraftAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });

  it("POST /api/v1/hosts/:id/publish throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(hostsService.publishHost).mockRejectedValue(new ForbiddenError("hosts:publish"));
    const req = makeRequest("POST", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 404 NotFoundError
// ═══════════════════════════════════════════════════════════════════════════
describe("404 NotFoundError mapped", () => {
  it("GET /api/v1/hosts/999 → 404 JSON", async () => {
    vi.mocked(hostsService.getHost).mockImplementation(() => {
      throw new NotFoundError("Host not found: 999");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/999");
    const res = await hostsIdLoader({ request: req, params: { id: "999" } });
    expect(res.status).toBe(404);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("not_found_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 422 HostValidationError — body carries the nginx stderr message
// ═══════════════════════════════════════════════════════════════════════════
describe("422 HostValidationError on publish", () => {
  it("publishHost throws HostValidationError → 422 with nginx message in error field", async () => {
    const nginxStderr = "nginx: [emerg] invalid value in /etc/nginx/conf.d/1.conf:12";
    vi.mocked(hostsService.publishHost).mockRejectedValue(
      new HostValidationError(nginxStderr, "nginx")
    );
    const req = makeRequest("POST", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(422);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("host_validation_error");
    expect(body.error).toBe(nginxStderr);
  });

  it("publishHost throws HostValidationError (input) → 422 JSON", async () => {
    vi.mocked(hostsService.publishHost).mockRejectedValue(
      new HostValidationError("domains is required", "input")
    );
    const req = makeRequest("POST", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(422);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("host_validation_error");
    expect(body.error).toContain("domains");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Happy paths
// ═══════════════════════════════════════════════════════════════════════════
describe("GET /api/v1/hosts — list", () => {
  it("returns host list", async () => {
    const hosts = [{ id: 1, domains: ["example.com"] }, { id: 2, domains: ["test.com"] }];
    vi.mocked(hostsService.listHosts).mockReturnValue(hosts as any);
    const req = makeRequest("GET", "http://localhost/api/v1/hosts");
    const res = await hostsLoader({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toEqual(hosts);
    expect(hostsService.listHosts).toHaveBeenCalledOnce();
  });
});

describe("POST /api/v1/hosts — create draft", () => {
  it("creates host draft and returns row", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/hosts", {
      domains: ["new.example.com"],
    });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(201);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(hostsService.createHost).toHaveBeenCalledOnce();
  });

  it("POST with malformed JSON → 400 JSON", async () => {
    const req = new Request("http://localhost/api/v1/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "not json {{{",
    });
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
  });
});

describe("GET /api/v1/hosts/:id — get single", () => {
  it("returns host row", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/1");
    const res = await hostsIdLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(hostsService.getHost).toHaveBeenCalledWith(expect.anything(), 1);
  });
});

describe("PATCH /api/v1/hosts/:id — draft update (draft-only, no live fields)", () => {
  it("calls updateHost with exact (auth, id, patch) args — draft fields only", async () => {
    const patch = { domains: ["updated.example.com"] };
    const req = makeRequest("PATCH", "http://localhost/api/v1/hosts/5", patch);
    const res = await hostsIdAction({ request: req, params: { id: "5" } });
    expect(res.status).toBe(200);
    assertJson(res);
    // Verify service was called with the right id (5) and exact patch body
    expect(hostsService.updateHost).toHaveBeenCalledOnce();
    const [_auth, id, calledPatch] = vi.mocked(hostsService.updateHost).mock.calls[0];
    expect(id).toBe(5);
    expect(calledPatch).toEqual(patch);
  });

  it("PATCH with malformed JSON → 400", async () => {
    const req = new Request("http://localhost/api/v1/hosts/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "not json",
    });
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(400);
    assertJson(res);
  });
});

describe("DELETE /api/v1/hosts/:id — live delete", () => {
  it("deletes live host and returns {deleted: true}", async () => {
    const req = makeRequest("DELETE", "http://localhost/api/v1/hosts/3");
    const res = await hostsIdAction({ request: req, params: { id: "3" } });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(hostsService.deleteHost).toHaveBeenCalledWith(expect.anything(), 3);
  });
});

describe("DELETE /api/v1/hosts/:id/draft — discard draft", () => {
  it("discards draft and returns updated row", async () => {
    const req = makeRequest("DELETE", "http://localhost/api/v1/hosts/1/draft");
    const res = await hostsDraftAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(hostsService.discardHostDraft).toHaveBeenCalledWith(expect.anything(), 1);
  });
});

describe("POST /api/v1/hosts/:id/publish", () => {
  it("publishes and returns the updated row", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(hostsService.publishHost).toHaveBeenCalledWith(expect.anything(), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 405 wrong method per route
// ═══════════════════════════════════════════════════════════════════════════
describe("405 wrong method per route", () => {
  it("PUT /api/v1/hosts → 405 JSON (loader handles GET only)", async () => {
    const req = makeRequest("PUT", "http://localhost/api/v1/hosts");
    const res = await hostsAction({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });

  it("GET /api/v1/hosts/:id/draft → 405 JSON", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/1/draft");
    const res = await hostsDraftLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(405);
    assertJson(res);
  });

  it("GET /api/v1/hosts/:id/publish → 405 JSON", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(405);
    assertJson(res);
  });

  it("PATCH /api/v1/hosts/:id/publish → 405 JSON", async () => {
    const req = makeRequest("PATCH", "http://localhost/api/v1/hosts/1/publish");
    const res = await hostsPublishAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(405);
    assertJson(res);
  });

  it("PUT /api/v1/hosts/:id → 405 JSON", async () => {
    const req = makeRequest("PUT", "http://localhost/api/v1/hosts/1");
    const res = await hostsIdAction({ request: req, params: { id: "1" } });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Never-HTML: all error responses must be JSON
// ═══════════════════════════════════════════════════════════════════════════
describe("never-HTML assertion", () => {
  it("unknown error on listHosts → 500 JSON (not HTML)", async () => {
    vi.mocked(hostsService.listHosts).mockImplementation(() => {
      throw new Error("unexpected crash");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/hosts");
    const res = await hostsLoader({ request: req, params: {} });
    expect(res.status).toBe(500);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("internal_error");
  });

  it("unknown error on getHost → 500 JSON (not HTML)", async () => {
    vi.mocked(hostsService.getHost).mockImplementation(() => {
      throw new Error("secret internal path");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/hosts/1");
    const res = await hostsIdLoader({ request: req, params: { id: "1" } });
    expect(res.status).toBe(500);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("secret");
  });

  it("bad id → 400 JSON (not HTML), never renders framework error page", async () => {
    const req = makeRequest("DELETE", "http://localhost/api/v1/hosts/abc/draft");
    const res = await hostsDraftAction({ request: req, params: { id: "abc" } });
    expect(res.status).toBe(400);
    assertJson(res);
  });

  it("every 405 response is JSON — all route handlers", async () => {
    const cases: Array<Promise<Response> | Response> = [
      hostsAction({ request: makeRequest("PUT", "http://localhost/api/v1/hosts"), params: {} }),
      hostsDraftLoader({ request: makeRequest("GET", "http://localhost/api/v1/hosts/1/draft"), params: { id: "1" } }),
      hostsPublishLoader({ request: makeRequest("GET", "http://localhost/api/v1/hosts/1/publish"), params: { id: "1" } }),
      hostsPublishAction({ request: makeRequest("PATCH", "http://localhost/api/v1/hosts/1/publish"), params: { id: "1" } }),
    ];
    const responses = await Promise.all(cases);
    for (const res of responses) {
      expect(res.status).toBe(405);
      assertJson(res);
    }
  });
});
