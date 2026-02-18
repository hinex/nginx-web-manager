export const template = `---
name: SSL Reverse Proxy
description: Reverse proxy with HTTPS redirect and SSL termination
category: proxy
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
  - name: ssl
    label: Enable SSL
    type: boolean
    default: true
---
server {
    listen 80;
    server_name {{domain}};
    {{#ssl}}
    return 301 https://$host$request_uri;
    {{/ssl}}
    {{^ssl}}
    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    {{/ssl}}
}

{{#ssl}}
server {
    listen 443 ssl http2;
    server_name {{domain}};

    ssl_certificate /etc/letsencrypt/live/{{domain}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{domain}}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
{{/ssl}}`;
