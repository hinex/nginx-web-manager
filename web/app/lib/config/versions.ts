import { db } from "~/lib/db/connection";
import { configVersions } from "~/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { diffLines, type Change } from "diff";

export interface SaveVersionInput {
  filePath: string;
  content: string;
  changeType: "manual_edit" | "form_save" | "template_apply" | "restore" | "import";
  userId?: number | null;
  message?: string;
}

/**
 * Save a config version snapshot.
 */
export function saveVersion(input: SaveVersionInput) {
  return db
    .insert(configVersions)
    .values({
      filePath: input.filePath,
      content: input.content,
      changeType: input.changeType,
      userId: input.userId ?? null,
      message: input.message ?? null,
    })
    .returning()
    .get();
}

/**
 * Get version history for a file, newest first.
 */
export function getVersions(filePath: string, limit: number = 50) {
  return db
    .select()
    .from(configVersions)
    .where(eq(configVersions.filePath, filePath))
    .orderBy(desc(configVersions.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get a single version by ID.
 */
export function getVersion(id: number) {
  return db
    .select()
    .from(configVersions)
    .where(eq(configVersions.id, id))
    .get();
}

/**
 * Compute a line-by-line diff between two config strings.
 */
export function diffVersions(oldText: string, newText: string): Change[] {
  return diffLines(oldText, newText);
}
