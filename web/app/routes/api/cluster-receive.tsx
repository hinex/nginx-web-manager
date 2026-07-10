import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { timingSafeEqual } from "crypto";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";

function keysMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const clusterKey = request.headers.get("x-cluster-key");
  const expectedKey = process.env.CLUSTER_API_KEY;

  if (!keysMatch(clusterKey, expectedKey)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { configs } = await request.json();

  if (!configs || typeof configs !== "object") {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const results = { written: 0, errors: [] as string[] };

  for (const [path, content] of Object.entries(configs)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content as string);
      results.written++;
    } catch (err) {
      results.errors.push(`${path}: ${(err as Error).message}`);
    }
  }

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

  const reloaded = reloadNginx();

  return Response.json({
    success: true,
    results: { ...results, reloaded },
  });
}
