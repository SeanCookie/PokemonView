/**
 * Build a static illustrator index from set-card-details.json.
 * Writes:
 *   backend/data/catalog-illustrators.json       (artists + bySet)
 *   frontend/catalog-illustrators.json           (same)
 *   frontend/catalog-illustrator-names.json      (artists only — tiny JSON)
 *   frontend/catalog-illustrator-names.js        (embedded window global for instant dropdown)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DETAILS_FILE = path.join(ROOT, "backend", "data", "set-card-details.json");
const OUT_BACKEND = path.join(ROOT, "backend", "data", "catalog-illustrators.json");
const OUT_FRONTEND = path.join(ROOT, "frontend", "catalog-illustrators.json");
const OUT_NAMES = path.join(ROOT, "frontend", "catalog-illustrator-names.json");
const OUT_NAMES_JS = path.join(ROOT, "frontend", "catalog-illustrator-names.js");

function normalizeIllustratorName(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const code = parseInt(h, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
  s = s.replace(/&quot;/gi, '"').replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  s = s.replace(/\u201c/g, '"').replace(/\u201d/g, '"');
  s = s.replace(/\u2018/g, "'").replace(/\u2019/g, "'");
  return s.trim();
}

function main() {
  if (!fs.existsSync(DETAILS_FILE)) {
    console.error(`Missing ${DETAILS_FILE}`);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf8"));
  const byCode = parsed && parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
  const artists = new Set();
  const bySet = {};
  let cardCount = 0;

  for (const [code, entry] of Object.entries(byCode)) {
    const codeKey = String(code || "").trim().toUpperCase();
    if (!codeKey) continue;
    const cards = entry && entry.cards && typeof entry.cards === "object" ? entry.cards : {};
    const map = {};
    for (const [cardNo, card] of Object.entries(cards)) {
      const illustrator = normalizeIllustratorName(card && card.illustrator);
      if (!illustrator) continue;
      artists.add(illustrator);
      map[String(cardNo)] = illustrator;
      cardCount += 1;
    }
    if (Object.keys(map).length) bySet[codeKey] = map;
  }

  const artistList = [...artists].sort((a, b) => a.localeCompare(b));
  const generatedAt = new Date().toISOString();
  const payload = {
    ok: true,
    generatedAt,
    source: "set-card-details.json",
    setCount: Object.keys(bySet).length,
    cardCount,
    artists: artistList,
    bySet
  };
  const namesOnly = {
    ok: true,
    generatedAt,
    artists: artistList
  };

  fs.writeFileSync(OUT_BACKEND, `${JSON.stringify(payload)}\n`, "utf8");
  fs.writeFileSync(OUT_FRONTEND, `${JSON.stringify(payload)}\n`, "utf8");
  fs.writeFileSync(OUT_NAMES, `${JSON.stringify(namesOnly)}\n`, "utf8");
  fs.writeFileSync(
    OUT_NAMES_JS,
    `window.__POKEMONVIEW_CATALOG_ARTISTS__=${JSON.stringify(artistList)};\n`,
    "utf8"
  );
  console.log(
    `Wrote ${artistList.length} artists across ${payload.setCount} sets (${cardCount} cards)`
  );
  console.log(`  ${path.relative(ROOT, OUT_BACKEND)}`);
  console.log(`  ${path.relative(ROOT, OUT_FRONTEND)}`);
  console.log(`  ${path.relative(ROOT, OUT_NAMES)}`);
  console.log(`  ${path.relative(ROOT, OUT_NAMES_JS)}`);
}

main();
