FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3010
WORKDIR /app

COPY --chown=node:node state-service/package.json ./package.json
COPY --chown=node:node state-service/src ./src
COPY --chown=node:node state-service/scripts ./scripts
COPY --chown=node:node web/data/catalog.json ./data/catalog.json
ENV CANNABEATS_STATE_CATALOG_PATH=/app/data/catalog.json
RUN mkdir -p /state /run/secrets/cannabeats && chown node:node /state

USER node
EXPOSE 3010
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3010/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
