#!/usr/bin/env node
/**
 * Split backend/data/set-card-details.json into per-set files for fast API reads.
 * Run during Docker build (see Dockerfile).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "backend", "data", "set-card-details.json");
const OUT_DIR = path.join(ROOT, "backend", "data", "set-card-details", "by-code");

function main() {
  if (!fs.existsSync(SRC)) {
    // eslint-disable-next-line no-console
    console.warn("[split-set-card-details] source missing, skipping");
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const byCode = parsed && parsed.byCode && typeof parsed.byCode === "object" ? parsed.byCode : {};
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let count = 0;
  for (const [code, entry] of Object.entries(byCode)) {
    const safe = String(code || "").trim().toUpperCase();
    if (!safe) continue;
    fs.writeFileSync(path.join(OUT_DIR, `${safe}.json`), JSON.stringify(entry));
    count += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`[split-set-card-details] wrote ${count} sets to ${OUT_DIR}`);
}

main();
