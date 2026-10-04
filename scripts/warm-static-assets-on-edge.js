#!/usr/bin/env node
/**
 * Hit production URLs so the Worker fills R2 (CDN for pokesymbols, origin for set-images).
 *
 *   node scripts/warm-static-assets-on-edge.js
 *   node scripts/warm-static-assets-on-edge.js --only pokesymbols
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE = String(process.env.APP_PUBLIC_URL || "https://pokemonview.com").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, Number(process.env.WARM_CONCURRENCY) || 12);

const ASSET_ROOTS = [
  { name: "pokesymbols", dir: path.join(ROOT, "backend", "data", "pokesymbols"), urlPrefix: "/pokesymbols" },
  { name: "set-images", dir: path.join(ROOT, "backend", "data", "set-images"), urlPrefix: "/set-images" }
];

const onlyFilter = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? String(process.argv[i + 1] || "").trim().toLowerCase() : "";
})();

async function walkImages(dir, urlPrefix, rel = "") {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkImages(abs, urlPrefix, relPath)));
    } else if (/\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name)) {
      out.push(`${urlPrefix}/${relPath.replace(/\\/g, "/")}`);
    }
  }
  return out;
}

async function runPool(items, worker, limit) {
  let index = 0;
  let ok = 0;
  let failed = 0;
  async function runWorker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) break;
      try {
        await worker(items[i]);
        ok += 1;
      } catch {
        failed += 1;
      }
      if ((ok + failed) % 50 === 0 || ok + failed === items.length) {
        console.log(`  progress ${ok + failed}/${items.length} (ok=${ok} fail=${failed})`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return { ok, failed };
}

async function main() {
  const roots = ASSET_ROOTS.filter((r) => !onlyFilter || r.name === onlyFilter);
  const paths = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    paths.push(...(await walkImages(root.dir, root.urlPrefix)));
  }
  console.log(`Warming ${paths.length} assets on ${BASE}…`);
  const { ok, failed } = await runPool(
    paths,
    async (urlPath) => {
      const res = await fetch(`${BASE}${urlPath}`, { method: "GET", redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
    },
    CONCURRENCY
  );
  console.log(`Done. ok=${ok} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
