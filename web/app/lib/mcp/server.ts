export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
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
}

// Define available tools
export const tools: McpTool[] = [
  {
    name: "list_configs",
    description: "List all nginx configuration files",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_config",
    description: "Read the content of an nginx configuration file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the config file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_config",
    description: "Write content to an nginx configuration file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the config file" },
        content: { type: "string", description: "Config file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_config",
    description: "Delete an nginx configuration file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the config file" },
      },
      required: ["path"],
    },
  },
  {
    name: "validate_config",
    description: "Validate nginx configuration (runs nginx -t)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "reload_nginx",
    description: "Reload nginx configuration",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_stats",
    description: "Get system and nginx statistics",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_hosts",
    description: "List all managed proxy hosts",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// Define available resources
export const resources: McpResource[] = [
  {
    uri: "nginx://status",
    name: "Nginx Status",
    description: "Current nginx and system status information",
    mimeType: "application/json",
  },
  {
    uri: "nginx://config/{path}",
    name: "Nginx Config File",
    description: "Content of a specific nginx configuration file",
    mimeType: "text/plain",
  },
];

// Handle resource reads
export async function handleResourceRead(uri: string): Promise<McpToolResult> {
  try {
    if (uri === "nginx://status") {
      const { getSystemStats } = await import("~/lib/system/stats");
      const stats = getSystemStats();
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
      };
    }

    const configMatch = uri.match(/^nginx:\/\/config\/(.+)$/);
    if (configMatch) {
      const filePath = configMatch[1];
      // Ensure the path is within the nginx directory for security
      const { resolve, normalize } = await import("path");
      const NGINX_DIR = process.env.NGINX_DIR || "/etc/nginx";
      const resolvedPath = resolve(NGINX_DIR, filePath);
      const normalizedNginxDir = normalize(NGINX_DIR);

      if (!resolvedPath.startsWith(normalizedNginxDir)) {
        return {
          content: [{ type: "text", text: "Access denied: path is outside nginx directory" }],
          isError: true,
        };
      }

      const { readFileSync } = await import("fs");
      const content = readFileSync(resolvedPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    return {
      content: [{ type: "text", text: `Unknown resource URI: ${uri}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

// Handle tool calls
export async function handleToolCall(
  name: string,
  args: Record<string, any>,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "list_configs": {
        const { listConfigFiles } = await import("~/lib/nginx/parser");
        const NGINX_DIR = process.env.NGINX_DIR || "/etc/nginx";
        const files = listConfigFiles(NGINX_DIR);
        return {
          content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
        };
      }
      case "read_config": {
        const { readFileSync } = await import("fs");
        const content = readFileSync(args.path, "utf-8");
        return { content: [{ type: "text", text: content }] };
      }
      case "write_config": {
        const { writeFileSync, mkdirSync } = await import("fs");
        const { dirname } = await import("path");
        mkdirSync(dirname(args.path), { recursive: true });
        writeFileSync(args.path, args.content);
        return {
          content: [{ type: "text", text: `Written ${args.path}` }],
        };
      }
      case "delete_config": {
        const { unlinkSync } = await import("fs");
        unlinkSync(args.path);
        return {
          content: [{ type: "text", text: `Deleted ${args.path}` }],
        };
      }
      case "validate_config": {
        const { validateNginxConfig } = await import("~/lib/nginx/validator");
        const result = validateNginxConfig();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }
      case "reload_nginx": {
        const { reloadNginx } = await import("~/lib/nginx/reload");
        const ok = reloadNginx();
        return {
          content: [
            {
              type: "text",
              text: ok
                ? "Nginx reloaded successfully"
                : "Failed to reload nginx",
            },
          ],
        };
      }
      case "get_stats": {
        const { getSystemStats } = await import("~/lib/system/stats");
        const stats = getSystemStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }
      case "list_hosts": {
        const { db } = await import("~/lib/db/connection");
        const { hosts } = await import("~/lib/db/schema");
        const allHosts = db.select().from(hosts).all();
        return {
          content: [{ type: "text", text: JSON.stringify(allHosts, null, 2) }],
        };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}
