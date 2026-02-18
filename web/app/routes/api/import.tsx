import type { Route } from "./+types/import";
import { requireAdmin } from "~/lib/auth/middleware";
import { gunzipSync } from "zlib";
import { extractTar } from "~/lib/backup/tar";
import { decryptBackup } from "~/lib/backup/crypto";
import {
  storeImport,
  type ParsedBackup,
} from "~/lib/backup/import-cache";

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);

  const contentType = request.headers.get("content-type") || "";

  try {
    let parsed: ParsedBackup;

    if (contentType.includes("multipart/form-data")) {
      // Handle file upload via FormData (tar.gz or encrypted)
      parsed = await handleFormDataUpload(request);
    } else if (contentType.includes("application/json")) {
      // Legacy JSON format
      parsed = await handleJsonUpload(request);
    } else {
      // Try to auto-detect: read raw body and attempt to parse
      parsed = await handleRawUpload(request);
    }

    // Store in cache and return preview with import ID
    const importId = storeImport(parsed);

    const preview = {
      importId,
      version: parsed.version,
      exportedAt: parsed.exportedAt,
      configFiles: Object.keys(parsed.configs).length,
      configFilesList: Object.keys(parsed.configs),
      hosts: (parsed.database.hosts as unknown[])?.length ?? 0,
      hostGroups: (parsed.database.hostGroups as unknown[])?.length ?? 0,
      settings: (parsed.database.settings as unknown[])?.length ?? 0,
      accessLists: (parsed.database.accessLists as unknown[])?.length ?? 0,
      customTemplates: parsed.customTemplates?.length ?? 0,
    };

    return Response.json(preview);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to process backup file";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * Handle legacy JSON backup format.
 */
async function handleJsonUpload(request: Request): Promise<ParsedBackup> {
  const body = await request.json();

  if (!body.version || !body.configs || !body.database) {
    throw new Error("Invalid backup format");
  }

  return {
    version: body.version,
    exportedAt: body.exportedAt,
    configs: body.configs,
    database: body.database,
    customTemplates: body.customTemplates,
  };
}

/**
 * Handle multipart/form-data upload (file + optional password).
 */
async function handleFormDataUpload(request: Request): Promise<ParsedBackup> {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const password = (formData.get("password") as string) || "";

  if (!file) {
    throw new Error("No file provided");
  }

  const arrayBuffer = await file.arrayBuffer();
  let buffer = Buffer.from(arrayBuffer);

  return parseBackupBuffer(buffer, password);
}

/**
 * Handle raw binary upload with optional password in query string.
 */
async function handleRawUpload(request: Request): Promise<ParsedBackup> {
  const url = new URL(request.url);
  const password = url.searchParams.get("password") || "";

  const arrayBuffer = await request.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Try JSON first
  try {
    const text = buffer.toString("utf-8");
    const body = JSON.parse(text);
    if (body.version && body.configs && body.database) {
      return {
        version: body.version,
        exportedAt: body.exportedAt,
        configs: body.configs,
        database: body.database,
        customTemplates: body.customTemplates,
      };
    }
  } catch {
    // Not JSON, continue with binary handling
  }

  return parseBackupBuffer(buffer, password);
}

/**
 * Parse a backup buffer that is either:
 * - A gzipped tar archive
 * - An encrypted gzipped tar archive (if password is provided)
 */
function parseBackupBuffer(
  buffer: Buffer,
  password: string
): ParsedBackup {
  let tarGzBuffer: Buffer;

  if (password) {
    // Decrypt first
    try {
      tarGzBuffer = decryptBackup(buffer, password);
    } catch {
      throw new Error(
        "Decryption failed. Wrong password or corrupted file."
      );
    }
  } else {
    // Check if it looks like gzip (magic bytes 0x1f 0x8b)
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      tarGzBuffer = buffer;
    } else {
      throw new Error(
        "Unrecognized file format. If the file is encrypted, provide a password."
      );
    }
  }

  // Decompress gzip
  let tarBuffer: Buffer;
  try {
    tarBuffer = gunzipSync(tarGzBuffer);
  } catch {
    throw new Error(
      "Failed to decompress archive. File may be corrupted" +
        (password ? "" : " or encrypted (provide a password)")  +
        "."
    );
  }

  // Extract tar entries
  const entries = extractTar(tarBuffer);

  if (entries.length === 0) {
    throw new Error("Archive is empty or invalid");
  }

  // Parse well-known files
  let metadata: { version: number; exportedAt?: string } = { version: 2 };
  let database: Record<string, unknown[]> = {};
  let customTemplates: unknown[] = [];
  const configs: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.name === "metadata.json") {
      metadata = JSON.parse(entry.content.toString("utf-8"));
    } else if (entry.name === "database.json") {
      database = JSON.parse(entry.content.toString("utf-8"));
    } else if (entry.name === "custom-templates.json") {
      customTemplates = JSON.parse(entry.content.toString("utf-8"));
    } else if (entry.name.startsWith("configs/")) {
      configs[entry.name.slice("configs/".length)] = entry.content.toString(
        "utf-8"
      );
    }
  }

  if (Object.keys(database).length === 0 && Object.keys(configs).length === 0) {
    throw new Error(
      "Archive does not contain expected backup files (database.json or configs)"
    );
  }

  return {
    version: metadata.version,
    exportedAt: metadata.exportedAt,
    configs,
    database,
    customTemplates,
  };
}
