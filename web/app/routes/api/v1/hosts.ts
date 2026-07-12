import { listHosts, createHost } from "~/lib/services/hosts";
import { requireAuth, parseJsonBody, toResponse, methodNotAllowed } from "./shared";

export async function loader({ request }: { request: Request; params: Record<string, string> }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  if (request.method.toUpperCase() !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  try {
    const hosts = listHosts(auth.auth);
    return Response.json(hosts);
  } catch (err) {
    return toResponse(err);
  }
}

export async function action({ request }: { request: Request; params: Record<string, string> }) {
  const method = request.method.toUpperCase();

  if (method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;

  try {
    const host = await createHost(auth.auth, parsed.data as Record<string, unknown>);
    return Response.json(host, { status: 201 });
  } catch (err) {
    return toResponse(err);
  }
}
