# Design: Secure MCP/API layer with scoped tokens

**Date:** 2026-07-11
**Status:** Approved

## Problem

nginx-manager has an MCP endpoint (`web/app/routes/api/mcp.tsx` + `web/app/lib/mcp/server.ts`), but:

1. Auth is session-cookie only (`requireAdmin`) — external MCP clients (Claude Code, agents) cannot connect without a browser session; no tokens exist.
2. MCP tools bypass every application safety mechanism: `write_config` / `delete_config` write directly to the filesystem — no versioning (`saveVersion`), no audit (`logAudit`), no draft/publish workflow.
3. **Security hole:** `read_config` / `write_config` accept arbitrary absolute paths. The `NGINX_DIR` containment check exists only in resource reads, not in tools. An MCP call can read/write any file the process can access.
4. `reload_nginx` via MCP is not audit-logged (the UI path logs `action: "reload"`).
5. No granular permissions: everything is all-or-nothing behind admin.
6. Business logic is spread across route files; no reusable service layer.

## Decisions (agreed with user)

- **Token model:** personal API tokens bound to users, with scopes narrowed below the owner's role ceiling. No separate service accounts.
- **Write semantics:** draft-only by default. MCP `write_config` always creates a draft and runs `nginx -t`. Publishing requires the explicit `configs:publish` scope (for deliberately autonomous agents) or a human in the UI.
- **API surface:** shared service layer (`lib/services/`); MCP is the only external API. No REST `/api/v1` for now (trivially addable later on top of services). YAGNI.
- **URL hardening:** optional secret path prefix (`mcp_path_secret` setting) as a cheap extra layer on top of — never instead of — token auth.

## 1. Scopes

| Scope | Grants |
|---|---|
| `configs:read` | `list_configs`, `read_config` |
| `configs:write` | `write_config` (always draft + auto `nginx -t`) |
| `configs:publish` | `publish_config` (draft → live), `delete_config` |
| `nginx:validate` | `validate_config` |
| `nginx:reload` | `reload_nginx` |
| `hosts:read` | `list_hosts` |
| `stats:read` | `get_stats`, resource `nginx://status` |

**Role ceiling** (enforced at token creation AND on every request, since a role may be downgraded after issuance):

- `viewer` → `configs:read`, `hosts:read`, `stats:read`, `nginx:validate`
- `editor` → viewer + `configs:write`, `configs:publish`, `nginx:reload`
- `admin` → all

Effective permissions = intersection(token scopes, role ceiling).

## 2. Schema: `api_tokens` (drizzle migration)

```
id           integer PK autoincrement
userId       integer → users.id, onDelete: cascade
name         text        -- e.g. "claude-code on laptop"
tokenHash    text unique -- sha256 of the token
scopes       text json   -- string[]
expiresAt    integer timestamp_ms, nullable (presets: 7d / 30d / 90d / never)
lastUsedAt   integer timestamp_ms, nullable
revokedAt    integer timestamp_ms, nullable
createdAt    integer timestamp_ms
```

- Token format: `ngm_` + 32 random bytes (base64url). Displayed exactly once at creation.
- Hash comparison: constant-time.
- Revocation is immediate (DB lookup per request; fine for SQLite).

## 3. Auth: single entry point

New `authenticate(request): Promise<AuthContext>` in `lib/auth/`:

```
AuthContext {
  userId: number
  via: "session" | "token"
  tokenId?: number
  scopes: string[]   // token: intersection(scopes, role ceiling); session: full role ceiling
}
```

1. `Authorization: Bearer ngm_...` present → hash lookup → reject if revoked/expired → load user → intersect scopes with role ceiling → update `lastUsedAt`.
2. Otherwise → existing session path (`getSessionUser`).
3. Both paths go through existing `checkIpWhitelist` (CIDR) and rate-limit (`lib/auth/rate-limit.ts`).

## 4. Service layer: `lib/services/`

Pure functions taking `AuthContext` as the first argument; each checks its required scope and throws `ForbiddenError` (with the missing scope named). UI routes and MCP tools become thin wrappers.

- `services/configs.ts` — `listConfigs`, `readConfig`, `writeConfigDraft`, `publishConfig`, `deleteConfig`
  - **Path containment:** every path resolved and required to stay within `NGINX_DIR` (fixes the traversal hole).
  - `writeConfigDraft`: saves version (`saveVersion`), writes draft, runs `nginx -t`, logs audit, returns validation result.
  - `deleteConfig`: saves a version snapshot before deleting (undo-able), logs audit.
- `services/nginx.ts` — `validate`, `reload` (logs audit with `action: "reload"`)
- `services/stats.ts` — `getStats`
- `services/hosts.ts` — `listHosts`

All mutations call `logAudit` with `tokenId` in `details` when `via === "token"`.

## 5. MCP rework (`api/mcp.tsx`, `lib/mcp/server.ts`)

- Switch from `requireAdmin` to `authenticate()` — works with Bearer token or session.
- **`tools/list` is filtered by effective scopes** — the client only sees tools it may call. Calling an unlisted tool returns a scope error anyway (defense in depth).
- `write_config` → `writeConfigDraft`; tool response states: draft saved, validation result, and that publishing requires UI or `publish_config`.
- New tool `publish_config` (scope `configs:publish`).
- Auth failures → JSON-RPC error with 401; missing scope → 403-style JSON-RPC error: `token lacks scope configs:publish`.

## 6. UI (Security/Settings page)

- **API Tokens section:** create (name, scope checkboxes with human descriptions, expiry preset), list with `lastUsedAt`, revoke button. Token shown once, with a ready snippet:
  `claude mcp add nginx-manager --transport http <url> --header "Authorization: Bearer ngm_..."`
- **MCP Endpoint section:** `mcp_path_secret` setting. When set, endpoint lives at `/api/mcp/<secret>`; bare `/api/mcp` returns 404. "Regenerate" button invalidates the old URL immediately.

## 7. Error handling

- 401 for missing/invalid/expired/revoked token.
- 403 with explicit missing-scope message.
- Path outside `NGINX_DIR` → error result, never a write.
- Failed `nginx -t` on draft → draft kept, validation errors returned to the caller.

## 8. Testing

- **Unit:** token auth (expired / revoked / wrong hash / constant-time compare), scope enforcement per service function, role-ceiling intersection (incl. downgraded role), path traversal attempts in `writeConfigDraft`/`readConfig`/`deleteConfig`.
- **Integration (MCP):** full cycle list → read → write draft → validate → publish under different scope sets; filtered `tools/list`; unlisted tool call rejected.
- **E2E:** create token in UI, connect with it, revoke, verify rejection; `mcp_path_secret` regenerate.

## Out of scope

- REST `/api/v1` (add later on top of `lib/services/` if needed)
- Host CRUD via MCP (`hosts:write`) — read-only for now
- OAuth / mTLS
