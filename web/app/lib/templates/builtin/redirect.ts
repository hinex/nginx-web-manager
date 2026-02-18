export const template = `---
name: Domain Redirect
description: Permanent 301 redirect from one domain to another
category: redirect
variables:
  - name: source_domain
    label: Source Domain
    type: string
    default: old.example.com
  - name: target_url
    label: Target URL
    type: string
    default: https://new.example.com
  - name: preserve_path
    label: Preserve Path
    type: boolean
    default: true
---
server {
    listen 80;
    server_name {{source_domain}};

    {{#preserve_path}}
    return 301 {{target_url}}$request_uri;
    {{/preserve_path}}
    {{^preserve_path}}
    return 301 {{target_url}};
    {{/preserve_path}}
}`;
