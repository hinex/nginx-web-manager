# Design: REST /api/v1, hosts:write, OAuth2, mTLS + symlink hardening

**Date:** 2026-07-13
**Status:** Approved
**Parent:** `docs/specs/2026-07-11-mcp-api-tokens-design.md` (implemented, 11/11 tasks). This addendum covers everything that design deferred as out of scope.

## Problem

The token/MCP layer is done, but:

1. `resolveConfigPath` (`web/app/lib/services/configs.ts:27`) contains a path inside `NGINX_DIR` lexically but does not resolve symlinks — a symlink inside the nginx dir pointing outside lets `configs:read`/`configs:write` escape containment (flagged in Task 5 review, deferred).
2. Hosts are read-only for API consumers (`hosts:read` → `listHosts`). Agents cannot create/update/delete hosts — the main value of the product.
3. There is no REST API. Everything external goes through MCP JSON-RPC; scripts/CI/curl users have nothing.
4. Bearer `ngm_` tokens are the only external auth. No OAuth2 (for platforms that only speak `client_credentials`), no mTLS story.

## Decisions (user: "делай максимум")

- All four items, one plan.
- hosts:write — **not** a literal draft/publish layer. Host configs are *generated* from DB rows by `generateAllConfigs()`; a filesystem draft layer doesn't map onto that. Instead: **transactional apply** — DB change + regenerate + `nginx -t`; on failure, roll back the DB change and regenerate back. Same safety property as draft/publish (invalid config never goes live), no new state to manage.
- REST /api/v1 — full mirror of `lib/services/` (configs, hosts, nginx, stats). Token *management* stays session-only (existing `/api/tokens`), never exposed to bearer auth.
- OAuth2 — `client_credentials` grant only, implemented as a thin exchange on top of existing `api_tokens` (no new credential store).
- mTLS — terminated at the nginx edge (docs + generated snippet), with an optional app-level header check as defense-in-depth. No certificate handling in the app.

## 1. Symlink hardening (`resolveConfigPath`)

After the existing lexical containment check:

- If the resolved path exists → `fs.realpathSync(p)` must still start with `realpathSync(NGINX_DIR) + sep`.
- If it does not exist (new draft) → apply the same check to its nearest existing ancestor directory.
- Violation → the same `InvalidPathError` the lexical check throws (no info leak about link targets).

Covers `readConfig`, `writeConfigDraft`, `publishConfig`, `deleteConfig`, `listConfigs` (drafts enumeration) — they all funnel through `resolveConfigPath`.

Tests: symlink file → outside file; symlink dir inside nginx dir → outside dir; new draft under symlinked dir; legit file still works.

## 2. `hosts:write` — host CRUD via services + MCP

**New scope** `hosts:write` in `ALL_SCOPES`; ceilings: editor+ (viewer stays read-only), admin all. Scope table addition:

| Scope | Grants |
|---|---|
| `hosts:write` | `create_host`, `update_host`, `delete_host`, `set_host_enabled` |

**Service layer** (`lib/services/hosts.ts`):

- `getHost(auth, id)` — `hosts:read`.
- `createHost(auth, input)`, `updateHost(auth, id, patch)`, `deleteHost(auth, id)`, `setHostEnabled(auth, id, enabled)` — `hosts:write`.
- Input = subset of the `hosts` table columns: `domains` (non-empty string[], each a valid hostname), `groupId`, `enabled`, SSL block (`sslType`/`sslForceHttps`/`sslCertPath`/`sslKeyPath`/`hsts`/`http2`), `compression`, `redirectWww`, `clientMaxBodySize`, `locations`. Validation mirrors what `admin/hosts/new.tsx` enforces; reject unknown keys.
- **Apply pipeline** (shared helper, used by every mutator):
  1. Snapshot the current row (for update/delete).
  2. Apply DB change.
  3. `generateAllConfigs()` → `validateNginxConfig()`.
  4. Invalid → restore snapshot (or delete created row), `generateAllConfigs()` again, throw `ValidationFailedError` carrying `nginx -t` stderr. Nothing changed.
  5. Valid → `logAudit` (`entity: "host"`, action, `userId`, `tokenId` when via token), return the row + `{ reloadRequired: true }`.
- **No auto-reload.** Files on disk are updated and valid; making nginx serve them requires the separate `nginx:reload` scope (`reload_nginx` tool / `POST /api/v1/nginx/reload`). Consistent with configs:publish semantics already shipped… but note `publishConfig` DOES reload — mirror that precedent instead? **Decision:** keep parity with the UI host flow (`admin/hosts/edit.tsx` reloads after save): mutators accept `reload?: boolean` (default `false`); `reload: true` additionally requires `nginx:reload` scope and calls `reloadNginx()`. Explicit, capability-gated, no surprise.
- SSL cert/key paths in input: must pass the same realpath containment idea — reject paths outside allowed cert dirs? Existing UI accepts arbitrary paths (admin-trusted). For token callers, restrict `sslCertPath`/`sslKeyPath` to existing files; document that path policy matches UI otherwise (audit-logged).

**MCP tools** (registered behind scopes like existing ones): `get_host`, `create_host`, `update_host`, `delete_host` (+ `enabled` handled via `update_host`). `list_hosts` gains full row output (it already returns rows).

