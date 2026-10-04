import { eq, getTableColumns } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { hosts, hostLabelAssignments } from "~/lib/db/schema";

type HostRow = typeof hosts.$inferSelect;

/**
 * Columns a copy does not inherit. Everything else is copied as stored — including
 * bcrypt hashes, so the copy's basic auth works without retyping passwords.
 *
 * - `enabled: false` — the generator skips disabled hosts, so a copy carrying the
 *   source's domains never reaches nginx until the operator publishes it.
 * - SSL is cleared: the certificate belongs to the source's domains, and the copy
 *   is about to get different ones. The operator picks SSL again on publish.
 *
 * The flags `sslForceHttps` / `hsts` / `http2` are kept: they only take effect when
 * `sslType !== "none"`, so they are inert until a certificate is chosen again.
 */
export const RESET_ON_DUPLICATE = {
  enabled: false,
  sslType: "none",
  sslCertPath: null,
  sslKeyPath: null,
} as const satisfies Partial<HostRow>;

/** The same reset in the draft's shape — form data, where an empty path is "". */
const DRAFT_RESET = { enabled: false, sslType: "none", sslCertPath: "", sslKeyPath: "" } as const;

/**
 * Copy a host with all its settings and labels, as a disabled host outside the
 * nginx config. Health-check history is not copied. Returns the new host id.
 *
 * The column list is read from the schema rather than written out, so a column
 * added later is copied by default; `duplicate.test.ts` compares every column.
 */
export function duplicateHost(db: BunSQLiteDatabase<any>, sourceId: number): number {
  return db.transaction((tx) => {
    const source = tx.select().from(hosts).where(eq(hosts.id, sourceId)).get();
    if (!source) throw new Error(`Host ${sourceId} not found`);

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(getTableColumns(hosts)) as (keyof HostRow)[]) {
      if (key === "id") continue;
      values[key] = source[key];
    }
    Object.assign(values, RESET_ON_DUPLICATE);
    const draft = source.draft as Record<string, unknown> | null;
    values.draft = draft == null ? null : { ...draft, ...DRAFT_RESET };
    const now = new Date();
    values.createdAt = now;
    values.updatedAt = now;

    const copy = tx
      .insert(hosts)
      .values(values as typeof hosts.$inferInsert)
      .returning({ id: hosts.id })
      .get();

    const labels = tx
      .select({ labelId: hostLabelAssignments.labelId })
      .from(hostLabelAssignments)
      .where(eq(hostLabelAssignments.hostId, sourceId))
      .all();
    for (const { labelId } of labels) {
      tx.insert(hostLabelAssignments).values({ hostId: copy.id, labelId }).run();
    }

    return copy.id;
  });
}
