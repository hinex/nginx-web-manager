import type { Route } from "./+types/test-upstream";
import { checkUpstream } from "~/lib/watchdog/health-check";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { server, port } = body;

    if (!server || typeof server !== "string") {
      return Response.json({ error: "server is required" }, { status: 400 });
    }
    if (!port || typeof port !== "number" || port < 1 || port > 65535) {
      return Response.json({ error: "port must be 1-65535" }, { status: 400 });
    }

    const result = await checkUpstream(server, port);
    return Response.json(result);
  } catch {
    return Response.json(
      { status: "down", responseMs: 0, error: "Invalid request" },
      { status: 400 }
    );
  }
}
