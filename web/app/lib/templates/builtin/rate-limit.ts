export const template = `---
name: Rate Limiting
description: Rate limiting configuration to protect against abuse and DDoS
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
  - name: rate
    label: Requests per Second
    type: number
    default: 10
  - name: burst
    label: Burst Size
    type: number
    default: 20
  - name: limit_login
    label: Stricter Login Rate Limit
    type: boolean
    default: true
---
limit_req_zone $binary_remote_addr zone=general:10m rate={{rate}}r/s;
{{#limit_login}}
limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;
{{/limit_login}}

server {
    listen 80;
    server_name {{domain}};

    limit_req zone=general burst={{burst}} nodelay;
    limit_req_status 429;

    {{#limit_login}}
    location /login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    {{/limit_login}}

    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    error_page 429 /429.html;
    location = /429.html {
        internal;
        default_type text/html;
        return 429 '<html><body><h1>429 Too Many Requests</h1><p>Rate limit exceeded. Please try again later.</p></body></html>';
    }
}`;
