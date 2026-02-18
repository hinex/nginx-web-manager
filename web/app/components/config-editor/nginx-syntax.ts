import { LanguageSupport, StreamLanguage } from "@codemirror/language";

const nginxLanguage = StreamLanguage.define({
  token(stream) {
    // Comments
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }

    // Strings (double-quoted)
    if (stream.match('"')) {
      while (!stream.eol()) {
        if (stream.next() === '"') break;
      }
      return "string";
    }
    // Strings (single-quoted)
    if (stream.match("'")) {
      while (!stream.eol()) {
        if (stream.next() === "'") break;
      }
      return "string";
    }

    // Variables ($foo)
    if (stream.match(/\$\w+/)) {
      return "variableName";
    }

    // Block braces
    if (stream.match("{") || stream.match("}")) {
      return "brace";
    }

    // Semicolons
    if (stream.match(";")) {
      return "punctuation";
    }

    // Numbers (with optional size suffix)
    if (stream.match(/\d+(\.\d+)?[kmgKMG]?\b/)) {
      return "number";
    }

    // Words
    if (stream.match(/[\w_]+/)) {
      const w = stream.current();

      // Block directives
      const blockKeywords = [
        "http", "server", "location", "upstream", "events", "stream",
        "map", "geo", "limit_req_zone", "limit_conn_zone", "if", "types",
      ];
      if (blockKeywords.includes(w)) return "keyword";

      // Common directives
      const directives = [
        "listen", "server_name", "root", "index", "proxy_pass",
        "ssl_certificate", "ssl_certificate_key", "ssl_protocols",
        "ssl_ciphers", "ssl_prefer_server_ciphers",
        "access_log", "error_log", "include", "worker_processes",
        "worker_connections", "sendfile", "keepalive_timeout",
        "gzip", "gzip_types", "gzip_vary", "gzip_proxied", "gzip_comp_level",
        "add_header", "proxy_set_header", "proxy_http_version",
        "return", "rewrite", "try_files", "alias", "expires",
        "client_max_body_size", "error_page", "default_type",
        "tcp_nopush", "tcp_nodelay", "server_names_hash_bucket_size",
        "proxy_redirect", "proxy_buffering", "proxy_buffer_size",
        "proxy_read_timeout", "proxy_connect_timeout", "proxy_send_timeout",
        "fastcgi_pass", "fastcgi_param", "uwsgi_pass",
        "allow", "deny", "satisfy", "auth_basic", "auth_basic_user_file",
        "stub_status", "log_format",
      ];
      if (directives.includes(w)) return "keyword";

      // Boolean-ish values
      if (w === "on" || w === "off") return "bool";

      return null;
    }

    stream.next();
    return null;
  },
});

export function nginx() {
  return new LanguageSupport(nginxLanguage);
}
