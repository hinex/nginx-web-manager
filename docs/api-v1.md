# REST API v1 Reference

Base path: `/api/v1`

All endpoints accept and return `application/json` unless noted otherwise.  
All error responses use the envelope `{"error": "<message>", "code": "<code>"}` and the appropriate HTTP status code.

---

## Authentication

Every `/api/v1` request (except `POST /api/v1/oauth/token`) must carry one of:

| Method | Header |
|---|---|
| Opaque API token | `Authorization: Bearer ngm_<token>` |
| OAuth2 JWT | `Authorization: Bearer <jwt>` (three-segment, `ey…` format) |

Session cookies (used by the web UI) also work for same-origin requests but are not recommended for automation.

### Authentication order (applied to every request)

1. **mTLS gate** — if `require_mtls` is enabled in settings, the request must carry `X-Client-Verify: SUCCESS` (set by the upstream nginx proxy). Failure returns `401 {"error":"mTLS required","code":"unauthorized"}` (the `requireAuth` wrapper on `/api/v1` routes collapses the inner `mtls_required` code). See [docs/mtls.md](mtls.md) for nginx configuration.
2. **IP whitelist** — if `ip_whitelist` is configured (comma-separated CIDRs/IPs), the client IP must match. Failure returns `401` with `code: "unauthorized"` (collapsed by the `requireAuth` wrapper).
3. **Rate limiting** — after N failed bearer attempts (default 10, configurable `max_login_attempts`) from an IP, that IP is locked out for 15 minutes (configurable `login_ban_duration_minutes`). On `/api/v1` routes this surfaces as `401` with `code: "unauthorized"` (collapsed by the `requireAuth` wrapper); the OAuth token endpoint is the exception and returns a genuine `429`.
4. **Bearer dispatch:**
   - `ngm_` prefix → opaque token verification (constant-time hash compare against DB).
   - `ey….….` (compact JWT) → OAuth2 JWT: signature verified, then liveness re-checked (token row not revoked/expired, user still exists). Effective scopes = `JWT.scp ∩ token.scopes ∩ role_ceiling`.
   - Anything else → `401`.

> The MCP path secret (`mcp_path_secret`) applies to `GET /api/mcp/:secret` only; it does not affect `/api/v1`.

### Scopes

Every API token is issued with an explicit scope list. Effective scopes are clamped to the token owner's **role ceiling**:

| Role | Ceiling |
|---|---|
| `viewer` | `configs:read`, `hosts:read`, `stats:read`, `nginx:validate` |
| `editor` | all of viewer + `configs:write`, `configs:publish`, `nginx:reload`, `hosts:write`, `hosts:publish` |
| `admin` | all scopes |

Available scopes:

| Scope | Description |
|---|---|
| `configs:read` | List and read nginx config files (including drafts) |
| `configs:write` | Write config changes as drafts (never live) |
| `configs:publish` | Publish drafts to live config and delete config files |
| `nginx:validate` | Run nginx -t |
| `nginx:reload` | Reload nginx |
| `hosts:read` | List proxy hosts |
| `hosts:write` | Create and edit hosts as drafts (never live) |
| `hosts:publish` | Publish host drafts to live nginx config and delete hosts |
| `stats:read` | Read system status and statistics |

If the authenticated token lacks the required scope, the response is:

```json
HTTP/1.1 403
{"error": "token lacks scope <scope>", "code": "forbidden_error"}
```

---

## OAuth2 `client_credentials` Flow

Use this to obtain a short-lived JWT (15 minutes) from an existing API token. This is useful for platforms that only support the OAuth2 `client_credentials` grant.

**Credentials:**
- `client_id` = `ngm-<api_tokens.id>` (e.g. `ngm-3`)
- `client_secret` = the raw `ngm_…` token

There is no new credential store — revoking the API token immediately revokes the OAuth client.

### POST /api/v1/oauth/token

- **Content-Type:** `application/x-www-form-urlencoded` (required; charset suffix like `;charset=UTF-8` is accepted)
- **Cache-Control / Pragma:** `no-store` / `no-cache` (always set in response, RFC 6749 §5.1)
- **Auth:** none required on the endpoint itself (credentials are in the form body)

