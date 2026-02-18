import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// ─── Users ───────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "editor", "viewer"] })
    .notNull()
    .default("viewer"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  theme: text("theme", { enum: ["light", "dark", "system"] }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Host Groups ─────────────────────────────────────────
export const hostGroups = sqliteTable("host_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  webhookUrl: text("webhook_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Hosts (location-centric) ───────────────────────────
export const hosts = sqliteTable("hosts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").references(() => hostGroups.id, { onDelete: "set null" }),
  domains: text("domains", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  // SSL
  sslType: text("ssl_type", { enum: ["none", "letsencrypt", "custom"] })
    .notNull()
    .default("none"),
  sslForceHttps: integer("ssl_force_https", { mode: "boolean" })
    .notNull()
    .default(false),
  sslCertPath: text("ssl_cert_path"),
  sslKeyPath: text("ssl_key_path"),
  hsts: integer("hsts", { mode: "boolean" }).notNull().default(true),
  http2: integer("http2", { mode: "boolean" }).notNull().default(true),
  compression: integer("compression", { mode: "boolean" }).notNull().default(true),
  redirectWww: integer("redirect_www", { mode: "boolean" }).notNull().default(false),

  // Nginx-specific
  clientMaxBodySize: text("client_max_body_size").notNull().default("1m"),

  // Locations (all routing logic lives here)
  locations: text("locations", { mode: "json" })
    .$type<Array<{
      path: string;
      matchType: "prefix" | "exact" | "regex";
      type: "proxy" | "static" | "redirect";
      upstreams: Array<{ server: string; port: number; weight: number }>;
      balanceMethod: string;
      staticDir: string;
      cacheExpires: string;
      forwardScheme: string;
      forwardDomain: string;
      forwardPath: string;
      preservePath: boolean;
      statusCode: number;
      headers: Record<string, string>;
      accessListId: number | null;
    }>>()
    .notNull()
    .default([]),

  // Stream ports (TCP/UDP forwarding, separate from HTTP locations)
  streamPorts: text("stream_ports", { mode: "json" })
    .$type<Array<{
      port: number;
      protocol: "tcp" | "udp";
      upstreams: Array<{ server: string; port: number; weight: number }>;
      balanceMethod: string;
    }>>()
    .default([]),

  // Common
  webhookUrl: text("webhook_url"),
  advancedNginx: text("advanced_nginx"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Host Labels ────────────────────────────────────────
export const hostLabels = sqliteTable("host_labels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Host Label Assignments ─────────────────────────────
export const hostLabelAssignments = sqliteTable("host_label_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  labelId: integer("label_id")
    .notNull()
    .references(() => hostLabels.id, { onDelete: "cascade" }),
});

// ─── Access Lists ────────────────────────────────────────
export const accessLists = sqliteTable("access_lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  satisfy: text("satisfy", { enum: ["any", "all"] })
    .notNull()
    .default("any"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const accessListClients = sqliteTable("access_list_clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accessListId: integer("access_list_id")
    .notNull()
    .references(() => accessLists.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  directive: text("directive", { enum: ["allow", "deny"] })
    .notNull()
    .default("allow"),
});

export const accessListAuth = sqliteTable("access_list_auth", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accessListId: integer("access_list_id")
    .notNull()
    .references(() => accessLists.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  password: text("password").notNull(),
});

// ─── Health Checks ───────────────────────────────────────
export const healthChecks = sqliteTable(
  "health_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostId: integer("host_id"),
    hostType: text("host_type", { enum: ["proxy", "stream", "static", "redirect"] })
      .notNull()
      .default("proxy"),
    upstream: text("upstream").notNull(),
    status: text("status", { enum: ["up", "down"] }).notNull(),
    responseMs: integer("response_ms"),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_health_checks_host_time").on(table.hostId, table.checkedAt),
  ]
);

// ─── Audit Log ───────────────────────────────────────────
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", {
      enum: ["create", "update", "delete", "login", "logout", "reload"],
    }).notNull(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_audit_log_created").on(table.createdAt),
  ]
);

// ─── Settings ────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

// ─── 2FA: TOTP Secrets ──────────────────────────────────
export const userTotpSecrets = sqliteTable("user_totp_secrets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  secret: text("secret").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── 2FA: WebAuthn Credentials ──────────────────────────
export const userWebauthnCredentials = sqliteTable(
  "user_webauthn_credentials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceName: text("device_name"),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_webauthn_user").on(table.userId),
  ]
);

// ─── 2FA: Recovery Codes ────────────────────────────────
export const userRecoveryCodes = sqliteTable(
  "user_recovery_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    used: integer("used", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_recovery_codes_user").on(table.userId),
  ]
);

// ─── DNS Credentials ────────────────────────────────────
export const dnsCredentials = sqliteTable("dns_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  provider: text("provider", { enum: ["cloudflare"] }).notNull(),
  apiToken: text("api_token").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── DNS Domains ────────────────────────────────────────
export const dnsDomains = sqliteTable("dns_domains", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => dnsCredentials.id, { onDelete: "cascade" }),
  zoneId: text("zone_id").notNull(),
  domain: text("domain").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Cluster Nodes ──────────────────────────────────────
export const clusterNodes = sqliteTable("cluster_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  url: text("url").notNull().unique(), // e.g., "https://worker1.example.com"
  apiKey: text("api_key").notNull(), // shared secret for auth
  role: text("role", { enum: ["controller", "worker"] })
    .notNull()
    .default("worker"),
  status: text("status", { enum: ["online", "offline", "syncing", "error"] })
    .notNull()
    .default("offline"),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Custom Templates ────────────────────────────────────
export const customTemplates = sqliteTable("custom_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("custom"),
  content: text("content").notNull(),
  variables: text("variables", { mode: "json" }).$type<Array<{ name: string; label: string; default: string }>>(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Config Sync Tags ───────────────────────────────────
export const configSyncTags = sqliteTable("config_sync_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filePath: text("file_path").notNull().unique(),
  syncMode: text("sync_mode", { enum: ["cluster-synced", "local-only"] })
    .notNull()
    .default("cluster-synced"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Config Versions ────────────────────────────────────
export const configVersions = sqliteTable(
  "config_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    changeType: text("change_type", {
      enum: ["manual_edit", "form_save", "template_apply", "restore", "import"],
    }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    message: text("message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_config_versions_file_path").on(table.filePath),
    index("idx_config_versions_created").on(table.createdAt),
  ]
);
