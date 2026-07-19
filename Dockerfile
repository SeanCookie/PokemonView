# Cloudflare Containers image (linux/amd64).
# Card art is served from R2 — never COPY backend/data/card-images into this image.
# cache-bust: 2026-07-19-pc-details-gzip-sold-variants-v16
FROM node:20-bookworm-slim

WORKDIR /app

# System libraries for Playwright's Chromium (do NOT install Debian chromium —
# /usr/bin/chromium is a broken shell wrapper under Playwright).
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
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

COPY package.json ./
COPY scripts/noop-build.js ./scripts/noop-build.js
COPY app.js ./

RUN npm install --omit=dev --no-audit --no-fund playwright-core@1.61.1 \
  && node node_modules/playwright-core/cli.js install chromium \
  && CHROME_BIN="$(node -e "process.stdout.write(require('playwright-core').chromium.executablePath())")" \
  && test -n "$CHROME_BIN" \
  && test -x "$CHROME_BIN" \
  && ln -sf "$CHROME_BIN" /usr/local/bin/playwright-chromium \
  && echo "Playwright Chromium: $CHROME_BIN" \
  && npm cache clean --force

# Force the Playwright binary; never fall back to Debian /usr/bin/chromium.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/playwright-chromium
ENV CHROME_PATH=/usr/local/bin/playwright-chromium
ENV CHROMIUM_PATH=/usr/local/bin/playwright-chromium

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

CMD ["/usr/local/bin/node", "/app/app.js"]
