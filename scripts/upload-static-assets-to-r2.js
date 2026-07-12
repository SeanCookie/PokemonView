#!/usr/bin/env node
/**
 * Upload pokesymbols + set cover art to R2 (edge-cached like card images).
 *
 *   node scripts/upload-static-assets-to-r2.js
 *   node scripts/upload-static-assets-to-r2.js --dry-run
 *   node scripts/upload-static-assets-to-r2.js --only pokesymbols
 *   node scripts/upload-static-assets-to-r2.js --only set-images
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BUCKET = process.env.CARD_IMAGES_R2_BUCKET || "pokemonview-card-images";
const CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY) || 8);

const ASSET_ROOTS = [
  { name: "pokesymbols", dir: path.join(ROOT, "backend", "data", "pokesymbols"), keyPrefix: "pokesymbols" },
  { name: "set-images", dir: path.join(ROOT, "backend", "data", "set-images"), keyPrefix: "set-images" }
];

function wranglerJsPath() {
  const bin = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(bin)) {
    throw new Error("wrangler not installed — run: npm install");
  }
  return bin;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyFilter = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? String(args[i + 1] || "").trim().toLowerCase() : "";
})();

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif"
  };
  return map[ext] || "application/octet-stream";
}

async function walkImages(dir, keyPrefix, rel = "") {
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
      out.push(...(await walkImages(abs, keyPrefix, relPath)));
    } else if (/\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name)) {
      out.push({
        key: `${keyPrefix}/${relPath.replace(/\\/g, "/")}`,
        abs
      });
    }
  }
  return out;
}

function putObject(key, filePath) {
  return new Promise((resolve, reject) => {
    const objectPath = `${BUCKET}/${key}`;
    const child = spawn(
      process.execPath,
      [
        wranglerJsPath(),
        "r2",
        "object",
        "put",
        objectPath,
        "--file",
        filePath,
        "--content-type",
        contentType(filePath),
        "--remote"
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `wrangler exited ${code} for ${objectPath}`));
    });
  });
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
      const item = items[i];
      try {
        await worker(item);
        ok += 1;
        if (ok % 100 === 0) {
          // eslint-disable-next-line no-console
          console.log(`uploaded ${ok}/${items.length}…`);
        }
      } catch (err) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(`failed ${item.key}: ${err.message || err}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return { ok, failed };
}

async function main() {
  const roots = onlyFilter
    ? ASSET_ROOTS.filter((r) => r.name === onlyFilter)
    : ASSET_ROOTS;
  if (!roots.length) {
    throw new Error(`Unknown --only value. Use: ${ASSET_ROOTS.map((r) => r.name).join(", ")}`);
  }

  const items = [];
  for (const root of roots) {
    const found = await walkImages(root.dir, root.keyPrefix);
    // eslint-disable-next-line no-console
    console.log(`${root.name}: ${found.length} files`);
    items.push(...found);
  }

  if (!items.length) {
    // eslint-disable-next-line no-console
    console.log("Nothing to upload.");
    return;
  }

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[dry-run] would upload ${items.length} objects to ${BUCKET}`);
    for (const item of items.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.log(`  ${item.key}`);
    }
    if (items.length > 20) {
      // eslint-disable-next-line no-console
      console.log(`  … and ${items.length - 20} more`);
    }
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Uploading ${items.length} static assets to R2 bucket ${BUCKET}…`);
  const { ok, failed } = await runPool(items, (item) => putObject(item.key, item.abs), CONCURRENCY);
  // eslint-disable-next-line no-console
  console.log(`Done. ${ok} uploaded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message || err);
  process.exit(1);
});