**Form fields:**

| Field | Required | Description |
|---|---|---|
| `grant_type` | yes | must be `client_credentials` |
| `client_id` | yes | `ngm-<tokenId>` |
| `client_secret` | yes | raw `ngm_…` token |
| `scope` | no | space-separated subset of the token's effective scopes; defaults to full intersection |

**Successful response (200):**

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "hosts:read stats:read"
}
```

`expires_in` is always `900` (15 minutes). The JWT carries claims `sub` (userId), `tid` (api_tokens.id), `scp` (granted scopes), `typ: "oauth"`.

**OAuth error responses** (body has `{"error": "<code>"}`, no `code` field — RFC 6749 style):

| Code | Status | Meaning |
|---|---|---|
| `invalid_client` | 401 | bad `client_id` format, unknown token, revoked, expired, or id/secret mismatch |
| `unsupported_grant_type` | 400 | `grant_type` is not `client_credentials` |
| `invalid_scope` | 400 | requested scope not in token's effective scopes |
| `unsupported_media_type` | 415 | Content-Type is not `application/x-www-form-urlencoded` |
| `invalid_request` | 400 | body could not be parsed |
| `access_denied` | 401 | mTLS gate failed |
| `access_denied` | 403 | IP whitelist check failed |
| `too_many_requests` | 429 | rate limit exceeded |
| `method_not_allowed` | 405 | non-POST request |

> **Note:** When `require_mtls` is enabled, the mTLS failure is re-wrapped as `access_denied` (RFC 6749 style). The `code: "mtls_required"` field present on other endpoints is not emitted here.

**curl example — fetch a JWT:**

```bash
curl -s -X POST https://nginx-manager.example.com/api/v1/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=ngm-3" \
  --data-urlencode "client_secret=ngm_yourrawtoken" \
  --data-urlencode "scope=hosts:read hosts:write hosts:publish"
```

Response:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "hosts:read hosts:write hosts:publish"
}
```

**Using the JWT:**
```bash
TOKEN=$(curl -s ... | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" https://nginx-manager.example.com/api/v1/hosts
```

---

## Error Envelope

All `/api/v1` routes (except the OAuth endpoint, which uses RFC 6749 format) return errors as:

```json
{"error": "<human-readable message>", "code": "<machine-readable code>"}
```

Status code table:

| HTTP | `code` | Trigger |
|---|---|---|
| 400 | `bad_request` | missing required query param or invalid `id` format |
| 400 | `parse_error` | malformed JSON body |
| 400 | `input_validation_error` | unknown field, invalid domain, bad array type |
| 400 | `invalid_path_error` | config file path outside the nginx directory or wrong extension |
| 401 | `unauthorized` | missing/invalid bearer token or session; also mTLS gate failure (`error: "mTLS required"`), IP whitelist mismatch, and rate-limit lockout — all collapsed to this code by the `requireAuth` wrapper on `/api/v1` routes |
| 403 | `forbidden_error` | token lacks required scope |
| 404 | `not_found_error` | host / config file not found |
| 405 | `method_not_allowed` | wrong HTTP method (response includes `Allow` header) |
| 422 | `host_validation_error` | host publish failed semantic validation or nginx -t |
| 500 | `internal_error` | unhandled server error |

---

## Routes

### Configs

#### GET /api/v1/configs

List all `.conf` files and `.conf.draft` files under the nginx directory.

- **Scope:** `configs:read`
- **Response 200:**

```json
{
  "files": ["/data/nginx/http.d/example.com.conf"],
  "drafts": ["/data/nginx/http.d/example.com.conf.draft"]
}
```

---

#### GET /api/v1/configs/file?path=

Read the content of a single config or draft file.

- **Scope:** `configs:read`
- **Query param:** `path` (required) — path relative to `NGINX_DIR`, must end with `.conf` or `.conf.draft`
- **Response 200:**

```json
{"content": "server {\n    listen 80;\n    ...\n}"}
```

- **Errors:** `400 bad_request` (missing `path`), `400 invalid_path_error` (path outside nginx dir / wrong extension), `404 not_found_error`

---

#### PUT /api/v1/configs/file?path=

