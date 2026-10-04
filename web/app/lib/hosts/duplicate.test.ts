import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { eq, getTableColumns } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "~/lib/db/schema";
import { hosts, hostLabels, hostLabelAssignments, healthChecks } from "~/lib/db/schema";
import { duplicateHost, RESET_ON_DUPLICATE } from "./duplicate";

// Table shape comes from the real migrations, never a hand-written CREATE TABLE (§50).
function migratedDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = join(process.cwd(), "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt.trim());
    }
  }
  return drizzle(sqlite, { schema });
}

/**
 * A non-default value for every hosts column, so "copied" cannot pass by both rows
 * holding the same default. Typed against the table: a column added to the schema
 * without a value here fails to compile, and the per-column loop below fails at
 * runtime — either way the new column needs a decision (copy it, or reset it).
 */
const SOURCE: { [K in keyof typeof hosts.$inferSelect]: (typeof hosts.$inferSelect)[K] } = {
  id: 7,
  groupId: null,
  domains: ["app.example.com", "www.app.example.com"],
  enabled: true,
  sslType: "letsencrypt",
  sslForceHttps: true,
  sslCertPath: "/etc/letsencrypt/live/app.example.com/fullchain.pem",
  sslKeyPath: "/etc/letsencrypt/live/app.example.com/privkey.pem",
  hsts: false,
  http2: false,
  compression: false,
  redirectWww: true,
  clientMaxBodySize: "50m",
  locations: [
    {
      path: "/",
      matchType: "prefix",
      type: "proxy",
      upstreams: [{ server: "10.0.0.5", port: 8080, weight: 1, protocol: "http" }],
      balanceMethod: "round_robin",
      staticDir: "",
      cacheExpires: "",
      forwardScheme: "",
      forwardDomain: "",
      forwardPath: "",
      preservePath: false,
      statusCode: 301,
      headers: { "X-Env": "prod" },
      accessListId: null,
      basicAuth: { enabled: true, users: [{ username: "loc", password: "$2b$10$locationhash" }] },
    } as any,
  ],
  streamPorts: [{ port: 5432, protocol: "tcp", upstreams: [{ server: "db", port: 5432, weight: 1 }], balanceMethod: "round_robin" }],
  webhookUrl: "https://hooks.example.com/x",
  advancedNginx: "proxy_buffer_size 128k;",
  customPrelude: "map $http_upgrade $connection_upgrade { default upgrade; }",
  basicAuth: { enabled: true, users: [{ username: "admin", password: "$2b$10$hosthash" }] },
  draft: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-02T00:00:00Z"),
};

function seed(db: ReturnType<typeof migratedDb>, overrides: Partial<typeof SOURCE> = {}) {
  db.insert(hosts).values({ ...SOURCE, ...overrides }).run();
  const a = db.insert(hostLabels).values({ name: "prod", color: "red", createdAt: new Date() }).returning().get();
  const b = db.insert(hostLabels).values({ name: "web", color: "blue", createdAt: new Date() }).returning().get();
  db.insert(hostLabelAssignments).values({ hostId: SOURCE.id, labelId: a.id }).run();
  db.insert(hostLabelAssignments).values({ hostId: SOURCE.id, labelId: b.id }).run();
  db.insert(healthChecks)
    .values({ hostId: SOURCE.id, hostType: "proxy", upstream: "10.0.0.5:8080", status: "up", checkedAt: new Date() })
    .run();
  return [a.id, b.id];
}

describe("duplicateHost", () => {
  it("copies every column except the ones it resets, and says what it reset", () => {
    const db = migratedDb();
    seed(db);
    const before = db.select().from(hosts).where(eq(hosts.id, SOURCE.id)).get()!;

    const newId = duplicateHost(db, SOURCE.id);
    const copy = db.select().from(hosts).where(eq(hosts.id, newId)).get()!;

    expect(newId).not.toBe(SOURCE.id);
    for (const key of Object.keys(getTableColumns(hosts)) as (keyof typeof copy)[]) {
      if (key in RESET_ON_DUPLICATE || key === "id" || key === "createdAt" || key === "updatedAt") continue;
      expect(copy[key], `column ${key}`).toEqual(before[key]);
    }
    expect(copy.enabled).toBe(false);
    expect(copy.sslType).toBe("none");
    expect(copy.sslCertPath).toBeNull();
    expect(copy.sslKeyPath).toBeNull();
  });

  it("keeps the bcrypt hashes, so the copy's passwords work without retyping", () => {
    const db = migratedDb();
    seed(db);
    const copy = db.select().from(hosts).where(eq(hosts.id, duplicateHost(db, SOURCE.id))).get()!;
    expect((copy.basicAuth as any).users[0].password).toBe("$2b$10$hosthash");
    expect((copy.locations as any)[0].basicAuth.users[0].password).toBe("$2b$10$locationhash");
  });

  it("copies label assignments but not health-check history", () => {
    const db = migratedDb();
    const labelIds = seed(db);
    const newId = duplicateHost(db, SOURCE.id);

    const labels = db.select().from(hostLabelAssignments).where(eq(hostLabelAssignments.hostId, newId)).all();
    expect(labels.map((l) => l.labelId).sort()).toEqual(labelIds.sort());
    expect(db.select().from(healthChecks).where(eq(healthChecks.hostId, newId)).all()).toEqual([]);
  });

  it("strips the certificate from an unpublished draft as well", () => {
    const db = migratedDb();
    seed(db, {
      draft: {
        domains: ["draft.example.com"],
        sslType: "custom",
        sslCertPath: "/certs/a.pem",
        sslKeyPath: "/certs/a.key",
        advancedNginx: "gzip on;",
      },
    });
    const copy = db.select().from(hosts).where(eq(hosts.id, duplicateHost(db, SOURCE.id))).get()!;
    expect(copy.draft).toEqual({
      domains: ["draft.example.com"],
      sslType: "none",
      sslCertPath: "",
      sslKeyPath: "",
      advancedNginx: "gzip on;",
      enabled: false,
    });
  });

  it("leaves the source host untouched", () => {
    const db = migratedDb();
    seed(db);
    const before = db.select().from(hosts).where(eq(hosts.id, SOURCE.id)).get()!;
    duplicateHost(db, SOURCE.id);
    expect(db.select().from(hosts).where(eq(hosts.id, SOURCE.id)).get()).toEqual(before);
    expect(db.select().from(hostLabelAssignments).where(eq(hostLabelAssignments.hostId, SOURCE.id)).all()).toHaveLength(2);
  });

  it("throws for a host that does not exist", () => {
    const db = migratedDb();
    expect(() => duplicateHost(db, 999)).toThrow(/999/);
  });
});
