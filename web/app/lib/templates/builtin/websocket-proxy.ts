export const template = `---
name: WebSocket Proxy
description: Proxy with WebSocket upgrade support for real-time applications
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
    default: 8080
  - name: ws_path
    label: WebSocket Path
    type: string
    default: /ws
---
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name {{domain}};

    location {{ws_path}} {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location / {
        proxy_pass http://{{upstream_host}}:{{upstream_port}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
