# Self-hosted copy: the Worker runs in wrangler's local runtime and keeps its
# data in /data. No Cloudflare account is needed.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/app
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p /data && chown node:node /data /srv
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
