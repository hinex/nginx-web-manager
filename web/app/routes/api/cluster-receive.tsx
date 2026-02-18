/**
 * Receives config files from the controller node.
 * Auth: X-Cluster-Key header must match the CLUSTER_API_KEY env var.
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";

export async function action({ request }: { request: Request }) {
  // Only accept POST
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Verify cluster API key
  const clusterKey = request.headers.get("x-cluster-key");
  const expectedKey = process.env.CLUSTER_API_KEY;

  if (!expectedKey || clusterKey !== expectedKey) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { configs } = await request.json();

  if (!configs || typeof configs !== "object") {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const results = { written: 0, errors: [] as string[] };

  // Write config files
  for (const [path, content] of Object.entries(configs)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content as string);
      results.written++;
    } catch (err) {
      results.errors.push(`${path}: ${(err as Error).message}`);
    }
  }

  // Validate nginx config
  const validation = validateNginxConfig();
  if (!validation.valid) {
    return Response.json(
      {
        error: "Config validation failed",
        details: validation.error,
        results,
      },
      { status: 400 }
    );
  }

  // Reload nginx
  const reloaded = reloadNginx();

  return Response.json({
    success: true,
    results: { ...results, reloaded },
  });
}
