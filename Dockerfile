# Cloudflare Containers image (linux/amd64).
# Card art is served from R2 — never COPY backend/data/card-images into this image.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY scripts/noop-build.js ./scripts/noop-build.js
COPY app.js ./

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

COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=8080
ENV DEFER_HEAVY_STARTUP=1
ENV SELF_HOSTED=1

EXPOSE 8080

CMD ["node", "app.js"]
