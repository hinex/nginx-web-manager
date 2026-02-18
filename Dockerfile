# ─── Stage 1: Build Web Admin ────────────────────────────
FROM oven/bun:1 AS build-web

WORKDIR /build
COPY web/package.json web/bun.lock* ./
RUN bun install

COPY web/ ./
RUN bun run build

# ─── Stage 2: Runtime ────────────────────────────────────
FROM nginx:1.27-bookworm

# Install runtime dependencies + s6-overlay prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    xz-utils \
    logrotate \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install s6-overlay
ARG S6_OVERLAY_VERSION=3.2.0.0
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") && \
    curl -fsSL -o /tmp/s6-overlay-noarch.tar.xz \
      https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz && \
    curl -fsSL -o /tmp/s6-overlay-arch.tar.xz \
      https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${ARCH}.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz

# Install Bun runtime
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Create data directories
RUN mkdir -p /data/logs /data/error-pages/global /data/default-page /data/ssl/custom \
    /data/acme-challenge /etc/letsencrypt /etc/nginx/conf.d /etc/nginx/stream.d /etc/nginx/auth

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy web admin
COPY --from=build-web /build/build /opt/nginx-manager/web/build
COPY --from=build-web /build/node_modules /opt/nginx-manager/web/node_modules
COPY --from=build-web /build/package.json /opt/nginx-manager/web/package.json
COPY --from=build-web /build/drizzle /opt/nginx-manager/web/drizzle
COPY --from=build-web /build/init-db.mjs /opt/nginx-manager/web/init-db.mjs

# Copy default pages
COPY defaults/default-page.html /data/default-page/index.html
COPY defaults/error-pages/ /data/error-pages/global/

# Copy logrotate config
COPY s6/logrotate.conf /etc/logrotate.d/nginx-manager

# Copy s6 service definitions
COPY s6/services /etc/s6-overlay/s6-rc.d
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/nginx && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/web

# Environment
ENV NODE_ENV=production \
    DB_PATH=/data/db.sqlite \
    PORT=3001 \
    TERMINAL_WS_PORT=3002

EXPOSE 80 81 443

VOLUME ["/data", "/etc/letsencrypt"]

ENTRYPOINT ["/init"]