Write content as a draft (`.conf.draft`). Validates the content against `nginx -t` (temporarily swapping it in); reports validity without applying. The live config is never touched.

- **Scope:** `configs:write`
- **Query param:** `path` (required) — must point to a `.conf` file (not a draft)
- **Request body:**

```json
{"content": "server {\n    listen 80;\n    server_name example.com;\n}", "message": "optional audit message"}
```

`message` is optional (logged to version history).

- **Response 200:**

```json
{"draftPath": "/data/nginx/http.d/example.com.conf.draft", "valid": true}
```

If the draft is syntactically invalid:

```json
{"draftPath": "/data/nginx/http.d/example.com.conf.draft", "valid": false, "error": "nginx: [emerg] ..."}
```

The draft is always written regardless of validity.

---

#### POST /api/v1/configs/publish?path=

Promote the `.conf.draft` to live. Runs `nginx -t`; if invalid, restores the previous live content and returns `published: false`. On success, reloads nginx.

- **Scope:** `configs:publish`
- **Query param:** `path` (required) — path to the `.conf` file (not the draft)
- **Request body:** none
- **Response 200 (success):**

```json
{"published": true, "valid": true}
```

- **Response 200 (validation failure — no live change made):**

```json
{"published": false, "valid": false, "error": "nginx: [emerg] ..."}
```

- **Errors:** `400 bad_request` (missing `path`), `404 not_found_error` (no draft exists)

---

#### DELETE /api/v1/configs/file?path=

Delete a config or draft file. Saves a version snapshot before deletion. Reloads nginx if the resulting config is valid.

- **Scope:** `configs:publish`
- **Query param:** `path` (required) — may point to a `.conf` or `.conf.draft` file
- **Request body:** none
- **Response 200:**

```json
{"deleted": true}
```

---

### Hosts

Hosts use a **draft model**: `hosts:write` operations only mutate the `draft` JSON column; no nginx config is generated until `hosts:publish` is called. This mirrors the web UI's save-draft / publish flow.

The `draft` field in the host object contains the pending changes (same schema as the live fields). When `draft` is non-null, `POST /api/v1/hosts/:id/publish` applies it.

#### GET /api/v1/hosts

List all proxy hosts.

- **Scope:** `hosts:read`
- **Response 200:** array of host objects (see schema below)

---

#### GET /api/v1/hosts/:id

Get a single host by ID.

- **Scope:** `hosts:read`
- **Path param:** `id` — positive integer
- **Response 200:** host object

**Host object schema:**

```json
{
  "id": 1,
  "groupId": null,
  "domains": ["example.com", "www.example.com"],
  "enabled": false,
  "sslType": "none",
  "sslForceHttps": false,
  "sslCertPath": null,
  "sslKeyPath": null,
  "hsts": true,
  "http2": true,
  "compression": true,
  "redirectWww": false,
  "clientMaxBodySize": "1m",
  "locations": [],
  "basicAuth": null,
  "streamPorts": [],
  "webhookUrl": null,
  "advancedNginx": null,
  "draft": {
    "domains": ["example.com"],
    "locations": [
      {
        "path": "/",
        "matchType": "prefix",
        "type": "proxy",
        "upstreams": [{"server": "127.0.0.1", "port": 8080, "weight": 1}],
        "balanceMethod": "round_robin",
        "staticDir": "",
        "cacheExpires": "",
        "forwardScheme": "http",
        "forwardDomain": "",
        "forwardPath": "",
        "preservePath": true,
        "statusCode": 0,
        "headers": {},
        "accessListId": null
      }
    ]
  },
  "createdAt": "2026-07-13T12:00:00.000Z",
  "updatedAt": "2026-07-13T12:00:00.000Z"
}
```

- **Errors:** `400 bad_request` (non-integer id), `404 not_found_error`

---

#### POST /api/v1/hosts

Create a new host as a draft. The host is inserted with `enabled: false`, `locations: []`, and the full payload stored in the `draft` column. No nginx config is generated.

- **Scope:** `hosts:write`
- **Request body:** (all fields optional at creation; they become part of the draft)

