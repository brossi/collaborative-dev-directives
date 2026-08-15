FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3020
WORKDIR /app/diagnostics-service

COPY --chown=node:node diagnostics-service/package.json ./package.json
COPY --chown=node:node diagnostics-service/src ./src
COPY --chown=node:node web/lib/s2e-e1-contract.mjs /app/web/lib/s2e-e1-contract.mjs
COPY --chown=node:node web/lib/s2e-e2-correlation.mjs /app/web/lib/s2e-e2-correlation.mjs
RUN mkdir -p /diagnostics /diagnostics-temp \
  && chown node:node /diagnostics /diagnostics-temp

USER node
EXPOSE 3020
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3020/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
