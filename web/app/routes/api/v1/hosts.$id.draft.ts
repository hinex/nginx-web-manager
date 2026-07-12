import { discardHostDraft } from "~/lib/services/hosts";
import { requireAuth, toResponse, methodNotAllowed, parsePositiveInt } from "./shared";

function badId(): Response {
  return Response.json(
    { error: "Invalid host id: must be a positive integer", code: "bad_request" },
    { status: 400 }
  );
}

export function loader({ request }: { request: Request; params: Record<string, string> }) {
  return methodNotAllowed(["DELETE"]);
}

export async function action({ request, params }: { request: Request; params: Record<string, string> }) {
  const id = parsePositiveInt(params.id);
  if (id === null) return badId();

  if (request.method.toUpperCase() !== "DELETE") {
    return methodNotAllowed(["DELETE"]);
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const host = discardHostDraft(auth.auth, id);
    return Response.json(host);
  } catch (err) {
    return toResponse(err);
  }
}
