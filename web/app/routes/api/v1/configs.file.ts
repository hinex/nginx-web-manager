import { readConfig, writeConfigDraft, deleteConfig } from "~/lib/services/configs";
import { requireAuth, parseJsonBody, toResponse, methodNotAllowed } from "./shared";

export async function loader({ request }: { request: Request; params: Record<string, string> }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return Response.json({ error: "Missing required query param: path", code: "bad_request" }, { status: 400 });
  }

  try {
    const content = readConfig(auth.auth, path);
    return Response.json({ content });
  } catch (err) {
    return toResponse(err);
  }
}

export async function action({ request }: { request: Request; params: Record<string, string> }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const path = url.searchParams.get("path");

  const method = request.method.toUpperCase();

  if (method === "DELETE") {
    if (!path) {
      return Response.json({ error: "Missing required query param: path", code: "bad_request" }, { status: 400 });
    }
    try {
      const result = deleteConfig(auth.auth, path);
      return Response.json(result);
    } catch (err) {
      return toResponse(err);
    }
  }

  if (method === "PUT") {
    if (!path) {
      return Response.json({ error: "Missing required query param: path", code: "bad_request" }, { status: 400 });
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const body = parsed.data as Record<string, unknown>;
    if (typeof body?.content !== "string") {
      return Response.json(
        { error: "Body must include a string field: content", code: "bad_request" },
        { status: 400 }
      );
    }

    try {
      const result = writeConfigDraft(auth.auth, path, body.content, body.message as string | undefined);
      return Response.json(result);
    } catch (err) {
      return toResponse(err);
    }
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}
