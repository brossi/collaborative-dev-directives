FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_CANNABEATS_BASE_PATH=/game
ARG NEXT_PUBLIC_SPOTIFY_CLIENT_ID
ENV NEXT_PUBLIC_CANNABEATS_BASE_PATH=${NEXT_PUBLIC_CANNABEATS_BASE_PATH}
ENV NEXT_PUBLIC_SPOTIFY_CLIENT_ID=${NEXT_PUBLIC_SPOTIFY_CLIENT_ID}
RUN npm run build:do

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN chown node:node /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
