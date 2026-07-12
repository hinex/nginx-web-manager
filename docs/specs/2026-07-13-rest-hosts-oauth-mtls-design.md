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
- hosts:write — hosts **already have** a native draft mechanism (`hosts.draft` JSON column; UI `saveDraft` stores the pending form there, `publish` validates + applies + regenerates + reloads). The service layer mirrors that instead of inventing anything: draft saves go to the `draft` column (no filesystem/nginx effect), publish is a **transactional apply** — DB update + `generateAllConfigs()` + `nginx -t`; on failure, restore the previous row state and regenerate back. Invalid config never goes live.
- Scope symmetry with configs (parent design: "draft-only by default"): `hosts:write` = draft saves only; **`hosts:publish`** = publish/delete/direct apply.
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

**New scopes** `hosts:write` + `hosts:publish` in `ALL_SCOPES`; ceilings: editor+ (viewer stays read-only), admin all. Scope table addition:

| Scope | Grants |
|---|---|
| `hosts:write` | `create_host` (as draft), `update_host` (as draft), `discard_host_draft` |
| `hosts:publish` | `publish_host` (draft → live: validate + regenerate + `nginx -t` + reload), `delete_host` |

**Service layer** (`lib/services/hosts.ts`), mirroring the UI mechanics in `admin/hosts/{new,edit}.tsx`:

- `getHost(auth, id)` — `hosts:read`, includes `draft` payload. `listHosts` already ships.
- `createHost(auth, input)` — `hosts:write`. Like UI `new.tsx` draft path: inserts a row with `enabled: false`, `locations: []`, `domains: input.domains ?? []`, and the full payload in the `draft` column. No filesystem effect. Returns the row.
- `updateHost(auth, id, patch)` — `hosts:write`. Stores merged payload into `draft` column only (`draft: { ...currentEffective, ...patch }`), `updatedAt` bumped. Live fields untouched.
- `discardHostDraft(auth, id)` — `hosts:write`. Sets `draft: null` (UI parity: edit.tsx:75-78).
- `publishHost(auth, id)` — `hosts:publish`. Pipeline:
  1. Load row; effective data = `draft ?? current fields`; run the publish validation copied from `edit.tsx` (domains required when HTTP locations exist; ≥1 location or stream port; unique `matchType+path`; proxy locations need ≥1 upstream with server + port 1-65535).
  2. Snapshot current row.
  3. Write effective data to main columns, `draft: null`.
  4. `generateAllConfigs()` → `validateNginxConfig()`.
  5. Invalid → restore snapshot, `generateAllConfigs()` again, throw `HostValidationError` carrying `nginx -t` stderr. Nothing goes live.
  6. Valid → `reloadNginx()` (UI parity — publish reloads, same as `publishConfig`), `logAudit` (`entity: "host"`, action, `userId`, tokenId via `auditDetails` pattern), return row.
- `deleteHost(auth, id)` — `hosts:publish` (destructive-live, same tier as `delete_config`): snapshot, delete row, `removeHostConfig(id)` + `generateAllConfigs()` → `validateNginxConfig()`; invalid → restore + regenerate + throw; valid → reload + audit.
- Input validation before any write: `domains` string[] of valid hostnames, `locations`/`streamPorts` shape-checked against the schema types, unknown keys rejected. `basicAuth` passwords must arrive pre-hashed or via the UI — token callers get plaintext hashing through the same `hashBasicAuthPasswords` helper the routes use.

**MCP tools** (registered behind scopes like existing ones): `get_host`, `create_host`, `update_host`, `publish_host`, `discard_host_draft`, `delete_host`. `list_hosts` unchanged.

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
| `POST /api/v1/hosts` (draft) | `createHost` | `hosts:write` |
| `PATCH /api/v1/hosts/:id` (draft) | `updateHost` | `hosts:write` |
| `DELETE /api/v1/hosts/:id/draft` | `discardHostDraft` | `hosts:write` |
| `POST /api/v1/hosts/:id/publish` | `publishHost` | `hosts:publish` |
| `DELETE /api/v1/hosts/:id` | `deleteHost` | `hosts:publish` |
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
- A separate host-draft store (reuses the existing `hosts.draft` column and UI semantics)
- Public OpenAPI/Swagger generation (hand-written `docs/api-v1.md` for now)

## Testing

Per feature: unit tests at the service level (symlink escapes, host apply rollback, scope enforcement), route tests for /api/v1 (status codes, malformed bodies, bearer + session), OAuth token endpoint (happy path, bad secret, scope narrowing, expired JWT, revoked-token liveness), `require_mtls` gate. e2e: host CRUD through REST with a scoped token; OAuth exchange then authenticated call.
