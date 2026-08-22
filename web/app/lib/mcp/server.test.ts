import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("~/lib/services/stats", () => ({ getStats: vi.fn(() => ({ cpu: 1 })) }));
vi.mock("~/lib/services/hosts", () => ({
  listHosts: vi.fn(() => []),
  getHost: vi.fn(() => ({ id: 1, domains: ["example.com"] })),
  createHost: vi.fn(async () => ({ id: 2, domains: ["new.example.com"], draft: { domains: ["new.example.com"] } })),
  updateHost: vi.fn(async () => ({ id: 1, domains: ["example.com"], draft: { domains: ["updated.example.com"] } })),
  discardHostDraft: vi.fn(() => ({ id: 1, domains: ["example.com"], draft: null })),
  publishHost: vi.fn(async () => ({ id: 1, domains: ["example.com"], draft: null })),
  deleteHost: vi.fn(async () => ({ deleted: true })),
}));

import * as configsService from "~/lib/services/configs";
import * as hostsService from "~/lib/services/hosts";
import {
  ForbiddenError,
  HostValidationError,
  ConfigClassificationError,
} from "~/lib/services/errors";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import {
  tools,
  toolsForScopes,
  resourcesForScopes,
  handleToolCall,
  handleResourceRead,
} from "./server";

const ctx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "editor",
  via: "token",
  tokenId: 7,
  scopes,
});

beforeEach(() => {
  vi.resetAllMocks();
  // Re-establish default return values after reset (vi.resetAllMocks clears implementations)
  vi.mocked(configsService.listConfigs).mockReturnValue({ files: ["/data/nginx/a.conf"], drafts: [] });
  vi.mocked(configsService.readConfig).mockReturnValue("server {}");
  vi.mocked(configsService.writeConfigDraft).mockReturnValue({ draftPath: "/data/nginx/a.conf.draft", valid: true });
  vi.mocked(configsService.publishConfig).mockReturnValue({ published: true, valid: true });
  vi.mocked(configsService.deleteConfig).mockReturnValue({ deleted: true });
  vi.mocked(hostsService.getHost).mockReturnValue({ id: 1, domains: ["example.com"] } as any);
  vi.mocked(hostsService.createHost).mockResolvedValue({ id: 2, domains: ["new.example.com"], draft: { domains: ["new.example.com"] } } as any);
  vi.mocked(hostsService.updateHost).mockResolvedValue({ id: 1, domains: ["example.com"], draft: { domains: ["updated.example.com"] } } as any);
  vi.mocked(hostsService.discardHostDraft).mockReturnValue({ id: 1, domains: ["example.com"], draft: null } as any);
  vi.mocked(hostsService.publishHost).mockResolvedValue({ id: 1, domains: ["example.com"], draft: null } as any);
  vi.mocked(hostsService.deleteHost).mockResolvedValue({ deleted: true } as any);
});

describe("tool definitions", () => {
  it("defines 15 tools, all with a requiredScope", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_host",
      "delete_config",
      "delete_host",
      "discard_host_draft",
      "get_host",
      "get_stats",
      "list_configs",
      "list_hosts",
      "publish_config",
      "publish_host",
      "read_config",
      "reload_nginx",
      "update_host",
      "validate_config",
      "write_config",
    ]);
    for (const t of tools) expect(t.requiredScope).toBeTruthy();
  });
});

describe("toolsForScopes", () => {
  it("filters by scope and strips requiredScope", () => {
    const visible = toolsForScopes(["configs:read"]);
    expect(visible.map((t) => t.name).sort()).toEqual(["list_configs", "read_config"]);
    expect(Object.keys(visible[0])).not.toContain("requiredScope");
  });

  it("publish_config and delete_config require configs:publish", () => {
    const names = toolsForScopes(["configs:publish"]).map((t) => t.name).sort();
    expect(names).toEqual(["delete_config", "publish_config"]);
  });

  it("hosts:write exposes create_host, update_host, discard_host_draft", () => {
    const names = toolsForScopes(["hosts:write"]).map((t) => t.name).sort();
    expect(names).toEqual(["create_host", "discard_host_draft", "update_host"]);
  });

  it("hosts:publish exposes publish_host and delete_host", () => {
    const names = toolsForScopes(["hosts:publish"]).map((t) => t.name).sort();
    expect(names).toEqual(["delete_host", "publish_host"]);
  });
});

