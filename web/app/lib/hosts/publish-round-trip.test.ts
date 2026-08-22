import { describe, it, expect, beforeAll } from "vitest";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hosts } from "~/lib/db/schema";
import { nullableHostFields, clientMaxBodySizeOf } from "./publish-fields";

/**
 * The service tests above run against an in-memory fake. This one runs the same
 * shape through the real schema on a real SQLite file, so the claim "a cleared
 * field reads back null" is made by the database rather than by a stand-in.
 *
 * The table comes from the migrations in `drizzle/`, applied in order — never
 * from a hand-written CREATE TABLE, which is how a fixture drifts from the
 * schema it is supposed to represent (§50).
 */

const MIGRATIONS = join(process.cwd(), "drizzle");

function migratedDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = OFF");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  return { sqlite, db: drizzle(sqlite) };
}

describe("a cleared host field survives sqlite", () => {
  let columns: string[];

  beforeAll(() => {
    const { sqlite } = migratedDb();
    columns = (sqlite.query("PRAGMA table_info(hosts)").all() as { name: string }[]).map(
      (c) => c.name,
    );
  });

  it("applies the migrations far enough to have the columns under test", () => {
    expect(columns).toEqual(
      expect.arrayContaining([
        "custom_prelude",
        "advanced_nginx",
        "webhook_url",
        "ssl_cert_path",
        "ssl_key_path",
        "client_max_body_size",
      ]),
    );
  });

  it("writes null for a field the user emptied", () => {
    const { db } = migratedDb();
    db.insert(hosts)
      .values({
        id: 1,
        domains: ["example.com"],
        customPrelude: "map $http_upgrade $connection_upgrade { default upgrade; }",
        advancedNginx: "proxy_buffer_size 128k;",
        clientMaxBodySize: "25m",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const cleared = { customPrelude: "", advancedNginx: "", clientMaxBodySize: "" };
    const nullable = nullableHostFields(cleared);
    db.update(hosts)
      .set({
        customPrelude: nullable.customPrelude,
        advancedNginx: nullable.advancedNginx,
        clientMaxBodySize: clientMaxBodySizeOf(cleared.clientMaxBodySize),
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, 1))
      .run();

    const row = db.select().from(hosts).where(eq(hosts.id, 1)).get()!;
    expect(row.customPrelude).toBeNull();
    expect(row.advancedNginx).toBeNull();
    expect(row.clientMaxBodySize).toBe("1m");
  });

  it("leaves a field the user did not empty", () => {
    const { db } = migratedDb();
    db.insert(hosts)
      .values({
        id: 1,
        domains: ["example.com"],
        customPrelude: "map $x $y { }",
        advancedNginx: "proxy_buffer_size 128k;",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const nullable = nullableHostFields({ customPrelude: "", advancedNginx: "keep me" });
    db.update(hosts)
      .set({
        customPrelude: nullable.customPrelude,
        advancedNginx: nullable.advancedNginx,
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, 1))
      .run();

    const row = db.select().from(hosts).where(eq(hosts.id, 1)).get()!;
    expect(row.customPrelude).toBeNull();
    expect(row.advancedNginx).toBe("keep me");
  });
});
