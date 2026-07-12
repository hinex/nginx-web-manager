import { getHost, updateHost, deleteHost } from "~/lib/services/hosts";
import { requireAuth, parseJsonBody, toResponse, methodNotAllowed, parsePositiveInt } from "./shared";

function badId(): Response {
  return Response.json(
    { error: "Invalid host id: must be a positive integer", code: "bad_request" },
    { status: 400 }
  );
}

export async function loader({ request, params }: { request: Request; params: Record<string, string> }) {
  const id = parsePositiveInt(params.id);
  if (id === null) return badId();

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const host = getHost(auth.auth, id);
    return Response.json(host);
  } catch (err) {
    return toResponse(err);
  }
}

export async function action({ request, params }: { request: Request; params: Record<string, string> }) {
  const id = parsePositiveInt(params.id);
  if (id === null) return badId();

  const method = request.method.toUpperCase();

  if (method === "PATCH") {
    const auth = await requireAuth(request);
    if (!auth.ok) return auth.response;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    try {
      const host = await updateHost(auth.auth, id, parsed.data as Record<string, unknown>);
      return Response.json(host);
    } catch (err) {
      return toResponse(err);
    }
  }

  if (method === "DELETE") {
    const auth = await requireAuth(request);
    if (!auth.ok) return auth.response;

    try {
      const result = await deleteHost(auth.auth, id);
      return Response.json(result);
    } catch (err) {
      return toResponse(err);
    }
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
