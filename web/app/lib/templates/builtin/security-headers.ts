export const template = `---
name: Security Headers
description: Security headers snippet for hardening any site with best-practice HTTP headers
category: security
variables:
  - name: domain
    label: Domain Name
    type: string
    default: example.com
  - name: upstream_host
    label: Upstream Host
    type: string
    default: 127.0.0.1
  - name: upstream_port
    label: Upstream Port
    type: number
    default: 3000
  - name: enable_hsts
    label: Enable HSTS
    type: boolean
    default: true
  - name: enable_csp
    label: Enable Content Security Policy
    type: boolean
    default: true
---
server {
    listen 80;
    server_name {{domain}};

    # Core security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    {{#enable_hsts}}
    # HSTS — force HTTPS for 1 year, include subdomains
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    {{/enable_hsts}}

    {{#enable_csp}}
    # Content Security Policy
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self';" always;
    {{/enable_csp}}

    # Hide nginx version
    server_tokens off;

    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