describe("handleToolCall", () => {
  it("returns isError for unknown tool", async () => {
    const r = await handleToolCall(ctx([]), "rm_rf", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Unknown tool");
  });

  it("maps ForbiddenError to isError result with scope message", async () => {
    vi.mocked(configsService.readConfig).mockImplementation(() => {
      throw new ForbiddenError("configs:read");
    });
    const r = await handleToolCall(ctx([]), "read_config", { path: "a.conf" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("token lacks scope configs:read");
  });

  it("write_config reports draft path, validation, and publish hint", async () => {
    const r = await handleToolCall(ctx(["configs:write"]), "write_config", {
      path: "a.conf",
      content: "server {}",
    });
    expect(configsService.writeConfigDraft).toHaveBeenCalledWith(
      expect.anything(),
      "a.conf",
      "server {}",
      undefined
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Draft saved");
    expect(r.content[0].text).toContain("publish_config");
  });

  it("renders classification refusals as one line each, not an opaque error", async () => {
    vi.mocked(configsService.writeConfigDraft).mockImplementation(() => {
      throw new ConfigClassificationError([
        { line: 12, directive: "resolver", reason: "resolver and set $backend_* come from global settings, not from this host" },
        { line: 30, directive: "gzip_vary", reason: "Deleting this line cannot be mapped back to a host field" },
      ]);
    });
    const r = await handleToolCall(ctx(["configs:write"]), "write_config", {
      path: "a.conf",
      content: "...",
    });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain("Nothing was written");
    expect(text).toContain("line 12: resolver and set $backend_* come from global settings");
    expect(text).toContain("line 30: Deleting this line cannot be mapped back to a host field");
  });

  it("delegates publish_config", async () => {
    const r = await handleToolCall(ctx(["configs:publish"]), "publish_config", { path: "a.conf" });
    expect(configsService.publishConfig).toHaveBeenCalled();
    expect(r.content[0].text).toContain("published");
  });

  it("get_host delegates to service and returns host JSON", async () => {
    const r = await handleToolCall(ctx(["hosts:read"]), "get_host", { id: 1 });
    expect(hostsService.getHost).toHaveBeenCalledWith(expect.anything(), 1);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("example.com");
  });

  it("create_host delegates to service with host object", async () => {
    const host = { domains: ["new.example.com"] };
    const r = await handleToolCall(ctx(["hosts:write"]), "create_host", { host });
    expect(hostsService.createHost).toHaveBeenCalledWith(expect.anything(), host);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("new.example.com");
  });

  it("update_host delegates to service with id and patch", async () => {
    const patch = { domains: ["updated.example.com"] };
    const r = await handleToolCall(ctx(["hosts:write"]), "update_host", { id: 1, patch });
    expect(hostsService.updateHost).toHaveBeenCalledWith(expect.anything(), 1, patch);
    expect(r.isError).toBeUndefined();
  });

  it("discard_host_draft delegates to service", async () => {
    const r = await handleToolCall(ctx(["hosts:write"]), "discard_host_draft", { id: 1 });
    expect(hostsService.discardHostDraft).toHaveBeenCalledWith(expect.anything(), 1);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("discarded");
  });

  it("publish_host delegates to service and reports nginx reload", async () => {
    const r = await handleToolCall(ctx(["hosts:publish"]), "publish_host", { id: 1 });
    expect(hostsService.publishHost).toHaveBeenCalledWith(expect.anything(), 1);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("nginx reloaded");
  });

  it("delete_host delegates to service", async () => {
    const r = await handleToolCall(ctx(["hosts:publish"]), "delete_host", { id: 1 });
    expect(hostsService.deleteHost).toHaveBeenCalledWith(expect.anything(), 1);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("deleted");
  });

  it("maps HostValidationError (nginx kind) to isError result with stderr and rollback note", async () => {
    vi.mocked(hostsService.publishHost).mockRejectedValue(
      new HostValidationError("upstream not found", "nginx")
    );
    const r = await handleToolCall(ctx(["hosts:publish"]), "publish_host", { id: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("upstream not found");
    expect(r.content[0].text).toContain("rolled back");
  });

  it("maps HostValidationError (input kind) to isError result with message", async () => {
    vi.mocked(hostsService.createHost).mockRejectedValue(
      new HostValidationError("domains is required", "input")
    );
    const r = await handleToolCall(ctx(["hosts:write"]), "create_host", { host: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("domains is required");
  });
});

describe("resources", () => {
  it("filters resources by scope", () => {
    expect(resourcesForScopes(["stats:read"]).map((r) => r.uri)).toEqual(["nginx://status"]);
    expect(resourcesForScopes(["configs:read"]).map((r) => r.uri)).toEqual([
      "nginx://config/{path}",
    ]);
  });

  it("routes config resource reads through the service", async () => {
    const r = await handleResourceRead(ctx(["configs:read"]), "nginx://config/conf.d/a.conf");
    expect(configsService.readConfig).toHaveBeenCalledWith(expect.anything(), "conf.d/a.conf");
    expect(r.content[0].text).toBe("server {}");
  });
});
