# mTLS — Mutual TLS Client Certificate Authentication

nginx-manager supports an optional app-level mTLS gate that enforces mutual TLS
by inspecting the `X-Client-Verify` header injected by an upstream nginx proxy.

> **This is defense-in-depth, not a replacement for API tokens.**
> API tokens are still required; mTLS is an additional layer.

---

## How It Works

1. nginx terminates TLS, verifies the client certificate against a trusted CA, and
   sets `X-Client-Verify` to `SUCCESS` (valid cert) or `FAILED` / `NONE` (no/bad cert).
2. When the `require_mtls` setting is enabled in nginx-manager, every API and MCP
   request must carry `X-Client-Verify: SUCCESS` or it is rejected with HTTP 401.
3. The check runs before any credential (bearer token / session) verification.

---

## MANDATORY: Strip / Overwrite the Header on Every Connection

**Without this, any client can forge `X-Client-Verify: SUCCESS` and bypass mTLS.**

In every nginx `server` block that proxies to nginx-manager, add the following
directive **before** any `proxy_pass`. This overwrites any client-supplied value
so nginx-manager only ever sees what nginx itself set:

```nginx
# Always overwrite — clients must never control this header
proxy_set_header X-Client-Verify "";
```

Then, in the specific `location` block that requires mTLS, override it with the
real value after nginx has done its certificate verification:

```nginx
location / {
    # nginx sets these after ssl_verify_client is processed
    proxy_set_header X-Client-Verify $ssl_client_verify;
    proxy_set_header X-Client-DN     $ssl_client_s_dn;
    proxy_pass http://127.0.0.1:3000;
}
```

---

## Full nginx vhost Example

```nginx
server {
    listen 443 ssl;
    server_name nginx-manager.example.com;

    ssl_certificate     /etc/ssl/server.crt;
    ssl_certificate_key /etc/ssl/server.key;

    # CA that signed client certificates
    ssl_client_certificate /etc/ssl/client-ca.crt;

    # Require a valid client certificate for every connection
    ssl_verify_client on;

    # MANDATORY: prevent header spoofing — strip any client-supplied value
    proxy_set_header X-Client-Verify "";

    location / {
        # Now set the real value from nginx's certificate verification result
        proxy_set_header X-Client-Verify $ssl_client_verify;
        proxy_set_header X-Client-DN     $ssl_client_s_dn;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_pass http://127.0.0.1:3000;
    }
}
```

If you have paths that should not require mTLS (e.g. a health check), use
`ssl_verify_client optional` at the server level and `ssl_verify_client on`
inside the specific location, or use a separate server block.

---

## Certificate Generation Quickstart

### 1. Create a CA

```bash
# Generate CA private key
openssl genrsa -out ca.key 4096

# Self-sign a CA certificate (10-year validity)
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/CN=nginx-manager-client-ca/O=Example/C=US"
```

### 2. Create a Client Certificate

```bash
# Generate client private key
openssl genrsa -out client.key 2048

# Create a certificate signing request
openssl req -new -key client.key -out client.csr \
  -subj "/CN=my-client/O=Example/C=US"

# Sign with the CA (1-year validity)
openssl x509 -req -days 365 -in client.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt
```

### 3. Configure nginx

Set `ssl_client_certificate /path/to/ca.crt` in nginx to the CA certificate
created above, then follow the vhost example in the previous section.

---

## Testing with curl

```bash
# With a valid client certificate — should return 200 (or the API response)
curl --cert client.crt --key client.key \
     -H "Authorization: Bearer ngm_yourtoken" \
     https://nginx-manager.example.com/api/mcp

# Without a client certificate — nginx rejects the TLS handshake itself
# (ssl_verify_client on) or nginx-manager returns 401 if ssl_verify_client optional
curl -H "Authorization: Bearer ngm_yourtoken" \
     https://nginx-manager.example.com/api/mcp
# → 401 {"error":"mTLS required","code":"mtls_required"}

# Testing locally against the app directly (bypasses nginx — useful for development)
# The flag is meaningless without a proxy that sets X-Client-Verify, so keep
# require_mtls disabled in local/dev environments.
curl -H "Authorization: Bearer ngm_yourtoken" \
     -H "X-Client-Verify: SUCCESS" \
     http://localhost:3000/api/mcp
# → NOTE: this simulates a trusted proxy; never allow direct connections on
#         production if require_mtls is enabled.
```

---

## Enabling in nginx-manager

1. Configure nginx as described above.
2. In the nginx-manager web UI, go to **Security** → **MCP Endpoint**.
3. Toggle **"Require mTLS (X-Client-Verify)"** on.
4. Verify access with `curl --cert / --key` before closing your session.

The setting can also be toggled via the API (admin only):

```bash
curl -X POST /api/tokens \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ngm_admintoken" \
     -d '{"action":"set_require_mtls","enabled":true}'
```
