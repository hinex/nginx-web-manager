export const template = `---
name: Reverse Proxy
description: Basic reverse proxy forwarding requests to an upstream server
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
---
server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}`;
