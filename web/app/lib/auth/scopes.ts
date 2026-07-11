// Pure scope definitions. MUST stay dependency-free: imported by client components.

export type Scope =
  | "configs:read"
  | "configs:write"
  | "configs:publish"
  | "nginx:validate"
  | "nginx:reload"
  | "hosts:read"
  | "stats:read";

export type Role = "admin" | "editor" | "viewer";

export const ALL_SCOPES: Scope[] = [
  "configs:read",
  "configs:write",
  "configs:publish",
  "nginx:validate",
  "nginx:reload",
  "hosts:read",
  "stats:read",
];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "configs:read": "List and read nginx config files (including drafts)",
  "configs:write": "Write config changes as drafts (never live)",
  "configs:publish": "Publish drafts to live config and delete config files",
  "nginx:validate": "Run nginx -t",
  "nginx:reload": "Reload nginx",
  "hosts:read": "List proxy hosts",
  "stats:read": "Read system status and statistics",
};

const VIEWER_SCOPES: Scope[] = [
  "configs:read",
  "hosts:read",
  "stats:read",
  "nginx:validate",
];

export const ROLE_CEILINGS: Record<Role, Scope[]> = {
  viewer: VIEWER_SCOPES,
  editor: [...VIEWER_SCOPES, "configs:write", "configs:publish", "nginx:reload"],
  admin: ALL_SCOPES,
};

export function isScope(s: string): s is Scope {
  return (ALL_SCOPES as string[]).includes(s);
}

export function intersectScopes(scopes: string[], role: string): Scope[] {
  const ceiling = ROLE_CEILINGS[role as Role] ?? [];
  return ALL_SCOPES.filter((s) => ceiling.includes(s) && scopes.includes(s));
}
