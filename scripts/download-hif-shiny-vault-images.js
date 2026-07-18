#!/usr/bin/env node
/**
 * Link Hidden Fates Shiny Vault (SV1–SV94) art already present under
 * backend/data/card-images/HIF/ into set-card-lists.json / set-card-details.json.
 *
 *   node scripts/download-hif-shiny-vault-images.js
 *
 * Does not download from the network — place SV{n}.jpg files in the HIF folder first
 * (or re-upload from R2), then run this to refresh catalog localImages paths.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { writeJsonAtomic } = require("../backend/lib/write-json-atomic");
const { ensureHifShinyVaultInByCode, isShinyVaultCardKey } = require("../backend/lib/hif-shiny-vault");

const ROOT = path.resolve(__dirname, "..");
const LIST_FILE = path.join(ROOT, "backend", "data", "set-card-lists.json");
const DETAILS_FILE = path.join(ROOT, "backend", "data", "set-card-details.json");
const OUT_DIR = path.join(ROOT, "backend", "data", "card-images", "HIF");

function localUrlFor(cardNo) {
  return `/card-images/HIF/${encodeURIComponent(cardNo)}.jpg`;
}

async function main() {
  const parsed = JSON.parse(await fsp.readFile(LIST_FILE, "utf8"));
  const hif = parsed?.byCode?.HIF;
  if (!hif?.cards) throw new Error("Missing byCode.HIF in set-card-lists.json");

  const onDisk = new Set(
    (await fsp.readdir(OUT_DIR).catch(() => []))
      .filter((name) => /^SV\d+\.jpe?g$/i.test(name))
      .map((name) => name.replace(/\.jpe?g$/i, "").toUpperCase())
  );

  const svKeys = Object.keys(hif.cards).filter(isShinyVaultCardKey);
  const missing = svKeys.filter((k) => !onDisk.has(String(k).toUpperCase()));
  if (missing.length) {
    console.warn(
      `Missing ${missing.length} local files under ${path.relative(ROOT, OUT_DIR)}: ${missing
        .slice(0, 12)
        .join(", ")}${missing.length > 12 ? "…" : ""}`
    );
  }

  await ensureHifShinyVaultInByCode(parsed.byCode, { force: true });
  parsed.updatedAt = new Date().toISOString();
  await writeJsonAtomic(LIST_FILE, parsed);
  console.log(`Linked ${svKeys.length - missing.length}/${svKeys.length} SV localImages in set-card-lists.json`);

  try {
    const details = JSON.parse(await fsp.readFile(DETAILS_FILE, "utf8"));
    const det = details?.byCode?.HIF;
    if (det?.cards) {
      let patched = 0;
      for (const cardNo of svKeys) {
        if (!onDisk.has(String(cardNo).toUpperCase())) continue;
        const card = det.cards[cardNo];
        if (!card || typeof card !== "object") continue;
        const url = localUrlFor(cardNo);
        card.localImageUrl = url;
        card.imageUrl = url;
        if (card.source && /https?:\/\//i.test(String(card.source))) delete card.source;
        patched += 1;
      }
      details.updatedAt = new Date().toISOString();
      await writeJsonAtomic(DETAILS_FILE, details);
      console.log(`Patched set-card-details.json for ${patched} SV cards`);
    }
  } catch (err) {
    console.warn(`Could not patch set-card-details.json: ${err.message || err}`);
  }

  if (missing.length) process.exitCode = 1;
  else console.log("Done. Upload with: npm run upload:card-images -- --set HIF");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
