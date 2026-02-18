export const template = `---
name: Load Balancer
description: Round-robin load balancer distributing traffic across upstream servers
category: proxy
variables:
  - name: domain
    label: Domain Name
    type: string
    default: example.com
  - name: upstream_name
    label: Upstream Group Name
    type: string
    default: backend
  - name: server1
    label: Server 1 (host:port)
    type: string
    default: 127.0.0.1:3001
  - name: server2
    label: Server 2 (host:port)
    type: string
    default: 127.0.0.1:3002
  - name: server3
    label: Server 3 (host:port)
    type: string
    default: 127.0.0.1:3003
  - name: health_check
    label: Enable Health Check
    type: boolean
    default: true
---
upstream {{upstream_name}} {
    server {{server1}};
    server {{server2}};
    server {{server3}};
    keepalive 32;
}

server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://{{upstream_name}};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        {{#health_check}}
        proxy_next_upstream error timeout http_500 http_502 http_503;
        proxy_next_upstream_tries 3;
        proxy_next_upstream_timeout 10s;
        {{/health_check}}
    }
}`;