## 3. REST `/api/v1`

Thin controllers over `lib/services/` in `web/app/routes/api/v1/`. Every handler: `authenticate(request)` → service call → JSON. Service errors already map to HTTP (`ForbiddenError`→403, `NotFoundError`→404, `InvalidPathError`/`ValidationFailedError`→400/422) via a shared `toResponse(err)` helper.

| Method + path | Service | Scope |
|---|---|---|
| `GET /api/v1/configs` | `listConfigs` | `configs:read` |
| `GET /api/v1/configs/file?path=` | `readConfig` | `configs:read` |
| `PUT /api/v1/configs/file?path=` (body: `{content}`) | `writeConfigDraft` | `configs:write` |
| `POST /api/v1/configs/publish?path=` | `publishConfig` | `configs:publish` |
| `DELETE /api/v1/configs/file?path=` | `deleteConfig` | `configs:publish` |
| `GET /api/v1/hosts`, `GET /api/v1/hosts/:id` | `listHosts`/`getHost` | `hosts:read` |
| `POST /api/v1/hosts` | `createHost` | `hosts:write` |
| `PATCH /api/v1/hosts/:id`, `DELETE /api/v1/hosts/:id` | `updateHost`/`deleteHost` | `hosts:write` |
| `POST /api/v1/nginx/validate` | `validate` | `nginx:validate` |
| `POST /api/v1/nginx/reload` | `reload` | `nginx:reload` |
| `GET /api/v1/stats` | `getStats` | `stats:read` |

- File path via `?path=` query param (avoids nested-slash route encoding issues; matches service signature).
- Errors: `{ "error": string, "code": string }`, correct status; never HTML.
- Body parsing guarded (400 on malformed JSON) — same lesson as MCP `-32700`.
- Reference doc `docs/api-v1.md` generated by hand in the same task (routes, scopes, curl examples).
- The secret path prefix (`mcp_path_secret`) does **not** apply to /api/v1 — it's an MCP-URL feature; REST relies on Bearer + IP whitelist + rate limit (all already in `authenticate`).

## 4. OAuth2 `client_credentials`

Purpose: clients that can only be configured with an OAuth token URL + client id/secret.

- **Client identity = existing API token.** `client_id` = `"ngm-" + api_tokens.id`, `client_secret` = the raw `ngm_…` token. No new tables, no new secret lifecycle — revoking the API token revokes the OAuth client.
- `POST /api/v1/oauth/token`, body `application/x-www-form-urlencoded` (per RFC 6749): `grant_type=client_credentials`, `client_id`, `client_secret`, optional `scope` (space-separated, must be ⊆ token scopes ∩ role ceiling; default = full intersection).
  - Verify secret via existing `verifyApiToken` (constant-time), check `client_id` matches the token row, apply the same rate-limit/IP-whitelist path as `authenticate`.
  - Response: `{ access_token, token_type: "Bearer", expires_in: 900, scope }`. Errors per RFC: `{error: "invalid_client" | "invalid_grant" | "invalid_scope"}`, 400/401.
- **Access token** = JWT via existing `jwt.server.ts`, 15 min TTL, claims: `sub` (userId), `tid` (api_tokens.id), `scp` (granted scopes), `typ: "oauth"`.
- `authenticate()` extension: Bearer values that are JWTs (`ey…`, 2 dots) → verify signature/expiry, then **re-check liveness**: token row not revoked/expired, user exists, `scp ∩ current role ceiling` = effective scopes. A revoked token dies within ≤15 min even if the JWT lives — acceptable and documented; liveness check makes it immediate.
- `ngm_` opaque tokens keep working unchanged; JWT path is additive.

## 5. mTLS (edge-terminated)

- **Primary:** documentation `docs/mtls.md` — nginx vhost snippet in front of nginx-manager: `ssl_client_certificate`, `ssl_verify_client on`, and `proxy_set_header X-Client-Verify $ssl_client_verify` / `X-Client-DN $ssl_client_s_dn`, plus stripping those headers from untrusted sources.
- **App-level defense-in-depth:** setting `require_mtls` (default off, Security page toggle next to the MCP card). When on, `authenticate()` rejects (401, before any credential check) requests whose `X-Client-Verify` header ≠ `SUCCESS`. This only makes sense behind the documented proxy — the docs and the toggle description both say so explicitly.
- mTLS **augments** token auth (transport layer), never replaces it. No app-side certificate parsing/pinning.

## Out of scope

- OAuth2 authorization_code / device flows, refresh tokens
- App-side certificate management (issuing, pinning, CRL)
- Draft/publish state machine for hosts (see Decisions — transactional apply instead)
- Public OpenAPI/Swagger generation (hand-written `docs/api-v1.md` for now)

## Testing

Per feature: unit tests at the service level (symlink escapes, host apply rollback, scope enforcement), route tests for /api/v1 (status codes, malformed bodies, bearer + session), OAuth token endpoint (happy path, bad secret, scope narrowing, expired JWT, revoked-token liveness), `require_mtls` gate. e2e: host CRUD through REST with a scoped token; OAuth exchange then authenticated call.
