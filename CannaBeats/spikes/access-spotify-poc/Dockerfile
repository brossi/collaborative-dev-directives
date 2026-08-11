FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node db.mjs cli.mjs onboarding.mjs observability.mjs server.mjs ./
COPY --chown=node:node operations ./operations
COPY --chown=node:node public ./public
COPY --chown=node:node private ./private
RUN mkdir -p /data /scratch /run/secrets/cannabeats && chown node:node /data /scratch

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
