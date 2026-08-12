FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/web

COPY web/package.json ./package.json
COPY web/scripts/game-history.mjs ./scripts/game-history.mjs
COPY web/lib ./lib
COPY web/contracts ./contracts

USER node
ENTRYPOINT ["node", "scripts/game-history.mjs"]
CMD ["purge", "--retention-days", "90"]
