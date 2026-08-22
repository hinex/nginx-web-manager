import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

/**
 * Characterisation of the driver, not of our code.
 *
 * In a mixed patch — one with at least one defined key — drizzle omits the
 * undefined keys from the generated UPDATE and those columns keep their old
 * values. So `col: data.col || undefined`, the shape that used to live in
 * `app/routes/admin/hosts/edit.tsx` and `app/lib/services/hosts.ts`, could
 * never clear a field: emptying it in the form reported success and changed
 * nothing. Those call sites always set `domains`, `enabled`, `updatedAt` and
 * more alongside, so the mixed case is the only one they ever hit.
 *
 * In an update, an optional field is `null`. `undefined` means "do not touch".
 *
 * The all-undefined patch is a different animal: drizzle refuses it outright
 * rather than emitting `UPDATE ... SET` with nothing after it. Pinned below so
 * that a caller which builds a patch entirely out of `|| undefined` is known to
 * throw in production rather than to quietly do nothing.
 */

const rows = sqliteTable("rows", {
  id: integer("id").primaryKey(),
  nullable: text("nullable"),
  other: text("other"),
});

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, nullable TEXT, other TEXT)");
  const db = drizzle(sqlite);
  db.insert(rows).values({ id: 1, nullable: "old", other: "sibling" }).run();
  return db;
}

const read = (db: ReturnType<typeof freshDb>) =>
  db.select().from(rows).where(eq(rows.id, 1)).get();

describe("drizzle .set() column semantics", () => {
  it("skips an undefined value, keeping the old one", () => {
    const db = freshDb();
    db.update(rows).set({ nullable: undefined, other: "touched" }).where(eq(rows.id, 1)).run();
    expect(read(db)?.nullable).toBe("old");
  });

  it("applies the defined siblings of an undefined key", () => {
    const db = freshDb();
    db.update(rows).set({ nullable: undefined, other: "touched" }).where(eq(rows.id, 1)).run();
    expect(read(db)?.other).toBe("touched");
  });

  it("writes an explicit null", () => {
    const db = freshDb();
    db.update(rows).set({ nullable: null, other: "touched" }).where(eq(rows.id, 1)).run();
    expect(read(db)?.nullable).toBeNull();
  });

  it("refuses a patch whose every value is undefined", () => {
    const db = freshDb();
    expect(() =>
      db.update(rows).set({ nullable: undefined, other: undefined }).where(eq(rows.id, 1)).run(),
    ).toThrow(/No values to set/);
  });
});
