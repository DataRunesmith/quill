# Self-hosted copy: the Worker runs in wrangler's local runtime and keeps its
# data in /data. No Cloudflare account is needed.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
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
