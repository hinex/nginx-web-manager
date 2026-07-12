import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import { ForbiddenError, InvalidPathError, NotFoundError } from "~/lib/services/errors";
import * as configsService from "~/lib/services/configs";
import * as nginxService from "~/lib/services/nginx";
import * as statsService from "~/lib/services/stats";
import * as hostsService from "~/lib/services/hosts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  requiredScope: Scope;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  requiredScope: Scope;
}

const NO_ARGS = { type: "object", properties: {}, required: [] };

export const tools: McpTool[] = [
  {
    name: "list_configs",
    requiredScope: "configs:read",
    description: "List nginx configuration files and pending drafts",
    inputSchema: NO_ARGS,
  },
  {
    name: "read_config",
    requiredScope: "configs:read",
    description:
      "Read a config file (or its .draft) inside the nginx directory. Path may be relative to the nginx dir or absolute within it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Config file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_config",
    requiredScope: "configs:write",
    description:
      "Write config content as a DRAFT (<path>.draft) and run nginx -t against it. Never touches the live config; to go live use publish_config or the web UI.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target .conf path" },
        content: { type: "string", description: "Full config file content" },
        message: { type: "string", description: "Optional change message for version history" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "publish_config",
    requiredScope: "configs:publish",
    description:
      "Publish a previously written draft to the live config: snapshot the old version, validate with nginx -t, reload nginx. Rolls back automatically if validation fails.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Target .conf path (draft must exist)" } },
      required: ["path"],
    },
  },
  {
    name: "delete_config",
    requiredScope: "configs:publish",
    description: "Delete a config file. A version snapshot is saved first so it can be restored.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Config file path" } },
      required: ["path"],
    },
  },
  {
    name: "validate_config",
    requiredScope: "nginx:validate",
    description: "Validate the current nginx configuration (runs nginx -t)",
    inputSchema: NO_ARGS,
  },
  {
    name: "reload_nginx",
    requiredScope: "nginx:reload",
    description: "Reload nginx configuration",
    inputSchema: NO_ARGS,
  },
  {
    name: "get_stats",
    requiredScope: "stats:read",
    description: "Get system and nginx statistics",
    inputSchema: NO_ARGS,
  },
  {
    name: "list_hosts",
    requiredScope: "hosts:read",
    description: "List all managed proxy hosts",
    inputSchema: NO_ARGS,
  },
];

export function toolsForScopes(scopes: Scope[]) {
  return tools
    .filter((t) => scopes.includes(t.requiredScope))
    .map(({ requiredScope: _scope, ...pub }) => pub);
}

export const resources: McpResource[] = [
  {
    uri: "nginx://status",
    name: "Nginx Status",
    description: "Current nginx and system status information",
    mimeType: "application/json",
    requiredScope: "stats:read",
  },
  {
    uri: "nginx://config/{path}",
    name: "Nginx Config File",
    description: "Content of a specific nginx configuration file",
    mimeType: "text/plain",
    requiredScope: "configs:read",
  },
];

export function resourcesForScopes(scopes: Scope[]) {
  return resources
    .filter((r) => scopes.includes(r.requiredScope))
    .map(({ requiredScope: _scope, ...pub }) => pub);
}

function textResult(data: unknown): McpToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handleToolCall(
  auth: AuthContext,
  name: string,
  args: Record<string, any>
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "list_configs":
        return textResult(configsService.listConfigs(auth));
      case "read_config":
        return textResult(configsService.readConfig(auth, args.path));
      case "write_config": {
        const r = configsService.writeConfigDraft(auth, args.path, args.content, args.message);
        return textResult(
          [
            `Draft saved: ${r.draftPath}`,
            r.valid ? "nginx -t: OK" : `nginx -t: FAILED — ${r.error}`,
            "Live config untouched. To apply: publish_config (requires configs:publish) or publish from the web UI.",
          ].join("\n")
        );
      }
      case "publish_config": {
        const r = configsService.publishConfig(auth, args.path);
        return textResult(
          r.published
            ? `Config published and nginx reloaded: ${args.path}`
            : `Publish aborted, live config rolled back. nginx -t: ${r.error}. Draft kept.`
        );
      }
      case "delete_config": {
        configsService.deleteConfig(auth, args.path);
        return textResult(`Deleted ${args.path} (version snapshot saved)`);
      }
      case "validate_config":
        return textResult(nginxService.validate(auth));
      case "reload_nginx": {
        const r = nginxService.reload(auth);
        return textResult(r.reloaded ? "Nginx reloaded successfully" : "Failed to reload nginx");
      }
      case "get_stats":
        return textResult(statsService.getStats(auth));
      case "list_hosts":
        return textResult(hostsService.listHosts(auth));
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ForbiddenError) return errorResult(err.message);
    if (err instanceof InvalidPathError) return errorResult(err.message);
    if (err instanceof NotFoundError) return errorResult(err.message);
    return errorResult(`Error: ${(err as Error).message}`);
  }
}

export async function handleResourceRead(
  auth: AuthContext,
  uri: string
): Promise<McpToolResult> {
  try {
    if (uri === "nginx://status") {
      return textResult(statsService.getStats(auth));
    }
    const configMatch = uri.match(/^nginx:\/\/config\/(.+)$/);
    if (configMatch) {
      return textResult(configsService.readConfig(auth, configMatch[1]));
    }
    return errorResult(`Unknown resource URI: ${uri}`);
  } catch (err) {
    if (err instanceof ForbiddenError) return errorResult(err.message);
    if (err instanceof InvalidPathError) return errorResult(err.message);
    if (err instanceof NotFoundError) return errorResult(err.message);
    return errorResult(`Error: ${(err as Error).message}`);
  }
}
