FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY spikes/access-spotify-poc/package.json spikes/access-spotify-poc/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node spikes/access-spotify-poc/db.mjs spikes/access-spotify-poc/cli.mjs spikes/access-spotify-poc/onboarding.mjs spikes/access-spotify-poc/observability.mjs spikes/access-spotify-poc/server.mjs spikes/access-spotify-poc/state-client.mjs spikes/access-spotify-poc/state-operator-client.mjs ./
COPY --chown=node:node spikes/access-spotify-poc/operations ./operations
COPY --chown=node:node spikes/access-spotify-poc/public ./public
COPY --chown=node:node spikes/access-spotify-poc/private ./private
COPY --chown=node:node web/contracts/privacy-projection.json ./contracts/privacy-projection.json
RUN mkdir -p /data /scratch /run/secrets/cannabeats && chown node:node /data /scratch

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
