import { reload } from "~/lib/services/nginx";
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

  try {
    const result = reload(auth.auth);
    return Response.json(result);
  } catch (err) {
    return toResponse(err);
  }
}
