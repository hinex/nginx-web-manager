/**
 * Route-level tests for /api/v1 endpoints.
 * Services are mocked; toResponse is real (imported from shared.ts).
 * Every response must carry Content-Type: application/json.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── service mocks ──────────────────────────────────────────────────────────
vi.mock("~/lib/services/configs", () => ({
  listConfigs: vi.fn(() => ({ files: ["/data/nginx/a.conf"], drafts: [] })),
  readConfig: vi.fn(() => "server {}"),
  writeConfigDraft: vi.fn(() => ({ draftPath: "/data/nginx/a.conf.draft", valid: true })),
  publishConfig: vi.fn(() => ({ published: true, valid: true })),
  deleteConfig: vi.fn(() => ({ deleted: true })),
}));
vi.mock("~/lib/services/nginx", () => ({
  validate: vi.fn(() => ({ valid: true })),
  reload: vi.fn(() => ({ reloaded: true })),
}));
vi.mock("~/lib/services/stats", () => ({
  getStats: vi.fn(() => ({ cpu: 0.1, mem: { used: 100, total: 1000 } })),
}));

// ── auth mock ──────────────────────────────────────────────────────────────
vi.mock("~/lib/auth/authenticate", () => ({
  authenticate: vi.fn(),
}));

// ── DB / session mocks so authenticate import doesn't blow up ─────────────
vi.mock("~/lib/db/connection", () => ({ db: {} }));
vi.mock("~/lib/db/schema", () => ({ users: {}, settings: {} }));
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
import * as configsService from "~/lib/services/configs";
import * as nginxService from "~/lib/services/nginx";
import * as statsService from "~/lib/services/stats";
import {
  ForbiddenError,
  NotFoundError,
  InvalidPathError,
  HostValidationError,
  ConfigClassificationError,
} from "~/lib/services/errors";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";

// ── route handlers under test ──────────────────────────────────────────────
import { loader as configsLoader, action as configsAction } from "./configs";
import { loader as configFileLoader, action as configFileAction } from "./configs.file";
import { loader as configsPublishLoader, action as configsPublishAction } from "./configs.publish";
import { loader as nginxValidateLoader, action as nginxValidateAction } from "./nginx.validate";
import { loader as nginxReloadLoader, action as nginxReloadAction } from "./nginx.reload";
import { loader as statsLoader, action as statsAction } from "./stats";

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
    authedCtx([
      "configs:read",
      "configs:write",
      "configs:publish",
      "nginx:validate",
      "nginx:reload",
      "stats:read",
    ])
  );
  vi.mocked(configsService.listConfigs).mockReturnValue({ files: ["/data/nginx/a.conf"], drafts: [] });
  vi.mocked(configsService.readConfig).mockReturnValue("server {}");
  vi.mocked(configsService.writeConfigDraft).mockReturnValue({ draftPath: "/data/nginx/a.conf.draft", valid: true });
  vi.mocked(configsService.publishConfig).mockReturnValue({ published: true, valid: true });
  vi.mocked(configsService.deleteConfig).mockReturnValue({ deleted: true });
  vi.mocked(nginxService.validate).mockReturnValue({ valid: true });
  vi.mocked(nginxService.reload).mockReturnValue({ reloaded: true });
  vi.mocked(statsService.getStats).mockReturnValue({ cpu: 0.1, mem: { used: 100, total: 1000 } } as any);
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared: 401 without Bearer token
// ═══════════════════════════════════════════════════════════════════════════
describe("401 without Bearer", () => {
  it("GET /api/v1/configs → 401 JSON when not authenticated", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      Response.json({ error: "Authentication required" }, { status: 401 })
    );
    const req = new Request("http://localhost/api/v1/configs", { method: "GET" });
    const res = await configsLoader({ request: req, params: {} });
    expect(res.status).toBe(401);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("code");
  });

  it("GET /api/v1/stats → 401 JSON when not authenticated", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      Response.json({ error: "Authentication required" }, { status: 401 })
    );
    const req = new Request("http://localhost/api/v1/stats", { method: "GET" });
    const res = await statsLoader({ request: req, params: {} });
    expect(res.status).toBe(401);
    assertJson(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared: 403 scope missing → ForbiddenError mapped by toResponse
// ═══════════════════════════════════════════════════════════════════════════
describe("403 ForbiddenError mapped", () => {
  it("GET /api/v1/configs throws ForbiddenError → 403 JSON with code", async () => {
    vi.mocked(configsService.listConfigs).mockImplementation(() => {
      throw new ForbiddenError("configs:read");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/configs");
    const res = await configsLoader({ request: req, params: {} });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
    expect(body.error).toContain("configs:read");
  });

  it("GET /api/v1/stats throws ForbiddenError → 403 JSON", async () => {
    vi.mocked(statsService.getStats).mockImplementation(() => {
      throw new ForbiddenError("stats:read");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/stats");
    const res = await statsLoader({ request: req, params: {} });
    expect(res.status).toBe(403);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("forbidden_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared: malformed JSON → 400 with {error, code}
// ═══════════════════════════════════════════════════════════════════════════
describe("malformed JSON → 400", () => {
  it("PUT /api/v1/configs/file with bad JSON body → 400 JSON", async () => {
    const req = new Request("http://localhost/api/v1/configs/file?path=conf.d/a.conf", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "not json {{{",
    });
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Happy paths per endpoint
// ═══════════════════════════════════════════════════════════════════════════
describe("GET /api/v1/configs", () => {
  it("returns file list", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/configs");
    const res = await configsLoader({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("files");
    expect(body).toHaveProperty("drafts");
    expect(configsService.listConfigs).toHaveBeenCalledOnce();
  });

  it("action returns 405", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/configs");
    const res = await configsAction({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

describe("GET /api/v1/configs/file", () => {
  it("returns file content", async () => {
    const req = makeRequest(
      "GET",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf"
    );
    const res = await configFileLoader({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("content");
    expect(configsService.readConfig).toHaveBeenCalledOnce();
  });

  it("GET without ?path → 400", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/configs/file");
    const res = await configFileLoader({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
  });
});

describe("PUT /api/v1/configs/file", () => {
  it("writes draft and returns result", async () => {
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf",
      { content: "server {}" }
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("draftPath");
    expect(configsService.writeConfigDraft).toHaveBeenCalledOnce();
  });

  it("PUT without ?path → 400", async () => {
    const req = makeRequest("PUT", "http://localhost/api/v1/configs/file", {
      content: "x",
    });
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
  });

  it("PUT with missing content in body → 400", async () => {
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf",
      { message: "no content field" }
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
  });

  it("passes the classified edits through to the response body", async () => {
    vi.mocked(configsService.writeConfigDraft).mockReturnValue({
      draftPath: "/data/nginx/conf.d/host-1.conf.draft",
      valid: true,
      hostId: 1,
      edits: [
        { kind: "field", field: "clientMaxBodySize", from: "5m", to: "50m", label: "client_max_body_size 5m → 50m" },
      ],
    });
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/conf.d/host-1.conf",
      { content: "..." }
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostId).toBe(1);
    expect(body.edits).toEqual([
      expect.objectContaining({ field: "clientMaxBodySize", to: "50m" }),
    ]);
  });

  it("maps a classification refusal to 409 with line-numbered refusals", async () => {
    vi.mocked(configsService.writeConfigDraft).mockImplementation(() => {
      throw new ConfigClassificationError([
        { line: 12, directive: "resolver", reason: "resolver and set $backend_* come from global settings, not from this host" },
      ]);
    });
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf",
      { content: "..." }
    );
    const res = await configFileAction({ request: req, params: {} });
    // 409, not 400: the submitted text conflicts with the host model. It is
    // not malformed, and clients need to tell the two apart.
    expect(res.status).toBe(409);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("config_classification_error");
    expect(body.refusals).toEqual([
      expect.objectContaining({ line: 12, reason: expect.stringContaining("global settings") }),
    ]);
  });

  it("InvalidPathError → 400", async () => {
    vi.mocked(configsService.writeConfigDraft).mockImplementation(() => {
      throw new InvalidPathError("/data/nginx/bad");
    });
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/bad",
      { content: "x" }
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("invalid_path_error");
  });
});

describe("DELETE /api/v1/configs/file", () => {
  it("deletes config and returns {deleted: true}", async () => {
    const req = makeRequest(
      "DELETE",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf"
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(configsService.deleteConfig).toHaveBeenCalledOnce();
  });

  it("NotFoundError → 404 JSON", async () => {
    vi.mocked(configsService.deleteConfig).mockImplementation(() => {
      throw new NotFoundError("File not found: x.conf");
    });
    const req = makeRequest(
      "DELETE",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf"
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(404);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("not_found_error");
  });
});

describe("POST /api/v1/configs/publish", () => {
  it("publishes config", async () => {
    const req = makeRequest(
      "POST",
      "http://localhost/api/v1/configs/publish?path=/data/nginx/a.conf"
    );
    const res = await configsPublishAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body.published).toBe(true);
    expect(configsService.publishConfig).toHaveBeenCalledOnce();
  });

  it("POST without ?path → 400", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/configs/publish");
    const res = await configsPublishAction({ request: req, params: {} });
    expect(res.status).toBe(400);
    assertJson(res);
  });

  it("loader returns 405", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/configs/publish");
    const res = await configsPublishLoader({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

describe("POST /api/v1/nginx/validate", () => {
  it("returns validation result", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/nginx/validate");
    const res = await nginxValidateAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("valid");
    expect(nginxService.validate).toHaveBeenCalledOnce();
  });

  it("loader returns 405", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/nginx/validate");
    const res = await nginxValidateLoader({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

describe("POST /api/v1/nginx/reload", () => {
  it("returns reload result", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/nginx/reload");
    const res = await nginxReloadAction({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body.reloaded).toBe(true);
    expect(nginxService.reload).toHaveBeenCalledOnce();
  });

  it("loader returns 405", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/nginx/reload");
    const res = await nginxReloadLoader({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

describe("GET /api/v1/stats", () => {
  it("returns system stats", async () => {
    const req = makeRequest("GET", "http://localhost/api/v1/stats");
    const res = await statsLoader({ request: req, params: {} });
    expect(res.status).toBe(200);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("cpu");
    expect(statsService.getStats).toHaveBeenCalledOnce();
  });

  it("action returns 405", async () => {
    const req = makeRequest("POST", "http://localhost/api/v1/stats");
    const res = await statsAction({ request: req, params: {} });
    expect(res.status).toBe(405);
    assertJson(res);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Never-HTML: all errors must be JSON
// ═══════════════════════════════════════════════════════════════════════════
describe("never-HTML assertion", () => {
  it("HostValidationError → 422 JSON (not HTML)", async () => {
    vi.mocked(configsService.writeConfigDraft).mockImplementation(() => {
      throw new HostValidationError("domain must be a valid FQDN");
    });
    const req = makeRequest(
      "PUT",
      "http://localhost/api/v1/configs/file?path=/data/nginx/a.conf",
      { content: "bad" }
    );
    const res = await configFileAction({ request: req, params: {} });
    expect(res.status).toBe(422);
    assertJson(res);
    const body = await res.json();
    expect(body.code).toBe("host_validation_error");
  });

  it("unknown error → 500 JSON (not HTML)", async () => {
    vi.mocked(configsService.listConfigs).mockImplementation(() => {
      throw new Error("unexpected crash");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/configs");
    const res = await configsLoader({ request: req, params: {} });
    expect(res.status).toBe(500);
    assertJson(res);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
    expect(body.code).toBe("internal_error");
  });

  it("unknown error body is generic — no internal detail leaked", async () => {
    vi.mocked(configsService.listConfigs).mockImplementation(() => {
      throw new Error("secret /etc/path detail");
    });
    const req = makeRequest("GET", "http://localhost/api/v1/configs");
    const res = await configsLoader({ request: req, params: {} });
    expect(res.status).toBe(500);
    assertJson(res);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("internal_error");
    expect(body.error).not.toContain("secret");
  });

  it("every 405 response is JSON", async () => {
    const cases: Array<Promise<Response>> = [
      configsAction({ request: makeRequest("POST", "http://localhost/api/v1/configs"), params: {} }),
      configsPublishLoader({ request: makeRequest("GET", "http://localhost/api/v1/configs/publish"), params: {} }),
      nginxValidateLoader({ request: makeRequest("GET", "http://localhost/api/v1/nginx/validate"), params: {} }),
      nginxReloadLoader({ request: makeRequest("GET", "http://localhost/api/v1/nginx/reload"), params: {} }),
      statsAction({ request: makeRequest("POST", "http://localhost/api/v1/stats"), params: {} }),
    ];
    const responses = await Promise.all(cases);
    for (const res of responses) {
      expect(res.status).toBe(405);
      assertJson(res);
    }
  });
});
