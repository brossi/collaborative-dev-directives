FROM node:24-bookworm-slim AS dependencies
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app/web
COPY --from=dependencies /app/web/node_modules ./node_modules
COPY web/ ./
COPY catalog/ /app/catalog/
ARG NEXT_PUBLIC_CANNABEATS_BASE_PATH=/game
ARG NEXT_PUBLIC_SPOTIFY_CLIENT_ID
ENV NEXT_PUBLIC_CANNABEATS_BASE_PATH=${NEXT_PUBLIC_CANNABEATS_BASE_PATH}
ENV NEXT_PUBLIC_SPOTIFY_CLIENT_ID=${NEXT_PUBLIC_SPOTIFY_CLIENT_ID}
RUN npm run catalog:check && npm run build:do

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN chown node:node /app
COPY --from=build --chown=node:node /app/web/.next/standalone ./
COPY --from=build --chown=node:node /app/web/.next/static ./.next/static
COPY --from=build --chown=node:node /app/web/public ./public
COPY --from=build --chown=node:node /app/web/scripts/game-history.mjs ./game-history.mjs
USER node
EXPOSE 3000
CMD ["node", "server.js"]
