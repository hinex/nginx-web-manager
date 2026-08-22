# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- Publishing or writing a managed `host-<id>.conf` / `host-<id>-stream.conf` through
  `PUT /api/v1/configs/file`, `publish_config` or `write_config` now requires the
  `hosts:publish` scope in addition to `configs:publish`. Such a write is reverse-synced into
  the host model, so it needs host rights; the `403` names the file and the host id rather than
  reporting a bare missing scope. Editing a hand-written `conf.d/*.conf` is unaffected.
- A hand edit that cannot be mapped back to a host field now returns `409` with a per-line
  refusal instead of succeeding and discarding the change. This affects edits inside a second
  `server` block, inside an `upstream` body, and unrecognised arguments on stream
  `listen` / `server` / balance directives — all of which previously reported success and
  wrote nothing.

### Fixed

- Custom response headers (`add_header`) on a location are now read back correctly when a config
  is hand-edited; previously the classifier read `proxy_set_header` instead, writing request
  headers into the response-header field and reverting the user's edit on the next save.
- Inserting a header next to an existing one no longer fabricates a second, unrelated edit.

## [1.1.1] - 2026-07-13

### Added

- App version badge in the admin sidebar (desktop and mobile), sourced from `package.json`.

### Changed

- **Optimistic page transitions** — navigating between admin pages now instantly swaps in a
  skeleton placeholder while the next page's data is loading, instead of freezing on the old page.
- Thin animated loading bar in the admin header during any in-flight navigation.
- Sidebar nav highlights the pending destination immediately on click and prefetches page data
  on hover (`prefetch="intent"`), making transitions noticeably faster.

## [1.1.0] - 2026-07-13

### Added

- **Scoped API tokens** — `ngm_…` bearer tokens (SHA-256 hashed at rest) with granular scopes
  (`configs:read/write/publish`, `nginx:validate/reload/status`, `hosts:read/write/publish`,
  `stats:read`, …), optional expiry, revocation, and last-used tracking. Effective scopes are
  capped by the owner's role ceiling (admin / editor / viewer).
- **Security page UI** — create/copy/revoke API tokens, per-scope checkboxes with role ceilings,
  expiry presets, MCP endpoint card (enable/disable, secret URL path, regenerate), mTLS toggle.
- **MCP server** (`/api/mcp[/:secret]`) — Streamable-HTTP Model Context Protocol endpoint for AI
  agents. Tool list and execution are filtered by token scopes; supports an optional secret path
  segment and audit-logged tool calls.
- **REST API v1** (`/api/v1`) — configs (read/write/validate/publish), hosts draft CRUD with
  transactional publish (`nginx -t` verification and automatic rollback on failure), nginx
  validate/reload/status, and system stats. Reference: `docs/api-v1.md`.
- **OAuth2 `client_credentials` grant** (`/api/v1/oauth/token`, RFC 6749) — exchange an API token
  (`client_id` = `ngm-<tokenId>`, `client_secret` = raw token) for a short-lived (15 min) JWT.
  JWTs are liveness-checked against the backing token on every request, so revoking a token
  immediately invalidates its JWTs.
- **mTLS enforcement** — optional `require_mtls` gate for API/MCP/OAuth surfaces via
  reverse-proxy client-certificate verification (`X-Client-Verify: SUCCESS`), with spoofing
  protection when disabled. Setup guide: `docs/mtls.md`.
- **Per-IP rate limiting** and optional IP whitelist on all API surfaces; failed-attempt
  recording and lockouts for token auth.
- **Audit logging** for token lifecycle, MCP tool calls, and API mutations.
- Documentation: `docs/api-v1.md`, `docs/mtls.md`, expanded README (features, API & Integrations).

### Changed

- Unified authentication middleware: session cookies, `ngm_…` bearer tokens, and OAuth JWTs are
  resolved through a single `authenticate()` path with consistent scope enforcement.
- API error responses normalized (JSON-RPC errors for MCP, structured `{ error, code }` bodies
  for REST, including `400` validation errors with machine-readable `code` field).
- Sensitive API responses now sent with `Cache-Control: no-store` and explicit
  `Content-Type: application/json; charset=utf-8`.

### Fixed

- Symlink hardening for nginx config reads/writes — path resolution rejects escapes outside the
  managed nginx directory.
- Host input validation returns `400` (was `500`) for malformed domains/upstreams.
- Draft/live host publish edge cases: restore-on-failure keeps drafts intact after a failed
  `nginx -t`.

### Security

- Raw API tokens are shown once at creation and never persisted in plaintext.
- MCP endpoint can be moved behind a random secret path segment; disabled by default until
  explicitly enabled from the Security page.

## [1.0.1] - previous release

- Maintenance fixes on top of 1.0.0 (see git history).

## [1.0.0] - initial stable release

- Nginx host/config management, terminal, audit log, users & roles, web admin UI.

[1.1.1]: https://github.com/hardskilled/nginx-manager/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/hardskilled/nginx-manager/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/hardskilled/nginx-manager/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hardskilled/nginx-manager/releases/tag/v1.0.0
