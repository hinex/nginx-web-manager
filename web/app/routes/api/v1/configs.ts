import { listConfigs } from "~/lib/services/configs";
import { requireAuth, toResponse, methodNotAllowed } from "./shared";

export async function loader({ request }: { request: Request; params: Record<string, string> }) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = listConfigs(auth.auth);
    return Response.json(result);
  } catch (err) {
    return toResponse(err);
  }
}

export async function action({ request }: { request: Request; params: Record<string, string> }) {
  return methodNotAllowed(["GET"]);
}
