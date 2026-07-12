import { getHost, updateHost, deleteHost } from "~/lib/services/hosts";
import { requireAuth, parseJsonBody, toResponse, methodNotAllowed } from "./shared";

/** Parse :id as a positive integer. Returns the integer or null on failure. */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  // Reject anything that isn't a pure decimal integer string (no decimals, no signs that slip through, no whitespace)
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

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
