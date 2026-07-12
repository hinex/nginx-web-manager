import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where"]) chain[m] = vi.fn(() => chain);
  chain.get = vi.fn(() => undefined);
  return { db: chain };
});
vi.mock("~/lib/db/schema", () => ({ settings: { key: "key", value: "value" } }));
vi.mock("~/lib/auth/authenticate", () => ({ authenticate: vi.fn() }));
vi.mock("~/lib/mcp/server", () => ({
  toolsForScopes: vi.fn(() => [{ name: "list_configs" }]),
  resourcesForScopes: vi.fn(() => []),
  handleToolCall: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  handleResourceRead: vi.fn(async () => ({ content: [{ type: "text", text: "data" }] })),
  resources: [],
}));

import { db } from "~/lib/db/connection";
import { authenticate } from "~/lib/auth/authenticate";
import { toolsForScopes } from "~/lib/mcp/server";
import { action } from "./mcp";

const mockDb = db as any;

const AUTH = {
  userId: 1,
  role: "editor" as const,
  via: "token" as const,
  tokenId: 2,
  scopes: ["configs:read" as const],
};

function rpc(method: string, params: Record<string, unknown> = {}, secret?: string) {
  return action({
    request: new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    params: { secret },
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.get.mockReturnValue(undefined); // no mcp_path_secret configured
  vi.mocked(authenticate).mockResolvedValue(AUTH);
});

describe("mcp path secret", () => {
  it("404 when secret configured but not provided", async () => {
    mockDb.get.mockReturnValue({ key: "mcp_path_secret", value: "s3cret" });
    await expect(rpc("tools/list")).rejects.toSatisfy(
      (r: Response) => r instanceof Response && r.status === 404
    );
  });

  it("404 when wrong secret provided", async () => {
    mockDb.get.mockReturnValue({ key: "mcp_path_secret", value: "s3cret" });
    await expect(rpc("tools/list", {}, "wrong")).rejects.toSatisfy(
      (r: Response) => r instanceof Response && r.status === 404
    );
  });

  it("404 when no secret configured but a path segment is given", async () => {
    await expect(rpc("tools/list", {}, "anything")).rejects.toSatisfy(
      (r: Response) => r instanceof Response && r.status === 404
    );
  });

  it("passes with the correct secret", async () => {
    mockDb.get.mockReturnValue({ key: "mcp_path_secret", value: "s3cret" });
    const res = await rpc("tools/list", {}, "s3cret");
    expect(res.status).toBe(200);
  });
});

describe("mcp body parsing", () => {
  it("returns JSON-RPC -32700 on malformed JSON", async () => {
    const res = await action({
      request: new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
      params: {},
    } as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("returns -32602 when tools/call has no name", async () => {
    const res = await rpc("tools/call", { arguments: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });

  it("returns -32602 when resources/read has no uri", async () => {
    const res = await rpc("resources/read", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });
});

describe("mcp auth", () => {
  it("maps auth failure to JSON-RPC error with original status", async () => {
    vi.mocked(authenticate).mockRejectedValue(
      Response.json({ error: "nope" }, { status: 401 })
    );
    const res = await rpc("tools/list");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it("tools/list returns scope-filtered tools", async () => {
    const res = await rpc("tools/list");
    const body = await res.json();
    expect(body.result.tools).toEqual([{ name: "list_configs" }]);
    expect(toolsForScopes).toHaveBeenCalledWith(AUTH.scopes);
  });
});
