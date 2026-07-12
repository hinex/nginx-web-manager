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
vi.mock("~/lib/services/hosts", () => ({ listHosts: vi.fn(() => []) }));

import * as configsService from "~/lib/services/configs";
import { ForbiddenError } from "~/lib/services/errors";
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
});

describe("tool definitions", () => {
  it("defines 9 tools, all with a requiredScope", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_config",
      "get_stats",
      "list_configs",
      "list_hosts",
      "publish_config",
      "read_config",
      "reload_nginx",
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

  it("delegates publish_config", async () => {
    const r = await handleToolCall(ctx(["configs:publish"]), "publish_config", { path: "a.conf" });
    expect(configsService.publishConfig).toHaveBeenCalled();
    expect(r.content[0].text).toContain("published");
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