```json
{
  "domains": ["example.com"],
  "groupId": null,
  "enabled": true,
  "sslType": "none",
  "sslForceHttps": false,
  "sslCertPath": null,
  "sslKeyPath": null,
  "hsts": true,
  "http2": true,
  "compression": true,
  "redirectWww": false,
  "clientMaxBodySize": "1m",
  "locations": [
    {
      "path": "/",
      "matchType": "prefix",
      "type": "proxy",
      "upstreams": [{"server": "127.0.0.1", "port": 8080, "weight": 1}],
      "balanceMethod": "round_robin",
      "staticDir": "",
      "cacheExpires": "",
      "forwardScheme": "http",
      "forwardDomain": "",
      "forwardPath": "",
      "preservePath": true,
      "statusCode": 0,
      "headers": {},
      "accessListId": null
    }
  ],
  "basicAuth": null,
  "streamPorts": [],
  "webhookUrl": null,
  "advancedNginx": null
}
```

> **Note:** `labelIds` is not accepted by the API (UI-only concept). Unknown fields are rejected with `400 input_validation_error`.

- **Response 201:** host object
- **Errors:** `400 parse_error`, `400 input_validation_error`

---

#### PATCH /api/v1/hosts/:id

Update host fields (stored as a draft, merged with any existing draft or live fields). Live nginx config is not touched.

- **Scope:** `hosts:write`
- **Path param:** `id` — positive integer
- **Request body:** partial host fields (any subset of the fields accepted by POST)
- **Response 200:** updated host object
- **Errors:** `400 bad_request`, `400 parse_error`, `400 input_validation_error`, `404 not_found_error`

---

#### DELETE /api/v1/hosts/:id/draft

Discard the pending draft for a host (sets `draft` to null). The host's live published configuration is not changed.

- **Scope:** `hosts:write`
- **Path param:** `id` — positive integer
- **Request body:** none
- **Response 200:** host object with `draft: null`
- **Errors:** `400 bad_request`, `404 not_found_error`

---

#### POST /api/v1/hosts/:id/publish

Apply the draft (or current live fields if no draft) to the live nginx configuration. Pipeline:

1. Load effective data (`draft ?? live fields`)
2. Semantic validation (domains required when HTTP locations exist; at least one location or stream port required; unique `matchType+path` pairs; proxy locations need at least one upstream with valid `server` and `port` 1–65535)
3. Snapshot current row
4. Write effective data to main columns, clear `draft`
5. `generateAllConfigs()` → `nginx -t`
6. If invalid: restore snapshot, regenerate, return `422 host_validation_error`
7. If valid: reload nginx, audit log, return host

- **Scope:** `hosts:publish`
- **Path param:** `id` — positive integer
- **Request body:** none
- **Response 200:** published host object
- **Errors:** `400 bad_request`, `404 not_found_error`, `422 host_validation_error` (semantic or nginx -t failure)

---

#### DELETE /api/v1/hosts/:id

Delete a host permanently. Validates that the resulting nginx config is still valid before proceeding; restores the row on failure.

- **Scope:** `hosts:publish`
- **Path param:** `id` — positive integer
- **Request body:** none
- **Response 200:**

```json
{"deleted": true}
```

- **Errors:** `400 bad_request`, `404 not_found_error`, `422 host_validation_error`

---

### Nginx

#### POST /api/v1/nginx/validate

Run `nginx -t` against the current live configuration.

- **Scope:** `nginx:validate`
- **Request body:** none
- **Response 200:**

```json
{"valid": true}
```

or on failure:

```json
{"valid": false, "error": "nginx: [emerg] unknown directive \"bork\" in /data/nginx/..."}
```

---

#### POST /api/v1/nginx/reload

Send a reload signal to nginx (equivalent to `nginx -s reload`).

- **Scope:** `nginx:reload`
- **Request body:** none
- **Response 200:**

```json
{"reloaded": true}
```

---

### Stats

#### GET /api/v1/stats

Return system statistics.

- **Scope:** `stats:read`
- **Response 200:**

```json
{
  "cpu": {"usage": 12.5, "cores": 4},
  "memory": {"used": 1073741824, "total": 8589934592},
  "disk": {"used": 5368709120, "total": 53687091200, "path": "/"},
  "load": [0.5, 0.3, 0.2],
  "uptime": 86400,
  "nginx": {
    "active": 3,
    "reading": 0,
    "writing": 1,
    "waiting": 2,
    "requests": 10000,
    "accepted": 10001,
    "handled": 10001
  },
  "network": {"bytesIn": 1024, "bytesOut": 512}
}
```

