import type { Route } from "./+types/configs";
import { requireEditor } from "~/lib/auth/middleware";
import { listConfigFiles } from "~/lib/nginx/parser";

const NGINX_DIR = process.env.NGINX_DIR || "/etc/nginx";

export async function loader({ request }: Route.LoaderArgs) {
  await requireEditor(request);
  const files = listConfigFiles(NGINX_DIR);
  return Response.json({ files });
}
