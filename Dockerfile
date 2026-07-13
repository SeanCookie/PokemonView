# Cloudflare Containers image (linux/amd64).
# Card art is served from R2 — never COPY backend/data/card-images into this image.
# cache-bust: 2026-07-13-collectr-playwright-chromium-v2
FROM node:20-bookworm-slim

WORKDIR /app

# System libraries for Playwright's Chromium (do NOT use Debian's /usr/bin/chromium wrapper —
# it crashes with "[: -lt: unexpected operator" under Playwright).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Keep Chromium downloads in the image; do not point at Debian chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

COPY package.json ./
COPY scripts/noop-build.js ./scripts/noop-build.js
COPY app.js ./

RUN npm install --omit=dev --no-audit --no-fund playwright-core@1.61.1 \
  && node node_modules/playwright-core/cli.js install chromium \
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
