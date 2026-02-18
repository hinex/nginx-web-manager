import type { Route } from "./+types/export";
import { requireAdmin } from "~/lib/auth/middleware";
import { listConfigFiles } from "~/lib/nginx/parser";
import { readFileSync } from "fs";
import { relative } from "path";
import { gzipSync } from "zlib";
import { db } from "~/lib/db/connection";
import {
  hosts,
  hostGroups,
  settings,
  accessLists,
  accessListClients,
  accessListAuth,
  customTemplates,
} from "~/lib/db/schema";
import { createTar } from "~/lib/backup/tar";
import { encryptBackup } from "~/lib/backup/crypto";

const NGINX_DIR = process.env.NGINX_DIR || "/data/nginx";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const password = url.searchParams.get("password") || "";

  // Collect all nginx config files with relative paths
  const configFiles = listConfigFiles(NGINX_DIR);
  const configs: Record<string, string> = {};
  for (const file of configFiles) {
    try {
      const relPath = relative(NGINX_DIR, file);
      configs[relPath] = readFileSync(file, "utf-8");
    } catch {
      // Skip unreadable files
    }
  }

  // Collect DB data (metadata only)
  const dbData = {
    hosts: db.select().from(hosts).all(),
    hostGroups: db.select().from(hostGroups).all(),
    settings: db.select().from(settings).all(),
    accessLists: db.select().from(accessLists).all(),
    accessListClients: db.select().from(accessListClients).all(),
    accessListAuth: db.select().from(accessListAuth).all(),
  };

  // Collect custom templates
  const templates = db.select().from(customTemplates).all();

  // Build metadata
  const metadata = {
    version: 2,
    exportedAt: new Date().toISOString(),
  };

  // Build tar entries
  const tarEntries: Array<{ name: string; content: Buffer }> = [];

  // Add metadata.json
  tarEntries.push({
    name: "metadata.json",
    content: Buffer.from(JSON.stringify(metadata, null, 2), "utf-8"),
  });

  // Add database.json
  tarEntries.push({
    name: "database.json",
    content: Buffer.from(JSON.stringify(dbData, null, 2), "utf-8"),
  });

  // Add custom-templates.json
  tarEntries.push({
    name: "custom-templates.json",
    content: Buffer.from(JSON.stringify(templates, null, 2), "utf-8"),
  });

  // Add config files under configs/ directory
  for (const [relPath, content] of Object.entries(configs)) {
    tarEntries.push({
      name: `configs/${relPath}`,
      content: Buffer.from(content, "utf-8"),
    });
  }

  // Create tar and gzip
  const tarBuffer = createTar(tarEntries);
  let outputBuffer: Buffer = gzipSync(tarBuffer);

  const date = new Date().toISOString().split("T")[0];

  // Optionally encrypt
  if (password) {
    outputBuffer = encryptBackup(outputBuffer, password);

    return new Response(new Uint8Array(outputBuffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="nginx-manager-backup-${date}.tar.gz.enc"`,
      },
    });
  }

  return new Response(new Uint8Array(outputBuffer), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="nginx-manager-backup-${date}.tar.gz"`,
    },
  });
}