`nginx` is `null` if the nginx stub_status endpoint is not reachable. `network` is `null` on non-Linux hosts or if `/proc/net/dev` is unavailable. All byte/count values are numbers (integers).

---

## Walkthroughs

### Full draft → publish host walkthrough

```bash
BASE="https://nginx-manager.example.com"
TOKEN="ngm_yourtokenhere"

# 1. Create a host as a draft
HOST=$(curl -s -X POST "$BASE/api/v1/hosts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domains": ["app.example.com"],
    "locations": [
      {
        "path": "/",
        "matchType": "prefix",
        "type": "proxy",
        "upstreams": [{"server": "127.0.0.1", "port": 3000, "weight": 1}],
        "balanceMethod": "round_robin",
        "staticDir": "",
        "cacheExpires": "",
        "forwardScheme": "http",
        "forwardDomain": "",
        "forwardPath": "",
        "preservePath": true,
        "statusCode": 0,
        "headers": {},
        "accessListId": null
      }
    ],
    "enabled": true,
    "sslType": "none",
    "hsts": true,
    "http2": true,
    "compression": true
  }')
echo "$HOST" | jq .
HOST_ID=$(echo "$HOST" | jq -r .id)

# 2. Edit the draft (add a second domain)
curl -s -X PATCH "$BASE/api/v1/hosts/$HOST_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domains": ["app.example.com", "www.app.example.com"]}' | jq .

# 3. Validate the current nginx config (optional pre-check)
curl -s -X POST "$BASE/api/v1/nginx/validate" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 4. Publish the draft to live nginx config
curl -s -X POST "$BASE/api/v1/hosts/$HOST_ID/publish" \
  -H "Authorization: Bearer $TOKEN" | jq .

# The host is now live; nginx was reloaded automatically.

# (Optional) Delete the host
curl -s -X DELETE "$BASE/api/v1/hosts/$HOST_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### OAuth2 token fetch and use

```bash
BASE="https://nginx-manager.example.com"
# API token with id=3
CLIENT_ID="ngm-3"
CLIENT_SECRET="ngm_yourtokenhere"

# Fetch a 15-minute JWT scoped to hosts operations
RESPONSE=$(curl -s -X POST "$BASE/api/v1/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "scope=hosts:read hosts:write hosts:publish")

JWT=$(echo "$RESPONSE" | jq -r .access_token)
EXPIRES_IN=$(echo "$RESPONSE" | jq -r .expires_in)
echo "Token expires in ${EXPIRES_IN}s"

# Use the JWT as a standard Bearer token
curl -s "$BASE/api/v1/hosts" \
  -H "Authorization: Bearer $JWT" | jq .
```

---

## Deviations from Spec

The following discrepancies were found between `docs/specs/2026-07-13-rest-hosts-oauth-mtls-design.md` and the shipped code:

1. **`InputValidationError` maps to 400, not 422.** The spec's `toResponse` helper description mentions `ValidationFailedError→400/422`; the code maps `InputValidationError` (unknown fields, bad domain, wrong array types) to `400` and `HostValidationError` (semantic / nginx -t) to `422`. No `ValidationFailedError` class exists in code.
2. **OAuth error body lacks `code` field.** The spec notes RFC 6749 style errors; the code emits `{"error": "<code>"}` with no `code` field (unlike every other endpoint which emits both). This is intentional per the Task 8 review note: "oauth-token.tsx re-wraps mtls_required as OAuth access_denied — intentional."
3. **Spec route table lists `DELETE /api/v1/hosts/:id/draft` but the handler also responds to GET (returns 405).** The `loader` function in `hosts.$id.draft.ts` explicitly returns `methodNotAllowed(["DELETE"])` — this is the expected React Router behaviour and is not a functional discrepancy.
4. **Spec does not document `clientMaxBodySize` field.** The database schema and service layer include this field (default `"1m"`); it is accepted by `createHost`/`updateHost` and returned in host objects.
