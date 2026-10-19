FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@11.25.0

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.* ./
COPY src ./src
COPY public ./public
RUN pnpm run build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
RUN mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY server ./server
USER node
VOLUME ["/data"]
CMD ["node", "server/index.mjs"]
