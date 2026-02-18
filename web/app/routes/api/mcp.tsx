import { requireAdmin } from "~/lib/auth/middleware";
import { tools, handleToolCall, resources, handleResourceRead } from "~/lib/mcp/server";

// POST handler for JSON-RPC requests
export async function action({ request }: { request: Request }) {
  await requireAdmin(request);

  const body = await request.json();
  const { method, id, params } = body;

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
        result: { tools },
      });

    case "tools/call": {
      const result = await handleToolCall(params.name, params.arguments ?? {});
      return Response.json({
        jsonrpc: "2.0",
        id,
        result,
      });
    }

    case "resources/list":
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { resources },
      });

    case "resources/read": {
      const readResult = await handleResourceRead(params.uri);
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: params.uri,
              mimeType: resources.find((r) =>
                params.uri === r.uri || params.uri.match(new RegExp("^" + r.uri.replace(/\{[^}]+\}/g, ".+")))
              )?.mimeType ?? "text/plain",
              text: readResult.content[0]?.text ?? "",
            },
          ],
        },
      });
    }

    default:
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// GET handler returns SSE stream (for MCP SSE transport)
export async function loader({ request }: { request: Request }) {
  await requireAdmin(request);

  // Return an SSE endpoint URL for the MCP client to POST to
  const url = new URL(request.url);
  const endpoint = `${url.origin}/api/mcp`;

  const stream = new ReadableStream({
    start(controller) {
      // Send the endpoint event so the client knows where to POST
      controller.enqueue(
        new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`),
      );
      // Keep the connection alive with periodic pings
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
