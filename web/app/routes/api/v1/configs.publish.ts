import { publishConfig } from "~/lib/services/configs";
import { requireAuth, toResponse, methodNotAllowed } from "./shared";

export async function loader({ request }: { request: Request; params: Record<string, string> }) {
  return methodNotAllowed(["POST"]);
}

export async function action({ request }: { request: Request; params: Record<string, string> }) {
  if (request.method.toUpperCase() !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return Response.json({ error: "Missing required query param: path", code: "bad_request" }, { status: 400 });
  }

  try {
    const result = publishConfig(auth.auth, path);
    return Response.json(result);
  } catch (err) {
    return toResponse(err);
  }
}
