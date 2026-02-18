export const template = `---
name: Static Site
description: Serve static files from a directory with caching and gzip
category: web
variables:
  - name: domain
    label: Domain Name
    type: string
    default: example.com
  - name: root_path
    label: Document Root
    type: string
    default: /var/www/html
  - name: enable_gzip
    label: Enable Gzip
    type: boolean
    default: true
---
server {
    listen 80;
    server_name {{domain}};
    root {{root_path}};
    index index.html index.htm;

    {{#enable_gzip}}
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    {{/enable_gzip}}

    location / {
        try_files $uri $uri/ =404;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    error_page 404 /404.html;
    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }
}`;
