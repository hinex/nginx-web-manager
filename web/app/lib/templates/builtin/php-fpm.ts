export const template = `---
name: PHP-FPM
description: PHP application with FastCGI Process Manager support
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
  - name: php_socket
    label: PHP-FPM Socket
    type: string
    default: unix:/run/php/php-fpm.sock
  - name: enable_cache
    label: Enable FastCGI Cache
    type: boolean
    default: false
---
server {
    listen 80;
    server_name {{domain}};
    root {{root_path}};
    index index.php index.html index.htm;

    {{#enable_cache}}
    fastcgi_cache_path /tmp/nginx-cache levels=1:2 keys_zone=fcgi_cache:10m max_size=100m inactive=60m;
    fastcgi_cache_key "$scheme$request_method$host$request_uri";
    {{/enable_cache}}

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        fastcgi_split_path_info ^(.+\\.php)(/.+)$;
        fastcgi_pass {{php_socket}};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
        {{#enable_cache}}
        fastcgi_cache fcgi_cache;
        fastcgi_cache_valid 200 60m;
        fastcgi_cache_bypass $http_pragma;
        {{/enable_cache}}
    }

    location ~ /\\.ht {
        deny all;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 30d;
        log_not_found off;
    }
}`;
