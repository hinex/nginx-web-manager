export const template = `---
name: Single Page Application
description: SPA with client-side routing using try_files fallback to index.html
category: web
variables:
  - name: domain
    label: Domain Name
    type: string
    default: example.com
  - name: root_path
    label: Document Root
    type: string
    default: /var/www/app/dist
  - name: api_upstream
    label: API Upstream (host:port)
    type: string
    default: 127.0.0.1:3000
  - name: enable_api_proxy
    label: Enable API Proxy
    type: boolean
    default: true
---
server {
    listen 80;
    server_name {{domain}};
    root {{root_path}};
    index index.html;

    # Serve static assets with caching
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    {{#enable_api_proxy}}
    # Proxy API requests to the backend
    location /api/ {
        proxy_pass http://{{api_upstream}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    {{/enable_api_proxy}}

    # SPA fallback — all other routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}`;
