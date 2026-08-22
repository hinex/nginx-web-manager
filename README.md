# Nginx Manager

A full-featured Nginx reverse proxy management system with a modern web-based admin UI.

Similar to Nginx Proxy Manager, but rebuilt from scratch with a modern tech stack — React 19, Tailwind CSS 4, and Bun runtime.

## Features

- **Unified Hosts Management** — Manage proxy, static, redirect, and stream hosts from a single page with type selector, grouped views, color labels, and fuzzy search
- **HTTP/HTTPS Reverse Proxy** — Domain-based routing with path matching (prefix, exact, regex), and custom headers
- **Upstream Protocols** — Per-location backend protocol: `http`, `https`, `grpc`, `grpcs`, `fastcgi`
- **Dynamic DNS Resolution** — Optional nginx `resolver` for upstreams (re-resolves changing IPs, e.g. Docker's `127.0.0.11`)
- **SSL/TLS** — Let's Encrypt (ACME HTTP-01), custom certificates, force HTTPS, HSTS
- **Load Balancing** — Round robin, weighted, least connections, IP hash, random
- **Access Control** — IP allowlist/denylist (CIDR), Basic Auth, per-host or per-location rules with satisfy any/all logic
- **Static File Serving** — Serve static files with cache control and expiration headers
- **TCP/UDP Stream Proxying** — Forward arbitrary TCP/UDP traffic with load balancing
- **HTTP Redirections** — Configurable status codes (301/302/307/308), path preservation
- **Custom Error Pages** — Per-host, per-group, or global HTML error pages with cascading fallback
- **Health Checks** — Periodic upstream monitoring with webhook notifications
- **Config Validation** — `nginx -t` validation before every reload, preventing broken configs
- **Graceful Reload** — `nginx -s reload` for zero-downtime configuration changes
- **Config Version History** — Every generated config is snapshotted and can be reviewed
- **Config Templates** — Reusable nginx config templates
- **Cluster Sync** — Synchronize configuration across multiple nodes
- **Web Terminal** — In-browser terminal for container debugging
- **Audit Logging** — Tracks all configuration changes with user, action, and timestamp
- **Web Admin UI** — Full CRUD management for all resources, built with React and Tailwind CSS
- **Scoped API Tokens** — `ngm_…` bearer tokens with granular scopes (`configs:read/write`, `nginx:reload`, `hosts:write/publish`, …) capped by the owner's role; create/revoke from the Security page
- **REST API v1** — `/api/v1` endpoints for configs, hosts (draft CRUD + transactional publish with `nginx -t` rollback), nginx validate/reload, and stats — see [docs/api-v1.md](docs/api-v1.md)
- **MCP Server** — Model Context Protocol endpoint (`/api/mcp`) exposing scope-filtered tools for AI agents (Claude Code, etc.), with optional secret URL path
- **OAuth2 client_credentials** — Exchange an API token for a short-lived JWT at `/api/v1/oauth/token` (RFC 6749)
- **mTLS Enforcement** — Optional `require_mtls` gate for API/MCP clients via reverse-proxy client-certificate verification — see [docs/mtls.md](docs/mtls.md)

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
```

The admin UI will be available at [http://localhost:81](http://localhost:81).

Default credentials:

| Email | Password |
|-------|----------|
| `admin@example.com` | `changeme` |

### Docker Compose

```yaml
services:
  nginx-manager:
    image: hinex/nginx-web-manager:latest
    restart: unless-stopped
    ports:
      - '80:80'     # HTTP
      - '81:81'     # Admin UI
      - '443:443'   # HTTPS
    environment:
      # Required in production (min 16 chars each)
      - JWT_SECRET=change-me-to-a-long-random-string
      - ENCRYPTION_KEY=change-me-to-another-long-random-string
      # Optional
      # - ACME_EMAIL=admin@example.com
      # - WEBAUTHN_RP_ID=nginx.example.com
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

Generate strong secrets with:

```bash
openssl rand -base64 32
```

## Environment Variables

### Required in production

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for signing session JWT tokens. Min 16 characters. The app refuses to start in production without it. |
| `ENCRYPTION_KEY` | Key for AES-256-GCM encryption of secrets at rest (cluster API keys, etc.). Min 16 characters. Required in production. **Changing it makes previously encrypted data unreadable.** |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ACME_EMAIL` | — | Email used for Let's Encrypt account registration |
| `WEBAUTHN_RP_ID` | derived from request host | Relying Party ID (domain) for WebAuthn/passkeys, e.g. `nginx.example.com`. Set it when running behind a proxy or on a fixed domain |
| `WEBAUTHN_ORIGIN` | `https://$WEBAUTHN_RP_ID` | Expected WebAuthn origin, if it differs from the RP ID |
| `CLUSTER_API_KEY` | — | API key this node accepts for incoming cluster sync (`/api/cluster-receive`). Required only on cluster follower nodes |
| `NGINX_MANAGER_HOOK_KEY` | — | Auth key for the ACME DNS-01 webhook endpoint (`/api/acme-dns`) |
| `DB_PATH` | `/data/db.sqlite` | Path to the SQLite database |
| `NGINX_DIR` | `/data/nginx` | Root of the managed config tree: generated host configs (`conf.d/`), stream configs (`stream.d/`), basic-auth files (`auth/`), plus backups and imports. Read by both the generator and the config editor |
| `NGINX_CONF_DIR` | `/etc/nginx` | nginx's own config root (`nginx.conf`, `mime.types`). A separate directory — never regenerated by this app |
| `DATA_NGINX_DIR` | `/data/nginx` | **Deprecated** alias for `NGINX_DIR`, honoured only when `NGINX_DIR` is unset. Setting only this one used to point the generator and the editor at different directories |
| `TERMINAL_WS_PORT` | `3002` | Port of the internal terminal WebSocket server (set by the Docker image) |

Inside the official Docker image `NODE_ENV=production` and `TERMINAL_WS_PORT=3002` are already set — normally you only need to provide `JWT_SECRET` and `ENCRYPTION_KEY`.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Docker Container                   │
│                   (s6-overlay init)                   │
│                                                      │
│  ┌─────────────────────┐  ┌───────────────────────┐  │
│  │       Nginx          │  │    Web Admin (Bun)    │  │
│  │                      │  │   React Router + API  │  │
│  │                      │  │                       │  │
│  │  :80  HTTP           │  │  :3001 (internal)     │  │
│  │  :443 HTTPS          │  │                       │  │
│  │  :81  Admin ─────────┼──┤                       │  │
│  └──────────┬───────────┘  └───────────┬───────────┘  │
│             │                          │              │
│             │  ┌───────────────────┐   │              │
│             └──┤  Nginx Conf Files ├───┘              │
│                └────────┬──────────┘                  │
│                         │                             │
│                  ┌──────┴──────┐                      │
│                  │  SQLite DB  │                      │
│                  └─────────────┘                      │
└──────────────────────────────────────────────────────┘
```

**How it works:**

1. The **Web Admin** UI stores configuration in a SQLite database
2. On every change, it generates Nginx conf files, validates with `nginx -t`, and reloads with `nginx -s reload`
3. **Nginx** serves traffic using the generated configuration files in `/etc/nginx/conf.d/` and `/etc/nginx/stream.d/`
4. Port 81 is proxied by Nginx itself to the internal web admin on port 3001

## Ports

| Port | Purpose |
|------|---------|
| 80 | HTTP proxy |
| 443 | HTTPS proxy |
| 81 | Admin UI |

## Volumes

| Path | Purpose |
|------|---------|
| `/data` | SQLite database, logs, error pages |
| `/etc/letsencrypt` | Let's Encrypt certificates |

### Data Directory Structure

```
/data/
├── db.sqlite              # Application database
├── logs/                  # Nginx access/error logs (per-host)
│   ├── access.log
│   ├── error.log
│   ├── host-{id}_access.log
│   └── host-{id}_error.log
├── error-pages/           # Custom error page HTML files
│   ├── global/            # Global error pages (404.html, 500.html, etc.)
│   ├── group-{id}/        # Per-group error pages
│   └── host-{id}/         # Per-host error pages
├── default-page/          # Default page for unconfigured domains
│   └── index.html
├── ssl/custom/            # Custom SSL certificates
└── acme-challenge/        # ACME HTTP-01 challenge tokens
```

### Generated Nginx Config Structure

```
/etc/nginx/
└── nginx.conf             # Main config (auto-generated, includes from /data/nginx/)

/data/nginx/
├── conf.d/                # HTTP server blocks
│   ├── admin.conf         # Admin panel proxy (:81 -> :3001)
│   ├── default.conf       # Default catch-all server
│   └── host-{id}.conf     # Per-host server blocks
├── stream.d/              # TCP/UDP stream blocks
│   └── host-{id}-stream.conf
└── auth/                  # htpasswd files for access lists
    └── access-list-{id}.htpasswd
```

## Admin UI Pages

| Page | Description |
|------|-------------|
| **Dashboard** | Overview of all host types, groups, and upstream health |
| **Hosts** | Unified management of proxy, static, redirect, and stream hosts — with group/flat view toggle, color labels, and fuzzy search |
| **SSL Certificates** | Manage Let's Encrypt and custom certificates |
| **Access Lists** | IP-based and Basic Auth access control rules |
| **Error Pages** | Upload custom HTML error pages |
| **Config Editor** | Review generated nginx configs and version history |
| **Config Templates** | Manage reusable nginx config templates |
| **DNS Management** | Configure the DNS resolver for dynamic upstreams |
| **Cluster** | Synchronize configuration across nodes |
| **Terminal** | In-browser terminal for container debugging |
| **Security** | API tokens (create/revoke, scopes), MCP endpoint management, IP whitelist, mTLS toggle |
| **Default Page** | Edit the page shown for unconfigured domains |
| **Logs** | View per-host access and error logs |
| **Audit Log** | Track configuration changes |
| **Users** | Manage admin accounts (admin, editor, viewer roles) |
| **Settings** | Global settings and webhook configuration |

## Configuration

All configuration is managed through the admin UI. The web application generates Nginx configuration files that are validated with `nginx -t` before reloading.

### Generated Nginx Config Example

A proxy host generates an Nginx server block like:

```nginx
# Host: example.com, www.example.com (ID: 1)
# Auto-generated by Nginx Manager. Do not edit manually.

upstream host_1_loc_0 {
    server 192.168.1.10:8080 weight=1;
    server 192.168.1.11:8080 weight=1;
}

server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name example.com www.example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    if ($scheme = http) {
        return 301 https://$host$request_uri;
    }

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /.well-known/acme-challenge/ {
        alias /data/acme-challenge/;
    }

    location / {
        proxy_pass http://host_1_loc_0;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## SSL/TLS

### Let's Encrypt

1. Create a proxy host with one or more domains
2. Set SSL type to **Let's Encrypt**
3. The system will automatically:
   - Serve ACME HTTP-01 challenges via `/.well-known/acme-challenge/`
   - Obtain and store certificates in `/etc/letsencrypt/live/{domain}/`
   - Enable HTTPS on the proxy host

**Requirements:** Port 80 must be publicly accessible for HTTP-01 validation.

### Custom Certificates

1. Upload certificate and key files via the admin UI
2. Files are stored in `/data/ssl/custom/`
3. Set SSL type to **Custom** and the paths will be configured automatically

## Load Balancing

| Method | Description |
|--------|-------------|
| `round_robin` | Distribute requests evenly across upstreams |
| `weighted` | Distribute based on upstream weight values |
| `least_conn` | Send to the upstream with fewest active connections |
| `ip_hash` | Sticky sessions based on client IP |
| `random` | Random upstream selection |

Load balancing is available for proxy locations and TCP/UDP streams.

## Access Control

Access lists can be attached to individual locations. Each list supports:

- **IP Rules** — Allow or deny by IP address or CIDR range (IPv4 and IPv6)
- **Basic Auth** — Username/password authentication (htpasswd)
- **Satisfy** — `any` (IP match OR auth) or `all` (IP match AND auth)

## Health Checks

The watchdog service periodically checks upstream servers and:

- Records response time and status (up/down)
- Sends webhook notifications when status changes
- Supports per-host, per-group, and global webhook URLs

## API & Integrations

Programmatic access is built on **scoped API tokens** (created on the Security page). A token's effective scopes are the intersection of its granted scopes and the ceiling of its owner's role (admin / editor / viewer).

| Surface | Endpoint | Notes |
|---------|----------|-------|
| REST API v1 | `/api/v1/*` | Configs, hosts draft CRUD + publish, nginx validate/reload, stats. Reference: [docs/api-v1.md](docs/api-v1.md) |
| MCP server | `/api/mcp[/:secret]` | Streamable-HTTP MCP endpoint for AI agents; tool list is filtered by token scopes; optional secret path segment |
| OAuth2 | `/api/v1/oauth/token` | `client_credentials` grant (RFC 6749): `client_id` = `ngm-<tokenId>`, `client_secret` = raw `ngm_…` token → 15-min JWT bearer |

All API surfaces share the same protections: Bearer auth, per-IP rate limiting, optional IP whitelist, and an optional **mTLS gate** ([docs/mtls.md](docs/mtls.md)). Revoking an API token immediately invalidates both the token itself and any JWTs obtained with it (liveness re-check on every request).

```bash
# REST example
curl -H "Authorization: Bearer ngm_…" http://localhost:81/api/v1/stats

# OAuth2 example
curl -X POST http://localhost:81/api/v1/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=ngm-3&client_secret=ngm_…"
```

## Development

### Prerequisites

- Bun 1.x

### Web Admin

```bash
cd web
bun install
bun run dev          # Development server
bun run build        # Production build
bun run test         # Run tests (vitest)
```

### Building the Docker Image

```bash
docker build -t hinex/nginx-web-manager .
```

### Releasing a New Version

```bash
./update_version.sh 1.0.0
git add web/package.json
git commit -m "chore: bump version to v1.0.0"
git tag v1.0.0
git push origin main --tags
```

The script updates `web/package.json` and validates the semver format.

## Tech Stack

### Web Admin
- [React](https://react.dev) 19 + [React Router](https://reactrouter.com) 7
- [Tailwind CSS](https://tailwindcss.com) 4
- [Drizzle ORM](https://orm.drizzle.team) + SQLite
- [Bun](https://bun.sh) runtime
- [Jose](https://github.com/panva/jose) — JWT authentication
- [Fuse.js](https://www.fusejs.io) — Client-side fuzzy search

### Proxy
- [Nginx](https://nginx.org) 1.30 (stable) — Battle-tested HTTP/stream proxy

### Infrastructure
- [s6-overlay](https://github.com/just-containers/s6-overlay) — Process supervisor
- Multi-stage Docker build (Bun + Nginx Debian)

## License

MIT
