/**
 * Poke Scanner catalog + embedding search (from pokemon_app.db).
 * Embeddings are 512-d float32 vectors (2048 bytes per card).
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data", "poke-scanner");
const DEFAULT_DB = path.join(DATA_DIR, "pokemon_app.db");
const DESKTOP_DB = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Desktop",
  "Poke Scanner",
  "Container",
  "Documents",
  "assets",
  "database",
  "pokemon_app.db"
);

const EMB_DIM = 512;
const EMB_BYTES = EMB_DIM * 4;

let indexState = {
  ready: false,
  loading: null,
  error: null,
  dbPath: null,
  cards: [],
  embeddings: null
};

function resolveDbPath() {
  const candidates = [
    process.env.POKEMON_SCANNER_DB,
    DEFAULT_DB,
    DESKTOP_DB
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function cosineTopK(queryEmb, matrix, cards, k = 8) {
  const n = cards.length;
  const scores = new Array(n);
  let qNorm = 0;
  for (let d = 0; d < EMB_DIM; d++) qNorm += queryEmb[d] * queryEmb[d];
  qNorm = Math.sqrt(qNorm) || 1;

  for (let i = 0; i < n; i++) {
    const base = i * EMB_DIM;
    let dot = 0;
    let vNorm = 0;
    for (let d = 0; d < EMB_DIM; d++) {
      const v = matrix[base + d];
      dot += queryEmb[d] * v;
      vNorm += v * v;
    }
    scores[i] = dot / (qNorm * (Math.sqrt(vNorm) || 1));
  }

  const order = scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return order.map(({ score, idx }) => ({
    score: Math.round(score * 1000) / 1000,
    card: cards[idx]
  }));
}

function formatCard(row) {
  const imageBase = String(row.image_url || "").trim();
  return {
    id: row.id,
    name: row.name,
    nameFr: row.name_fr || row.name,
    setId: row.set_id,
    setCode: String(row.set_abbreviation || row.set_id || "").toUpperCase(),
    setName: row.set_name || "",
    cardNumber: String(row.local_id || "").trim(),
    limitlessId: row.limitless_id || "",
    imageUrl: imageBase ? `${imageBase}/high.webp` : "",
    priceTcgplayer: row.price_trend_tcgplayer ?? null,
    priceCardmarket: row.price_trend_cardmarket ?? null,
    tcgplayerUrl: row.tcgplayer_url || "",
    cardmarketUrl: row.cardmarket_url || ""
  };
}

function toCollectionPayload(card, quantity = 1) {
  return {
    type: "single",
    name: card.name,
    setName: card.setName,
    cardNumber: card.cardNumber,
    setCode: card.setCode,
    setLanguage: "english",
    imageUrl: card.imageUrl,
    quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
    notes: card.id ? `Scanner: ${card.id}` : ""
  };
}

async function loadIndex() {
  if (indexState.ready) return indexState;
  if (indexState.loading) return indexState.loading;

  indexState.loading = (async () => {
    const dbPath = resolveDbPath();
    if (!dbPath) {
      indexState.error = "Poke Scanner database not found. Run: node backend/scripts/setup-poke-scanner-db.js";
      return indexState;
    }

    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT c.id, c.local_id, c.set_id, c.limitless_id, c.name, c.name_fr, c.image_url,
                  c.price_trend_cardmarket, c.price_trend_tcgplayer, c.tcgplayer_url, c.cardmarket_url,
                  c.embedding, s.abbreviation AS set_abbreviation, s.name AS set_name
           FROM cards c
           LEFT JOIN sets s ON s.id = c.set_id
           WHERE c.embedding IS NOT NULL AND length(c.embedding) = ?`
        )
        .all(EMB_BYTES);

      const cards = [];
      const matrix = new Float32Array(rows.length * EMB_DIM);
      let writeAt = 0;
      for (const row of rows) {
        const buf = Buffer.from(row.embedding);
        if (buf.length !== EMB_BYTES) continue;
        const emb = new Float32Array(buf.buffer, buf.byteOffset, EMB_DIM);
        matrix.set(emb, writeAt);
        writeAt += EMB_DIM;
        cards.push(formatCard(row));
      }

      indexState.dbPath = dbPath;
      indexState.cards = cards;
      indexState.embeddings = matrix;
      indexState.ready = cards.length > 0;
      indexState.error = indexState.ready ? null : "No card embeddings in database";
    } catch (err) {
      indexState.error = err.message || "Failed to load scanner database";
    }
    return indexState;
  })();

  await indexState.loading;
  indexState.loading = null;
  return indexState;
}

async function getStatus() {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    return {
      ok: false,
      available: false,
      message: "Copy pokemon_app.db with: node backend/scripts/setup-poke-scanner-db.js"
    };
  }
  const loaded = await loadIndex();
  return {
    ok: loaded.ready,
    available: loaded.ready,
    cardCount: loaded.cards.length,
    dbPath: loaded.dbPath,
    message: loaded.error || (loaded.ready ? "Scanner index ready" : "Loading failed")
  };
}

async function searchByEmbedding(embedding, limit = 8) {
  const loaded = await loadIndex();
  if (!loaded.ready) {
    return { ok: false, error: loaded.error || "Scanner not available", matches: [] };
  }
  if (!Array.isArray(embedding) || embedding.length !== EMB_DIM) {
    return { ok: false, error: `Expected embedding array of length ${EMB_DIM}`, matches: [] };
  }
  const query = Float32Array.from(embedding, (x) => Number(x) || 0);
  const matches = cosineTopK(query, loaded.embeddings, loaded.cards, limit).map((m) => ({
    ...m.card,
    confidence: m.score
  }));
  return { ok: true, matches };
}

async function searchByText(query, limit = 24) {
  const loaded = await loadIndex();
  if (!loaded.ready) {
    return { ok: false, error: loaded.error || "Scanner not available", matches: [] };
  }
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return { ok: true, matches: [] };

  const matches = loaded.cards
    .filter((c) => {
      const hay = `${c.name} ${c.setName} ${c.setCode} ${c.cardNumber} ${c.id}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit)
    .map((c) => ({ ...c, confidence: null }));

  return { ok: true, matches };
}

function parseEmbeddingBody(body) {
  if (Array.isArray(body.embedding)) return body.embedding;
  if (typeof body.embedding === "string") {
    try {
      const parsed = JSON.parse(body.embedding);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  if (body.embeddingB64) {
    const buf = Buffer.from(String(body.embeddingB64), "base64");
    if (buf.length === EMB_BYTES) {
      return Array.from(new Float32Array(buf.buffer, buf.byteOffset, EMB_DIM));
    }
  }
  return null;
}

module.exports = {
  EMB_DIM,
  resolveDbPath,
  loadIndex,
  getStatus,
  searchByEmbedding,
  searchByText,
  parseEmbeddingBody,
  toCollectionPayload,
  formatCard
};
