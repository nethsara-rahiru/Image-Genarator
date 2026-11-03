# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb xauth xdotool openbox imagemagick x11-utils dbus-daemon ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --strict-ssl=true; else npm ci --omit=dev --strict-ssl=true; fi
COPY --chown=node:node app.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
RUN chmod -R a+rX /app
ENV HOME=/tmp BROWSER_CONTAINER=1 AUTO_OPEN=false CHROME_PATH=/usr/bin/chromium DATA_DIR=/data
ARG BROWSER_UID=1000
ARG BROWSER_GID=1000
RUN if ! getent group "$BROWSER_GID" >/dev/null; then groupadd -g "$BROWSER_GID" browser-host; fi && usermod -o -u "$BROWSER_UID" -g "$BROWSER_GID" node
USER node
EXPOSE 3030
CMD ["node", "app.js"]
