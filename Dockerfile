FROM oven/bun:1.3-alpine
# Laid out like a checkout: a deployment's own config can be mounted beside it (`/<deployment>/`)
# and reach the platform through `../opendeepl/src`, exactly as it does next to a clone.
WORKDIR /opendeepl
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/payload/package.json ./packages/payload/
COPY packages/sdk/package.json ./packages/sdk/
RUN bun install --frozen-lockfile --production

# No build step: Bun bundles the UI from src/ui/index.html at startup and serves it.
COPY bunfig.toml tsconfig.json translate.config.ts ./
COPY drizzle ./drizzle
COPY public ./public
COPY packages ./packages
COPY src ./src

EXPOSE 3000
CMD ["bun", "src/index.ts"]
