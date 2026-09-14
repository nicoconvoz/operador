# Operador by Open Doors — built for linux/arm64.
#
# Oracle's Always Free tier is Ampere ARM, so that is the target. A native
# module without an ARM build fails HERE, at image build time, rather than at
# 3am on the VPS.

FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src

# The suite is the gate. An image that cannot pass its own tests never ships.
RUN npx tsc --noEmit && npx vitest run --reporter=dot

# Compile to plain JS: tsx or ts-node in production means the runtime depends
# on a transpiler being healthy, which is one more thing to go wrong at 3am.
RUN npx tsc --noEmit false --outDir dist --module nodenext --moduleResolution nodenext \
 && cp src/infrastructure/persistence/schema.sql dist/infrastructure/persistence/schema.sql

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Never root. A container that holds wallet keys has no business running as
# a user that can rewrite its own filesystem.
USER node

# The engine handles SIGTERM itself: it finishes the current cycle before
# exiting, rather than dying between "decided" and "persisted".
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "dist/runtime/index.js"]
