#!/usr/bin/env node
/**
 * Import Sword & Shield Promos (SWSHP) card names + images from PkmnCards
 * into set-card-lists.json and backend/data/card-images/SWSHP/.
 *
 *   node scripts/import-swshp-promos.js
 *   node scripts/import-swshp-promos.js --skip-images
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parseSetCards } = require("../backend/lib/pkmncards-import-details");

const ROOT = path.resolve(__dirname, "..");
const LIST_FILE = path.join(ROOT, "backend", "data", "set-card-lists.json");
const IMAGE_DIR = path.join(ROOT, "backend", "data", "card-images", "SWSHP");
const SET_URL = "https://pkmncards.com/set/sword-shield-promos/";
const SKIP_IMAGES = process.argv.includes("--skip-images");
const DELAY_MS = 80;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    },
    redirect: "follow"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  return text;
}

async function downloadImage(url, filePath) {
  try {
    await fsp.access(filePath);
    return { ok: true, skipped: true };
  } catch {
    /* download */
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    },
    redirect: "follow"
  });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  await fsp.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return { ok: true, skipped: false };
}

async function main() {
  console.log(`Fetching ${SET_URL}…`);
  const html = await fetchHtml(SET_URL);
  const rows = parseSetCards(html);
  if (!rows.length) throw new Error("No cards parsed from PkmnCards set page");

  const cards = {};
  const localImages = {};
  const seen = new Set();
  for (const row of rows) {
    const cardNo = String(row.cardNo || "").trim().toUpperCase();
    if (!cardNo || seen.has(cardNo)) continue;
    seen.add(cardNo);
    cards[cardNo] = String(row.name || "").trim() || cardNo;
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  if (!SKIP_IMAGES) {
    await fsp.mkdir(IMAGE_DIR, { recursive: true });
    let i = 0;
    for (const row of rows) {
      i += 1;
      const cardNo = String(row.cardNo || "").trim().toUpperCase();
      if (!cardNo || !row.imageUrl) continue;
      const filePath = path.join(IMAGE_DIR, `${cardNo}.jpg`);
      const result = await downloadImage(row.imageUrl, filePath);
      if (result.ok) {
        localImages[cardNo] = `/card-images/SWSHP/${encodeURIComponent(cardNo)}.jpg`;
        if (result.skipped) skipped += 1;
        else downloaded += 1;
      } else {
        failed += 1;
        console.warn(`image fail ${cardNo}: ${result.error}`);
      }
      if (i % 25 === 0) console.log(`images ${i}/${rows.length}…`);
      await sleep(DELAY_MS);
    }
  }

  const data = JSON.parse(await fsp.readFile(LIST_FILE, "utf8"));
  if (!data.byCode || typeof data.byCode !== "object") data.byCode = {};
  data.byCode.SWSHP = {
    sourceHref: "/set/sword-shield-promos/",
    sourceTitle: "Sword & Shield Promos",
    totalCards: Object.keys(cards).length,
    cards,
    ...(Object.keys(localImages).length ? { localImages } : {})
  };
  await fsp.writeFile(LIST_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        cards: Object.keys(cards).length,
        downloaded,
        skippedExisting: skipped,
        imageFailed: failed,
        listFile: LIST_FILE,
        imageDir: IMAGE_DIR
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
