import type { Route } from "./+types/system-stats";
import { requireAuth } from "~/lib/auth/middleware";
import { getSystemStats } from "~/lib/system/stats";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  const stats = getSystemStats();
  return Response.json(stats);
}
