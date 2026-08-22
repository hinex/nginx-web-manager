import type { Route } from "./+types/configs";
import { requireEditor } from "~/lib/auth/middleware";
import { listConfigFiles } from "~/lib/nginx/parser";
import { nginxDir } from "~/lib/paths";


export async function loader({ request }: Route.LoaderArgs) {
  await requireEditor(request);
  const files = listConfigFiles(nginxDir());
  return Response.json({ files });
}
