import { eq } from "drizzle-orm";
import { authenticate, type AuthContext } from "~/lib/auth/authenticate";
import {
  toolsForScopes,
  resourcesForScopes,
  handleToolCall,
  handleResourceRead,
  resources,
} from "~/lib/mcp/server";
import { db } from "~/lib/db/connection";
import { settings } from "~/lib/db/schema";

function checkPathSecret(params: { secret?: string }) {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "mcp_path_secret"))
    .get();
  const secret = row?.value?.trim() || "";
  const ok = secret ? params.secret === secret : params.secret === undefined;
  if (!ok) {
    throw new Response("Not Found", { status: 404 });
  }
}

function rpcError(id: unknown, code: number, message: string, status: number) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status }
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { secret?: string };
}) {
  checkPathSecret(params);

  const body = await request.json();
  const { method, id, params: rpcParams } = body;

  let auth: AuthContext;
  try {
    auth = await authenticate(request);
  } catch (err) {
    if (err instanceof Response) {
      return rpcError(id, -32001, "Authentication failed", err.status);
    }
    throw err;
  }

  switch (method) {
    case "initialize":
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "nginx-manager", version: "1.0.0" },
          capabilities: { tools: {}, resources: {} },
        },
      });

    case "notifications/initialized":
      return Response.json({ jsonrpc: "2.0", id, result: {} });

    case "tools/list":
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { tools: toolsForScopes(auth.scopes) },
      });

    case "tools/call": {
      const result = await handleToolCall(auth, rpcParams.name, rpcParams.arguments ?? {});
      return Response.json({ jsonrpc: "2.0", id, result });
    }

    case "resources/list":
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { resources: resourcesForScopes(auth.scopes) },
      });

    case "resources/read": {
      const readResult = await handleResourceRead(auth, rpcParams.uri);
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: rpcParams.uri,
              mimeType:
                resources.find(
                  (r) =>
                    rpcParams.uri === r.uri ||
                    rpcParams.uri.match(
                      new RegExp("^" + r.uri.replace(/\{[^}]+\}/g, ".+"))
                    )
                )?.mimeType ?? "text/plain",
              text: readResult.content[0]?.text ?? "",
            },
          ],
        },
      });
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`, 200);
  }
}

// GET handler returns SSE stream (for MCP SSE transport)
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { secret?: string };
}) {
  checkPathSecret(params);
  try {
    await authenticate(request);
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }

  const url = new URL(request.url);
  const endpoint = `${url.origin}/api/mcp${params.secret ? `/${params.secret}` : ""}`;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`)
      );
      const interval = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          clearInterval(interval);
        }
      }, 30000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
