# Cloudflare Containers image (linux/amd64).
# Card art is served from R2 — never COPY backend/data/card-images into this image.
# cache-bust: 2026-07-13-collectr-browser-oom-harden-v1
FROM node:20-bookworm-slim

WORKDIR /app

# Chromium is required for Collectr imports: their showcase API is WAF-blocked from plain Node fetch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_PATH=/usr/bin/chromium

COPY package.json ./
COPY scripts/noop-build.js ./scripts/noop-build.js
COPY app.js ./

# Only install the optional browser driver used by Collectr imports (skip wrangler/cloud tooling).
RUN npm install --omit=dev --no-audit --no-fund playwright-core@1.61.1 \
  && npm cache clean --force

# Backend code
COPY backend/server.js backend/poke-scanner.js backend/chase-resolve-local-images.js ./backend/
COPY backend/lib ./backend/lib
COPY backend/private ./backend/private

# Runtime data (catalogs, symbols, set covers — not card-images)
COPY backend/data/set-card-lists.json ./backend/data/
COPY backend/data/set-card-details.json ./backend/data/
COPY scripts/split-set-card-details.js ./scripts/
RUN node scripts/split-set-card-details.js
COPY backend/data/card-nicknames.json ./backend/data/
COPY backend/data/tcgplayer-card-overrides.json ./backend/data/
COPY backend/data/pricecharting-set-slugs.json ./backend/data/
COPY backend/data/restock-tracker.json ./backend/data/
COPY backend/data/restock-manual-items.json ./backend/data/
COPY backend/data/pokesymbols ./backend/data/pokesymbols
COPY backend/data/set-images ./backend/data/set-images
COPY backend/data/showcase-avatars/.gitkeep ./backend/data/showcase-avatars/
COPY backend/data/store.example.json ./backend/data/store.json

COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=8080
ENV DEFER_HEAVY_STARTUP=1
ENV SELF_HOSTED=1
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

EXPOSE 8080

# Absolute paths in case start({ env }) replaces PATH or cwd is not /app.
CMD ["/usr/local/bin/node", "/app/app.js"]
